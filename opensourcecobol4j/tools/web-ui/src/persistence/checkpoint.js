/**
 * Conversion checkpointing — save/restore across server restarts.
 *
 * Writes a compact JSON-per-conversion file under $TMPDIR/cobol_converter_checkpoints/.
 * Serializes everything EXCEPT in-memory Promises (pendingReview resolvers),
 * so HITL-pause state is intentionally lost across restarts (can't rehydrate
 * a Promise anyway). Past completed conversions stay inspectable.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CHECKPOINT_DIR = path.join(os.tmpdir(), 'cobol_converter_checkpoints');
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

function checkpointPath(id) { return path.join(CHECKPOINT_DIR, `${id}.json`); }

/**
 * Persist a conversion (by id) to disk. Idempotent, safe to call on every
 * meaningful state transition.
 *
 * @param {Map} activeConversions - the in-memory registry
 * @param {string} id
 */
function saveCheckpoint(activeConversions, id) {
    const conv = activeConversions.get(id);
    if (!conv) return;
    if (conv.status === 'completed' && !conv.completedAt) conv.completedAt = Date.now();
    const safe = {
        status: conv.status,
        cancelled: conv.cancelled,
        logs: conv.logs,
        result: conv.result,
        useAzureAI: conv.useAzureAI,
        reviewMode: conv.reviewMode,
        reviewGlob: conv.reviewGlob,
        reviewHistory: conv.reviewHistory,
        tokens: conv.tokens,
        tokenBudget: conv.tokenBudget,
        batchSize: conv.batchSize,
        risks: conv.risks,
        postReview: conv.postReview,
        graph: conv.graph,
        fileStates: conv.fileStates,
        fileTimeline: conv.fileTimeline,    // per-file phase history (for the
                                            // slide-out panel — restored across
                                            // restarts so past conversions stay
                                            // inspectable).
        // Build-time context that /api/run + Fix-with-AI depend on after a
        // server restart. Previously lost on reboot — a rehydrated
        // conversion would then fail to stage input files (dataFileLookup)
        // into the cobc work dir, giving libcob `status = 35 (file does
        // not exist)` on every run even though the repo has the data.
        // Similar story for siblingSignatures (next-wave CALL hints) and
        // jclContext (failure-analyst repo awareness).
        dataFileLookup: conv.dataFileLookup,
        jclContext: conv.jclContext,
        siblingSignatures: conv.siblingSignatures,
        currentFiles: conv.currentFiles,
        inputPath: conv.inputPath,
        outputDir: conv.outputDir,
        // Resume state — populated at each wave boundary by the worker.
        // If present and status==='interrupted' on load, /api/resume can
        // restart the worker from the next wave without redoing finished files.
        completedLevelIdx: conv.completedLevelIdx,
        totalLevels: conv.totalLevels,
        levelPlan: conv.levelPlan,          // [[relPath,...], ...] frozen plan
        resumedFrom: conv.resumedFrom,
        startedAt: conv.startedAt,
        completedAt: conv.completedAt
    };
    try {
        fs.writeFileSync(checkpointPath(id), JSON.stringify(safe));
    } catch {}
}

/**
 * Rehydrate all completed conversions into the in-memory map.
 * In-flight conversions are skipped (their worker promises can't be restored).
 *
 * @param {Map} activeConversions
 * @returns {number} count restored
 */
function loadCheckpoints(activeConversions) {
    try {
        const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf-8'));
                const id = f.replace('.json', '');
                if (data.status === 'completed') {
                    data.pendingReview = {};
                    activeConversions.set(id, data);
                } else if (data.status === 'running') {
                    // A status of 'running' on disk means the server was
                    // killed/crashed mid-run. Promote to 'interrupted' so the
                    // UI can offer a Resume action. The in-flight Promise
                    // graph (pendingReview, worker closures) is gone; a
                    // resume spins up a fresh worker that skips already-done
                    // files.
                    data.status = 'interrupted';
                    data.resumable = true;
                    data.interruptedAt = Date.now();
                    data.pendingReview = {};
                    activeConversions.set(id, data);
                }
            } catch {}
        }
    } catch {}
    return activeConversions.size;
}

/**
 * Delete checkpoint files older than `maxAgeMs`. Called once at server
 * boot to keep `$TMPDIR/cobol_converter_checkpoints/` from growing
 * unbounded — covers §17.4.
 *
 * Age is measured from the conversion's `completedAt` (or `startedAt`
 * for orphans that never finished) rather than the file mtime, so we
 * don't evict old runs just because the filesystem touched them.
 *
 * @param {number} [maxAgeMs=7*24*3600_000]  default: 7 days
 * @returns {{ scanned: number, deleted: number }}
 */
function cleanupOldCheckpoints(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let scanned = 0, deleted = 0;
    let files = [];
    try { files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json')); }
    catch { return { scanned, deleted }; }

    for (const f of files) {
        scanned++;
        const full = path.join(CHECKPOINT_DIR, f);
        let when = 0;
        try {
            const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
            when = data.completedAt || data.startedAt || 0;
        } catch {
            // Unreadable file → use mtime so we still clean up corrupt stubs.
            try { when = fs.statSync(full).mtimeMs; } catch {}
        }
        if (when && (now - when) > maxAgeMs) {
            try { fs.unlinkSync(full); deleted++; } catch {}
        }
    }
    return { scanned, deleted };
}

module.exports = {
    CHECKPOINT_DIR,
    checkpointPath,
    saveCheckpoint,
    loadCheckpoints,
    cleanupOldCheckpoints
};
