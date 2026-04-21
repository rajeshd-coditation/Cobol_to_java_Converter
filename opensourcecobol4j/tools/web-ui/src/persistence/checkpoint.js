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
        risks: conv.risks,
        postReview: conv.postReview,
        graph: conv.graph,
        fileStates: conv.fileStates,
        fileTimeline: conv.fileTimeline,    // per-file phase history (for the
                                            // slide-out panel — restored across
                                            // restarts so past conversions stay
                                            // inspectable).
        currentFiles: conv.currentFiles,
        inputPath: conv.inputPath,
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
                }
            } catch {}
        }
    } catch {}
    return activeConversions.size;
}

module.exports = {
    CHECKPOINT_DIR,
    checkpointPath,
    saveCheckpoint,
    loadCheckpoints
};
