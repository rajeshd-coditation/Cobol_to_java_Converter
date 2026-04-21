/**
 * File-backed JSON-per-line logger.
 * Writes to webui.log (gitignored) so server activity survives restarts and
 * we can grep failures offline. Console logging stays independent of this —
 * use `log(category, msg, extra?)` for structured events (server startup,
 * run completion, crashes, compile outcomes).
 */

const fs = require('fs');
const path = require('path');

// Default log path — one file per server process, colocated with server.js.
// Parent can override by passing a different basedir to createLogger().
function createLogger(basedir) {
    const LOG_PATH = path.join(basedir, 'webui.log');

    function log(category, msg, extra) {
        const line = JSON.stringify({
            t: new Date().toISOString(),
            category,
            msg,
            ...(extra || {})
        }) + '\n';
        try { fs.appendFileSync(LOG_PATH, line); } catch {}
    }

    /**
     * Register on an Express app — mounts GET /api/logs?n=N that returns
     * the last N lines (raw JSONL). Cap at 5000 lines per request.
     */
    function mountLogRoute(app) {
        app.get('/api/logs', (req, res) => {
            const n = Math.min(parseInt(req.query.n || '500', 10), 5000);
            try {
                const content = fs.readFileSync(LOG_PATH, 'utf-8');
                const lines = content.trimEnd().split('\n');
                res.type('text/plain').send(lines.slice(-n).join('\n'));
            } catch {
                res.type('text/plain').send('No log file yet.');
            }
        });
    }

    return { log, mountLogRoute, LOG_PATH };
}

module.exports = { createLogger };
