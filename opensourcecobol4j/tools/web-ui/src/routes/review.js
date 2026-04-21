/**
 * HITL (human-in-the-loop) review endpoints. Each conversion can pause on a
 * per-file basis when reviewMode is on; the frontend uses these routes to
 * drain the pause queue and record the reviewer's decision in the audit log.
 *
 *   GET  /api/review/:id/:fileId    — payload for a single pending review.
 *   POST /api/review/:id/:fileId    — submit approve / reject / edit decision.
 *   POST /api/review-mode/:id       — toggle reviewMode + optional glob filter.
 *                                     Turning OFF drains the queue (auto-approve).
 *   GET  /api/reviews/:id           — list everything currently waiting.
 *   POST /api/reviews/:id/bulk      — approve/reject the whole queue at once.
 *   GET  /api/reviews/:id/history   — full decision audit trail.
 *
 * mount(app, deps) where deps = { activeConversions, saveCheckpoint, globToRegex }.
 */

function mount(app, deps) {
    const { activeConversions, saveCheckpoint, globToRegex } = deps;

    app.get('/api/review/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const item = conversion.pendingReview && conversion.pendingReview[req.params.fileId];
        if (!item) return res.status(404).json({ error: 'No pending review for this file' });
        res.json({
            fileId: req.params.fileId,
            cobolSource: item.cobolSource,
            javaCode: item.javaCode,
            queuedAt: item.queuedAt
        });
    });

    app.post('/api/review/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const item = conversion.pendingReview && conversion.pendingReview[req.params.fileId];
        if (!item) return res.status(404).json({ error: 'No pending review for this file' });

        const { action, editedJava, note } = req.body || {};
        if (!['approve', 'reject', 'edit'].includes(action)) {
            return res.status(400).json({ error: 'action must be approve | reject | edit' });
        }
        item.resolve({ action, editedJava, note });
        (conversion.reviewHistory ||= []).push({
            fileId: req.params.fileId, action, at: Date.now(), note: note || null
        });
        saveCheckpoint(req.params.id);
        res.json({ ok: true });
    });

    // Turning OFF auto-approves everything currently pending so the worker proceeds.
    // Turning ON affects only *future* files; already-converted files are untouched.
    app.post('/api/review-mode/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const { reviewMode, reviewGlob } = req.body || {};
        const wasOn = !!conversion.reviewMode;
        const nowOn = !!reviewMode;
        conversion.reviewMode = nowOn;
        if (typeof reviewGlob === 'string' || reviewGlob === null) {
            conversion.reviewGlob = reviewGlob || null;
            conversion.reviewGlobRe = globToRegex(conversion.reviewGlob);
        }

        let drained = 0;
        if (wasOn && !nowOn && conversion.pendingReview) {
            for (const [fileId, item] of Object.entries(conversion.pendingReview)) {
                if (!item || typeof item.resolve !== 'function') continue;
                item.resolve({ action: 'approve', note: 'Auto-approved (review mode turned off)' });
                (conversion.reviewHistory ||= []).push({
                    fileId, action: 'approve', at: Date.now(),
                    note: 'Auto-approved (review mode turned off)', auto: true
                });
                drained++;
            }
        }
        saveCheckpoint(req.params.id);
        res.json({ ok: true, reviewMode: nowOn, drained });
    });

    app.get('/api/reviews/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const pending = Object.entries(conversion.pendingReview || {}).map(([fileId, item]) => ({
            fileId,
            queuedAt: item.queuedAt
        }));
        res.json({
            pending,
            history: conversion.reviewHistory || [],
            reviewMode: !!conversion.reviewMode,
            reviewGlob: conversion.reviewGlob || null
        });
    });

    app.post('/api/reviews/:id/bulk', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const action = (req.body && req.body.action) || '';
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'action must be approve | reject' });
        }
        const note = action === 'reject' ? 'Bulk rejected' : null;
        const fileIds = Object.keys(conversion.pendingReview || {});
        let count = 0;
        for (const fileId of fileIds) {
            const item = conversion.pendingReview[fileId];
            if (!item) continue;
            item.resolve({ action, note });
            (conversion.reviewHistory ||= []).push({
                fileId, action, at: Date.now(), note, bulk: true
            });
            count++;
        }
        res.json({ ok: true, count });
    });

    app.get('/api/reviews/:id/history', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        res.json({ history: conversion.reviewHistory || [] });
    });
}

module.exports = { mount };
