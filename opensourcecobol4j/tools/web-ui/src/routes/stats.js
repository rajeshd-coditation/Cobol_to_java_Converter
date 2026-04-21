/**
 * GET /api/stats — rollup telemetry across every conversion in memory.
 *
 * We already collect tokens, per-file accuracy, per-file status, and
 * startedAt/completedAt for every run; this endpoint stops that data from
 * being inspectable only one-conversion-at-a-time. Useful for:
 *   - sanity checks ("did yesterday's run regress avg accuracy?")
 *   - cost tracking ("how many tokens did I burn this week?")
 *   - fleet health ("what % of files are FAIL vs SUCCESS?")
 *
 * All math is done against the activeConversions Map. Running conversions
 * are excluded from aggregates (tokens/accuracy are still climbing) but
 * counted in `inFlight`. Disk checkpoints are NOT rehydrated here — if a
 * conversion isn't in the Map, it's either too old (evicted by §17.3) or
 * never loaded. Keeps the endpoint fast (no fs I/O).
 *
 * Response shape:
 *   {
 *     conversions: { total, completed, inFlight, cancelled },
 *     files: {
 *       total,
 *       byStatus: { SUCCESS, COMPILE_FAIL, CONVERT_FAIL, SKIPPED_*, ... },
 *       avgAccuracy, medianAccuracy,
 *       failRate      fraction of non-SUCCESS / (non-SUCCESS + SUCCESS)
 *     },
 *     tokens: {
 *       totalPromptIn, totalCompletionOut, totalAll,
 *       avgPerConversion, avgPerFile,
 *       totalCalls
 *     },
 *     duration: {
 *       avgMs, medianMs  (completed conversions only)
 *     }
 *   }
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

function median(sorted) {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
}

function mount(app, deps) {
    const { activeConversions } = deps;

    // Minimal list of every in-memory conversion for the Compare
    // dropdown. Ordered newest-first — same sort the browser already
    // uses for checkpoint rehydration. Per-entry shape is
    // intentionally thin (id, status, startedAt, completedAt, inputPath,
    // file counts) to keep the payload small regardless of how many
    // conversions are cached.
    app.get('/api/conversions', (req, res) => {
        const rows = [];
        for (const [id, c] of activeConversions) {
            if (!c) continue;
            const files = (c.result && c.result.report && c.result.report.files) || [];
            rows.push({
                id,
                status: c.status,
                startedAt: c.startedAt || null,
                completedAt: c.completedAt || null,
                interruptedAt: c.interruptedAt || null,
                resumable: !!c.resumable,
                resumedFrom: c.resumedFrom || null,
                resumedAs: c.resumedAs || null,
                inputPath: c.inputPath || null,
                fileCount: files.length,
                successCount: files.filter(f => f.java_status === 'SUCCESS').length,
                totalTokens: (c.tokens && c.tokens.total) || 0
            });
        }
        rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        res.json({ conversions: rows });
    });

    app.get('/api/stats', (req, res) => {
        let completed = 0, inFlight = 0, cancelled = 0;
        let totalFiles = 0;
        const byStatus = {};
        const accuracies = [];
        let totalPromptIn = 0, totalCompletionOut = 0, totalAll = 0, totalCalls = 0;
        const durations = [];
        let successCount = 0, nonSuccessCount = 0;
        const completedConversions = [];

        for (const [, c] of activeConversions) {
            if (!c) continue;
            if (c.cancelled) cancelled++;
            if (c.status === 'running') { inFlight++; continue; }
            if (c.status === 'completed') {
                completed++;
                completedConversions.push(c);
            }

            // Roll up file-level stats. Only the report knows per-file
            // detail; a conversion without one (error before scan) just
            // contributes nothing to the aggregates.
            const files = (c.result && c.result.report && c.result.report.files) || [];
            for (const f of files) {
                totalFiles++;
                const st = f.java_status || 'UNKNOWN';
                byStatus[st] = (byStatus[st] || 0) + 1;
                if (st === 'SUCCESS') successCount++;
                // Skipped-* statuses are neither success nor failure — they
                // just weren't converted. Only count real attempts.
                else if (!st.startsWith('SKIPPED_')) nonSuccessCount++;
                if (typeof f.conversionAccuracy === 'number') {
                    accuracies.push(f.conversionAccuracy);
                }
            }

            // Tokens — structured per-conversion object (see processFile).
            const t = c.tokens || {};
            totalPromptIn += (t.promptIn || 0);
            totalCompletionOut += (t.completionOut || 0);
            totalAll += (t.total || 0);
            totalCalls += (t.calls || 0);

            if (c.startedAt && c.completedAt) {
                durations.push(c.completedAt - c.startedAt);
            }
        }

        const sortedAcc = accuracies.slice().sort((a, b) => a - b);
        const sortedDur = durations.slice().sort((a, b) => a - b);
        const avgAccuracy = accuracies.length
            ? Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length)
            : 0;
        const avgDurMs = durations.length
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : 0;

        const attempted = successCount + nonSuccessCount;
        const failRate = attempted > 0 ? nonSuccessCount / attempted : 0;

        res.json({
            conversions: {
                total: activeConversions.size,
                completed,
                inFlight,
                cancelled
            },
            files: {
                total: totalFiles,
                byStatus,
                avgAccuracy,
                medianAccuracy: median(sortedAcc),
                failRate: Number(failRate.toFixed(3))
            },
            tokens: {
                totalPromptIn,
                totalCompletionOut,
                totalAll,
                avgPerConversion: completed > 0 ? Math.round(totalAll / completed) : 0,
                avgPerFile: totalFiles > 0 ? Math.round(totalAll / totalFiles) : 0,
                totalCalls
            },
            duration: {
                avgMs: avgDurMs,
                medianMs: median(sortedDur)
            }
        });
    });
}

module.exports = { mount };
