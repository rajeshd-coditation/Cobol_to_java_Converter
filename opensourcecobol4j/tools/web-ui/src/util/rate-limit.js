/**
 * Per-IP sliding-window rate-limit middleware (§18.4).
 *
 * Guards the AI-burning endpoints from token-spend abuse if the server
 * gets exposed publicly. In-memory only — single-process, no Redis — so
 * this is "prevent a script kiddie from burning $500 in an afternoon",
 * not "defend against a distributed attack". For the latter, put a real
 * WAF / API gateway in front.
 *
 * Config: `{ windowMs, max, message?, headerPrefix? }` per limiter.
 *   windowMs   how far back we count requests (default 60_000 = 1 min)
 *   max        allowed requests in that window
 *   message    429 response body
 *   headerPrefix  adds X-<Prefix>-Limit / -Remaining / -Reset headers
 *
 * Key = client IP from req.ip (Express's X-Forwarded-For handling). If
 * the server runs behind a reverse proxy, caller should `app.set('trust
 * proxy', true)` so req.ip is the real client, not the proxy. Without
 * that, everyone shows up as the proxy's IP and the limit becomes a
 * single shared budget — documented here so it doesn't silently bite.
 *
 * The sliding window is a plain array of request timestamps per IP.
 * Cheap for the traffic levels this app sees (single-digit req/s at
 * peak); if it ever needs more, swap for a token bucket.
 */

function createRateLimiter(opts = {}) {
    const windowMs = opts.windowMs ?? 60_000;
    const max = opts.max ?? 30;
    const message = opts.message ?? 'Too many requests — please wait and try again.';
    const headerPrefix = opts.headerPrefix;

    // ip → array of request timestamps (ms). Entries older than windowMs
    // are pruned lazily on access. Periodic GC to keep memory bounded
    // even for IPs that hit once and never come back.
    const hits = new Map();
    const lastSeen = new Map();

    // Background sweep every 10 minutes — evicts any IP whose last hit
    // is older than the window. Cheap; runs only while Node is alive
    // (unref'd so the sweeper doesn't hold the process open).
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [ip, ts] of lastSeen) {
            if ((now - ts) > windowMs * 3) {
                hits.delete(ip);
                lastSeen.delete(ip);
            }
        }
    }, Math.max(windowMs * 2, 10 * 60 * 1000));
    if (sweep.unref) sweep.unref();

    return function rateLimit(req, res, next) {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const now = Date.now();

        // Prune entries outside the window.
        const arr = hits.get(ip) || [];
        const cutoff = now - windowMs;
        let writeIdx = 0;
        for (const t of arr) {
            if (t > cutoff) arr[writeIdx++] = t;
        }
        arr.length = writeIdx;

        if (arr.length >= max) {
            // Oldest hit determines the reset time for this window.
            const resetMs = arr[0] + windowMs;
            res.setHeader('Retry-After', Math.max(1, Math.ceil((resetMs - now) / 1000)));
            if (headerPrefix) {
                res.setHeader(`X-${headerPrefix}-Limit`, max);
                res.setHeader(`X-${headerPrefix}-Remaining`, 0);
                res.setHeader(`X-${headerPrefix}-Reset`, Math.ceil(resetMs / 1000));
            }
            return res.status(429).json({ error: message });
        }

        arr.push(now);
        hits.set(ip, arr);
        lastSeen.set(ip, now);

        if (headerPrefix) {
            res.setHeader(`X-${headerPrefix}-Limit`, max);
            res.setHeader(`X-${headerPrefix}-Remaining`, Math.max(0, max - arr.length));
        }
        next();
    };
}

module.exports = { createRateLimiter };
