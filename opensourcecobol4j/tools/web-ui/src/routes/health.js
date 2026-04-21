/**
 * GET /api/health — liveness + ops snapshot.
 *
 * Returns:
 *   {
 *     ok: true,
 *     uptime: seconds since server boot,
 *     activeConversions: {
 *        total, running, completed, awaitingReview
 *     },
 *     ai: {
 *        provider, azureAvailable, openaiAvailable
 *     },
 *     disk: {
 *        tmpdir, tmpdirFree?  (best-effort; omitted if statvfs unavailable)
 *     }
 *   }
 *
 * Lightweight — reads everything off in-memory state and the filesystem.
 * Intended for k8s-style probes and "is the server actually running and
 * not wedged on something?" checks. No auth; safe to expose.
 *
 * mount(app, deps) where deps = { activeConversions, AI_PROVIDER,
 *                                 aiAgent, azureAgent }.
 */

const os = require('os');

function mount(app, deps) {
    const { activeConversions, AI_PROVIDER, aiAgent, azureAgent } = deps;
    const bootTime = Date.now();

    app.get('/api/health', (req, res) => {
        let running = 0, completed = 0, awaitingReview = 0;
        for (const [, c] of activeConversions) {
            if (c.status === 'running') running++;
            else if (c.status === 'completed') completed++;
            const pr = c.pendingReview || {};
            awaitingReview += Object.keys(pr).length;
        }

        res.json({
            ok: true,
            uptime: Math.floor((Date.now() - bootTime) / 1000),
            activeConversions: {
                total: activeConversions.size,
                running,
                completed,
                awaitingReview
            },
            ai: {
                provider: AI_PROVIDER,
                azureAvailable: !!(azureAgent && azureAgent.isAvailable && azureAgent.isAvailable()),
                openaiAvailable: !!(aiAgent && aiAgent.isAvailable && aiAgent.isAvailable())
            },
            disk: {
                tmpdir: os.tmpdir()
            }
        });
    });
}

module.exports = { mount };
