/**
 * File-backed JSON-per-line logger with size-based rotation.
 * Writes to webui.log (gitignored) so server activity survives restarts and
 * we can grep failures offline. Console logging stays independent of this —
 * use `log(category, msg, extra?)` for structured events (server startup,
 * run completion, crashes, compile outcomes).
 *
 * Rotation (§17.2): when webui.log exceeds MAX_LOG_BYTES we shift the file
 * chain webui.log → webui.log.1 → webui.log.2 … → webui.log.5, dropping
 * the oldest. Keeps disk usage bounded at ~60 MB (10 MB × 6 files). The
 * check runs on every append — one extra stat() per log line, negligible
 * cost vs the appendFile itself.
 */

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB — rotate when the active log gets larger
const MAX_ARCHIVE_COUNT = 5;            // keep webui.log.1 .. webui.log.5 after rotation

function rotateIfOversized(logPath) {
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch { return; }
    if (size < MAX_LOG_BYTES) return;

    // Shift in reverse to avoid clobbering: .5 drops off, .4 → .5, …, .log → .log.1
    try { fs.unlinkSync(`${logPath}.${MAX_ARCHIVE_COUNT}`); } catch {}
    for (let i = MAX_ARCHIVE_COUNT - 1; i >= 1; i--) {
        try { fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`); } catch {}
    }
    try { fs.renameSync(logPath, `${logPath}.1`); } catch {}
    // Next appendFileSync will recreate the file.
}

function createLogger(basedir) {
    const LOG_PATH = path.join(basedir, 'webui.log');

    function log(category, msg, extra) {
        rotateIfOversized(LOG_PATH);
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

module.exports = { createLogger, rotateIfOversized, MAX_LOG_BYTES, MAX_ARCHIVE_COUNT };
