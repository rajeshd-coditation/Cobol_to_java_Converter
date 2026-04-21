/**
 * POST /api/resume/:id — resume an interrupted conversion.
 *
 * Context: `saveCheckpoint` is now called after every wave, so a server
 * crash leaves a `status: 'running'` record on disk. On boot,
 * `loadCheckpoints` promotes those to `status: 'interrupted'`. This
 * endpoint kicks off a fresh conversion that picks up where that one
 * left off — same inputPath, same outputDir, prior terminal file states
 * seeded so the wave loop skips already-done files.
 *
 * In-flight Promises (HITL pending reviews) cannot be rehydrated, so any
 * files that were mid-review at crash time are re-queued for conversion.
 *
 * The original interrupted record stays in history with `resumedAs: <newId>`
 * wired in, so the UI can chain the two together.
 *
 * Body: { batchSize?: number }  — optional, otherwise original batchSize
 *                                 from interrupted run is reused.
 *
 * Returns: { conversionId, resumedFrom, remainingFiles }
 */

const GET_CONVERT_HANDLER = Symbol('convertAzureHandler');

function mount(app, deps) {
    const { activeConversions, convertAzureHandler, saveCheckpoint } = deps;

    app.post('/api/resume/:id', async (req, res) => {
        const prevId = req.params.id;
        const prev = activeConversions.get(prevId);
        if (!prev) return res.status(404).json({ error: 'Conversion not found' });
        if (prev.status !== 'interrupted' && !prev.resumable) {
            return res.status(400).json({
                error: `Conversion is '${prev.status}', not resumable`
            });
        }
        if (!prev.inputPath) {
            return res.status(400).json({
                error: 'Interrupted run has no inputPath on record — cannot resume'
            });
        }

        // Identify which COBOL files did NOT reach a terminal state.
        // These are what the resumed run needs to (re-)process.
        const fileStates = prev.fileStates || {};
        const terminal = new Set(['done', 'skipped', 'failed']);
        const remaining = Object.keys(fileStates).filter(k => !terminal.has(fileStates[k]));

        if (remaining.length === 0) {
            // Nothing left to do — flip the interrupted record to completed
            // (its wave loop was essentially finished, just missed the final
            // save) and return without starting a new run.
            prev.status = 'completed';
            prev.completedAt = Date.now();
            delete prev.resumable;
            saveCheckpoint(prevId);
            return res.json({
                conversionId: prevId,
                alreadyComplete: true,
                remainingFiles: 0
            });
        }

        // Build a fake req for convertAzureHandler. We pass selectedFiles as
        // the rel paths of remaining files, plus resumeState for state seed.
        const fakeReq = {
            body: {
                repoUrl: prev.inputPath,
                reviewMode: !!prev.reviewMode,
                reviewGlob: prev.reviewGlob || null,
                selectedFiles: remaining,
                batchSize: (req.body && req.body.batchSize) || prev.batchSize,
                resumedFrom: prevId,
                resumeState: {
                    outputDir: prev.outputDir,
                    fileStates: prev.fileStates,
                    reportFiles: (prev.result && prev.result.report && prev.result.report.files) || [],
                    siblingSignatures: prev.siblingSignatures || {},
                    fileTimeline: prev.fileTimeline || {},
                    reviewHistory: prev.reviewHistory || [],
                    resumedFrom: prevId
                }
            }
        };

        // Capture the response from convertAzureHandler — it JSON-replies
        // with { conversionId, outputDir, useAzureAI: true }. We re-emit
        // the same shape plus resumedFrom/remainingFiles for the UI.
        let captured = null;
        const fakeRes = {
            status(code) { this._statusCode = code; return this; },
            json(body) { captured = { body, code: this._statusCode || 200 }; return this; }
        };

        try {
            await convertAzureHandler(fakeReq, fakeRes);
        } catch (err) {
            return res.status(500).json({ error: err.message || String(err) });
        }

        if (!captured) {
            return res.status(500).json({ error: 'Resume handler produced no response' });
        }
        if (captured.code >= 400) {
            return res.status(captured.code).json(captured.body);
        }

        // Link the new conversion back to the interrupted one.
        const newId = captured.body.conversionId;
        prev.resumedAs = newId;
        delete prev.resumable;
        saveCheckpoint(prevId);

        res.json({
            conversionId: newId,
            resumedFrom: prevId,
            remainingFiles: remaining.length,
            outputDir: captured.body.outputDir
        });
    });
}

module.exports = { mount, GET_CONVERT_HANDLER };
