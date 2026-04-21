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
