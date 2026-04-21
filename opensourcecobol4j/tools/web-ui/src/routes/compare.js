/**
 * Three comparison endpoints the UI uses to diff COBOL-native vs Java runs.
 *
 *   POST /api/compare-runs    — AI-backed structured verdict on two run outputs.
 *                               If conversionId + relativePath are passed, the
 *                               server pulls sources off disk itself so the
 *                               client doesn't re-send tens of KB.
 *   GET  /api/comparison      — raw text diff from a work dir's native_output,
 *                               java_output, and diff files.
 *   GET  /api/code-comparison — COBOL source vs generated Java. Also surfaces
 *                               the per-file status / reason / suggestion so
 *                               the modal can explain skips and failures.
 *
 * mount(app, deps) where deps = { activeConversions, azureAgent }.
 */

const fs = require('fs');
const path = require('path');

// Status → human explanation map. Lives here (rather than the frontend) so
// the server is the single source of truth — keeps the messaging consistent
// across API callers and HTML.
const REASON_MAP = {
    SUCCESS: { reason: 'Converted successfully.', suggestion: null },
    SKIPPED_COPYBOOK: {
        reason: 'This file is a COBOL copybook (shared data definition), not a standalone program.',
        suggestion: 'Copybooks are embedded into Java model classes when referenced by a converted program. No standalone Java file is produced.'
    },
    SKIPPED_NO_ID: {
        reason: 'No IDENTIFICATION DIVISION / PROGRAM-ID was found in this source.',
        suggestion: 'Confirm the file is a COBOL program (not JCL, copybook, or data). Fixed-format COBOL must have PROGRAM-ID within columns 8–72.'
    },
    SKIPPED_JCL: { reason: 'This is a JCL job, not COBOL source.', suggestion: 'JCL is not translated — schedule/trigger equivalents must be built separately in your Java runtime.' },
    SKIPPED_DATA: { reason: 'This is a data file, not COBOL source.', suggestion: null },
    SKIPPED_OTHER: { reason: 'Skipped — file type is not supported for conversion.', suggestion: null },
    SKIPPED_INCOMPLETE_SOURCE: {
        reason: 'Source looks truncated — no STOP RUN / END PROGRAM / GOBACK near the end, and the last statement has no terminating period.',
        suggestion: 'The file may have been cut off during download, upload, or export. Verify against the original and re-import. Running a conversion on a truncated source would produce Java that matches the AI\'s invented ending, not what the real program does.'
    },
    REJECTED_BY_REVIEW: { reason: 'Rejected during human review.', suggestion: 'Open the reviewer notes (history tab) to see why, then re-run or edit.' },
    CONVERT_FAIL: {
        reason: 'AI conversion step failed.',
        suggestion: 'Common causes: external CICS/DB2/VSAM calls the AI could not model, unusual COBOL dialect features, or transient model errors. See the error below and try re-running this single file.'
    },
    FAIL: {
        reason: 'Conversion pipeline error (outside the AI step).',
        suggestion: 'Usually a filesystem/compile issue — see the error below.'
    }
};

function mount(app, deps) {
    const { activeConversions, azureAgent } = deps;

    app.post('/api/compare-runs', async (req, res) => {
        try {
            const b = req.body || {};
            let cobolSource = typeof b.cobolSource === 'string' ? b.cobolSource : '';
            let javaCode    = typeof b.javaCode    === 'string' ? b.javaCode    : '';
            // Server-side lookup avoids the client re-uploading large source files
            // the server already has on disk.
            if ((!cobolSource || !javaCode) && b.conversionId && b.relativePath) {
                const conv = activeConversions.get(b.conversionId);
                const entry = conv && conv.result && conv.result.report &&
                    (conv.result.report.files || []).find(f => f.path === b.relativePath);
                if (entry) {
                    if (!cobolSource && entry.source_path) {
                        try { cobolSource = fs.readFileSync(entry.source_path, 'utf-8'); } catch {}
                    }
                    if (!javaCode && entry.java_path) {
                        try { javaCode = fs.readFileSync(entry.java_path, 'utf-8'); } catch {}
                    }
                }
            }
            const verdict = await azureAgent.compareRunOutputs({
                cobolOutput: String(b.cobolOutput || ''),
                javaOutput:  String(b.javaOutput  || ''),
                cobolError:  String(b.cobolError  || ''),
                javaError:   String(b.javaError   || ''),
                cobolExit:   b.cobolExit,
                javaExit:    b.javaExit,
                cobolTimedOut: !!b.cobolTimedOut,
                javaTimedOut:  !!b.javaTimedOut,
                fileName:    b.fileName || '',
                cobolSource: cobolSource || undefined,
                javaCode:    javaCode    || undefined
            });
            res.json(verdict);
        } catch (err) {
            res.status(500).json({
                verdict: 'unknown', severity: 'info',
                title: 'Comparison failed',
                reasons: [err.message || String(err)]
            });
        }
    });

    app.get('/api/comparison', (req, res) => {
        const workDir = req.query.workDir;
        if (!workDir || workDir === 'N/A') {
            return res.status(400).json({ error: 'Work directory not available' });
        }
        const result = {
            nativeOutput: null,
            javaOutput: null,
            diff: null,
            nativeExists: false,
            javaExists: false
        };

        const nativePath = path.join(workDir, 'native_output.txt');
        try {
            if (fs.existsSync(nativePath)) {
                result.nativeOutput = fs.readFileSync(nativePath, 'utf-8');
                result.nativeExists = true;
            }
        } catch (err) { console.error('Error reading native output:', err); }

        const javaPath = path.join(workDir, 'java_output.txt');
        try {
            if (fs.existsSync(javaPath)) {
                result.javaOutput = fs.readFileSync(javaPath, 'utf-8');
                result.javaExists = true;
            }
        } catch (err) { console.error('Error reading java output:', err); }

        const diffPath = path.join(workDir, 'diff.txt');
        try {
            if (fs.existsSync(diffPath)) {
                result.diff = fs.readFileSync(diffPath, 'utf-8');
            }
        } catch (err) { console.error('Error reading diff:', err); }

        res.json(result);
    });

    app.get('/api/code-comparison', (req, res) => {
        const { workDir, conversionId, relativePath } = req.query;
        const result = {
            javaCode: null,
            javaExists: false,
            javaStatus: null,
            reason: null,
            error: null,
            suggestion: null
        };

        // Look up per-file diagnostics from the report. If the caller didn't
        // pass conversionId (e.g. after a page reload), search newest → oldest
        // so we find the most-recent conversion that includes this file.
        if (relativePath) {
            const norm = String(relativePath).replace(/\\/g, '/');
            const candidateConvs = [];
            if (conversionId && activeConversions.has(conversionId)) {
                candidateConvs.push(activeConversions.get(conversionId));
            } else {
                const entries = [...activeConversions.entries()]
                    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
                for (const [, c] of entries) candidateConvs.push(c);
            }
            let entry = null;
            for (const conversion of candidateConvs) {
                const report = conversion && conversion.result && conversion.result.report;
                if (!report || !Array.isArray(report.files)) continue;
                entry = report.files.find(f => (f.path || '').replace(/\\/g, '/') === norm);
                if (entry) break;
            }
            if (entry) {
                result.javaStatus = entry.java_status || null;
                result.error = entry.error || null;
                result.accuracy = entry.conversionAccuracy != null ? entry.conversionAccuracy : null;
                result.accuracyBreakdown = entry.accuracyBreakdown || null;
                if (!result._resolvedWorkDir && entry.work_dir) result._resolvedWorkDir = entry.work_dir;
                if (entry.java_path && fs.existsSync(entry.java_path)) {
                    try {
                        result.javaCode = fs.readFileSync(entry.java_path, 'utf-8');
                        result.javaExists = true;
                    } catch {}
                }
                const mapped = REASON_MAP[result.javaStatus];
                if (mapped) { result.reason = mapped.reason; result.suggestion = mapped.suggestion; }
            }
        }

        // Legacy fallback: callers who only pass workDir get the first .java in it.
        const wd = workDir || result._resolvedWorkDir;
        if (!result.javaCode && wd && wd !== 'N/A') {
            try {
                if (fs.existsSync(wd)) {
                    const files = fs.readdirSync(wd);
                    const javaFile = files.find(f => f.endsWith('.java'));
                    if (javaFile) {
                        result.javaCode = fs.readFileSync(path.join(wd, javaFile), 'utf-8');
                        result.javaExists = true;
                    }
                }
            } catch (err) { console.error('Error reading java code:', err); }
        }

        delete result._resolvedWorkDir;
        res.json(result);
    });
}

module.exports = { mount };
