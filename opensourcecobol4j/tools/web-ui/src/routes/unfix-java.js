/**
 * Recovery endpoints paired with /api/fix-java:
 *
 *   GET  /api/fix-diff/:id/:fileId  → { before, after, hasBackup }
 *     Returns the pre-repair (.java.before-fix) source and the current
 *     Java side by side so the UI can render a diff. `hasBackup:false`
 *     indicates no fix has been applied yet.
 *
 *   POST /api/unfix-java/:id/:fileId → { ok, error? }
 *     Restores .java.before-fix → .java, deletes the backup (so a
 *     subsequent fix-then-unfix cycle works), re-scores accuracy, and
 *     flips the entry's status based on whether the restored code
 *     compiles. Removes the "Auto-repaired" penalty from the breakdown.
 *
 * Why both? The before-fix backup already exists on disk but there was
 * no way to read it back OR restore it. Users who got a bad AI repair
 * had to manually navigate to /tmp to recover the pre-fix state.
 *
 * mount(app, deps) where deps = { activeConversions, azureAgent }.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findEntry(conversion, fileId) {
    if (!conversion || !conversion.result || !conversion.result.report) return null;
    const norm = String(fileId).replace(/\\/g, '/');
    return (conversion.result.report.files || []).find(f => (f.path || '').replace(/\\/g, '/') === norm) || null;
}

function backupPathFor(entry) {
    return entry.java_path.replace(/\.java$/i, '.java.before-fix');
}

function mount(app, deps) {
    const { activeConversions, azureAgent } = deps;

    app.get('/api/fix-diff/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const entry = findEntry(conversion, req.params.fileId);
        if (!entry) return res.status(404).json({ error: 'File not in report' });
        if (!entry.java_path || !fs.existsSync(entry.java_path)) {
            return res.status(400).json({ error: 'No Java file exists for this entry' });
        }
        const bpath = backupPathFor(entry);
        if (!fs.existsSync(bpath)) {
            return res.json({ hasBackup: false });
        }
        try {
            const before = fs.readFileSync(bpath, 'utf-8');
            const after = fs.readFileSync(entry.java_path, 'utf-8');
            res.json({ hasBackup: true, before, after });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read fix artifacts: ' + err.message });
        }
    });

    app.post('/api/unfix-java/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const entry = findEntry(conversion, req.params.fileId);
        if (!entry) return res.status(404).json({ error: 'File not in report' });
        if (!entry.java_path) {
            return res.status(400).json({ error: 'No Java file exists for this entry' });
        }
        const bpath = backupPathFor(entry);
        if (!fs.existsSync(bpath)) {
            return res.status(400).json({ error: 'No backup to restore — has a fix been applied?' });
        }

        // Restore: copy backup → java_path, then delete backup. Deleting
        // the backup after restore is deliberate — the next Fix-with-AI
        // call creates a fresh backup from the (now-restored) pristine
        // original, so fix-then-unfix-then-fix works cleanly.
        let restoredCode;
        try {
            restoredCode = fs.readFileSync(bpath, 'utf-8');
            fs.writeFileSync(entry.java_path, restoredCode, 'utf-8');
            fs.unlinkSync(bpath);
        } catch (err) {
            return res.status(500).json({ error: 'Restore failed: ' + err.message });
        }

        // Remove the "Auto-repaired" penalty marker so the accuracy
        // breakdown stops misrepresenting the current state.
        if (entry.accuracyBreakdown && Array.isArray(entry.accuracyBreakdown.semanticPenalties)) {
            entry.accuracyBreakdown.semanticPenalties = entry.accuracyBreakdown.semanticPenalties
                .filter(p => p !== 'Auto-repaired by Fix Java agent');
        }

        // Re-score against the original COBOL + restored Java.
        try {
            const cobolSource = entry.source_path ? fs.readFileSync(entry.source_path, 'utf-8') : '';
            if (cobolSource) {
                const acc = azureAgent.analyzeConversionAccuracy(cobolSource, restoredCode);
                if (acc && typeof acc.accuracy === 'number') {
                    entry.conversionAccuracy = acc.accuracy;
                    entry.accuracyDetails = acc.details || [];
                    entry.accuracyBreakdown = {
                        cobolMetrics: acc.cobolMetrics,
                        javaMetrics: acc.javaMetrics,
                        semanticPenalties: acc.semanticPenalties || []
                    };
                }
            }
        } catch {}

        // Recompile the restored file so the entry's status reflects
        // reality — a repair that "fixed" a COMPILE_FAIL might have
        // shipped the success state; unfix should flip it back.
        let compileStatus = 'unknown';
        let compileError = null;
        try {
            const workDir = path.dirname(entry.java_path);
            try {
                execSync(`javac "${entry.java_path}"`, {
                    cwd: workDir, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
                });
                compileStatus = 'ok';
                entry.java_status = 'SUCCESS';
                entry.error = undefined;
            } catch (compileErr) {
                compileStatus = 'fail';
                compileError = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                entry.java_status = 'COMPILE_FAIL';
                entry.error = compileError;
            }
        } catch (outerErr) {
            compileError = outerErr.message;
        }

        res.json({
            ok: true,
            compileStatus,
            compileError,
            newJavaStatus: entry.java_status,
            newAccuracy: entry.conversionAccuracy
        });
    });
}

module.exports = { mount };
