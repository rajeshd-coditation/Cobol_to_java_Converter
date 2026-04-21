/**
 * Post-conversion sign-off endpoints (separate from the in-flight HITL review).
 * These capture approve/reject/note decisions AFTER a conversion finishes —
 * what the user signs off on before treating output as production-ready.
 *
 *   POST /api/post-review/:id/:fileId — record decision for one file.
 *   GET  /api/post-review/:id         — full sign-off map.
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

function mount(app, deps) {
    const { activeConversions } = deps;

    app.post('/api/post-review/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const { action, note } = req.body || {};
        if (!['approve', 'reject', 'note'].includes(action)) {
            return res.status(400).json({ error: 'action must be approve | reject | note' });
        }
        conversion.postReview = conversion.postReview || {};
        conversion.postReview[req.params.fileId] = {
            action, note: note || null, at: Date.now()
        };
        res.json({ ok: true });
    });

    app.get('/api/post-review/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        res.json({ postReview: conversion.postReview || {} });
    });
}

module.exports = { mount };
