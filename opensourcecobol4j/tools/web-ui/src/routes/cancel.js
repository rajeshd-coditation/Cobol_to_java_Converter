/**
 * POST /api/cancel/:id — set the cancelled flag on an in-flight conversion.
 * The worker checks this at batch boundaries. Also resolves any HITL pending
 * reviews so the worker doesn't deadlock on human input while tearing down.
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

function mount(app, deps) {
    const { activeConversions } = deps;

    app.post('/api/cancel/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        if (conversion.status === 'completed') {
            return res.json({ ok: true, alreadyCompleted: true });
        }
        conversion.cancelled = true;
        if (conversion.pendingReview) {
            for (const [, item] of Object.entries(conversion.pendingReview)) {
                try { item.resolve({ action: 'reject', note: 'Cancelled' }); } catch {}
            }
        }
        res.json({ ok: true });
    });
}

module.exports = { mount };
