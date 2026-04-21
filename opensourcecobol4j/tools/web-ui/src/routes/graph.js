/**
 * Dependency graph + per-file timeline endpoints. Both are lightweight and
 * polled by the graph view during a conversion.
 *
 *   GET /api/graph/:id         — one-time graph (?full=1) + per-file states.
 *                                Optional ?file=<rel> includes that file's
 *                                timeline inline (saves a second round trip
 *                                for the currently-inspected node).
 *   GET /api/file-timeline/:id — just the timeline + state for one file.
 *                                Used when the node-detail panel opens.
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

function mount(app, deps) {
    const { activeConversions } = deps;

    // Build a compact per-file meta block from the graph edges + timeline.
    // Shipped on every poll so the activity drawer can show an inline
    // "calls X, uses Y copybooks · accuracy N% · Ms" line under each
    // event without a second API round-trip. Kept cheap: O(edges + files).
    function buildFileMeta(conversion) {
        const meta = {};
        const edges = (conversion.graph && conversion.graph.edges) || [];
        for (const e of edges) {
            if (!e || !e.source) continue;
            const entry = meta[e.source] = meta[e.source] || { calls: 0, copies: 0, jcl: 0 };
            if (e.kind === 'call' || e.kind === 'call-external' || e.kind === 'cics') entry.calls++;
            else if (e.kind === 'copy' || e.kind === 'sql-include') entry.copies++;
            else if (e.kind === 'jcl') entry.jcl++;
        }
        // Merge in the latest metrics from each file's phase history: the
        // last entry with accuracy / totalMs / tokens wins.
        const timelines = conversion.fileTimeline || {};
        for (const [id, phases] of Object.entries(timelines)) {
            const m = meta[id] = meta[id] || { calls: 0, copies: 0, jcl: 0 };
            for (const p of phases) {
                if (typeof p.accuracy === 'number') m.accuracy = p.accuracy;
                if (typeof p.totalMs === 'number') m.durationMs = p.totalMs;
                if (typeof p.tokens === 'number') m.tokens = (m.tokens || 0) + p.tokens;
                if (p.step === 'done' || p.step === 'ai_done' || p.step === 'compile_done') {
                    // nothing extra needed — we capture totals above
                }
                if (p.step === 'repair_failed' || p.step === 'repair_errored') {
                    if (p.errorPreview || p.error) {
                        m.error = String(p.errorPreview || p.error).slice(0, 120);
                    }
                }
            }
        }
        // Last-run stdout/stderr error summary from any failed report entries.
        const files = (conversion.result && conversion.result.report && conversion.result.report.files) || [];
        for (const f of files) {
            if (!f || !f.path) continue;
            const m = meta[f.path] = meta[f.path] || { calls: 0, copies: 0, jcl: 0 };
            if (!m.error && f.error) m.error = String(f.error).slice(0, 120);
            if (m.accuracy == null && typeof f.conversionAccuracy === 'number') m.accuracy = f.conversionAccuracy;
        }
        return meta;
    }

    app.get('/api/graph/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) {
            return res.status(404).json({ error: 'Conversion not found' });
        }
        if (!conversion.graph) {
            return res.json({ ready: false, status: conversion.status });
        }
        const includeGraph = req.query.full === '1';
        // Inline a single file's timeline when the UI asks — avoids shipping
        // every file's timeline on every 1-2s poll.
        let timeline = null;
        if (req.query.file && conversion.fileTimeline) {
            timeline = conversion.fileTimeline[req.query.file] || [];
        }
        res.json({
            ready: true,
            status: conversion.status,
            graph: includeGraph ? conversion.graph : undefined,
            fileStates: conversion.fileStates,
            currentFiles: conversion.currentFiles || [],
            tokens: conversion.tokens || null,
            risks: conversion.risks || null,
            fileMeta: buildFileMeta(conversion),
            timeline
        });
    });

    app.get('/api/file-timeline/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const rel = req.query.file;
        if (!rel) return res.status(400).json({ error: 'file (relative path) required' });
        res.json({
            file: rel,
            timeline: (conversion.fileTimeline && conversion.fileTimeline[rel]) || [],
            state: (conversion.fileStates && conversion.fileStates[rel]) || null
        });
    });
}

module.exports = { mount };
