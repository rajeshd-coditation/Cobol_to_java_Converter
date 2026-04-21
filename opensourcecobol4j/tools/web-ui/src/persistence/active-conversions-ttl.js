/**
 * In-memory activeConversions TTL (§17.3).
 *
 * Long-running servers accumulate completed conversions in memory — nothing
 * evicts them today, so they leak until restart. This helper sweeps the map
 * on a timer and drops completed conversions whose `completedAt` (or
 * `startedAt` if somehow missing) is older than `maxAgeMs`.
 *
 * Running conversions are NEVER evicted regardless of age — the worker
 * mutates state through the map reference and eviction would orphan its
 * writes. If a run is legitimately stuck, the user should cancel it; that
 * sets status='completed' and makes it eligible for the next sweep.
 *
 * Disk state survives: the checkpoint for each evicted conversion stays
 * in $TMPDIR/cobol_converter_checkpoints/. A user who deep-links back to
 * an old conversionId will get rehydrated on the next request (the
 * status/browser/graph routes already handle that path via loadCheckpoints
 * at startup). Separately, cleanupOldCheckpoints() prunes the disk side
 * on a longer timescale (§17.4).
 *
 * startActiveConversionsTTL(activeConversions, opts?) → stop function
 *   opts = {
 *     maxAgeMs   = 2 * 3600 * 1000    two hours
 *     intervalMs = 5 * 60 * 1000      five minutes between sweeps
 *     onEvict?   = (id, conv) => void optional hook, useful for logging
 *   }
 */

function sweepOnce(activeConversions, maxAgeMs, onEvict) {
    const now = Date.now();
    let evicted = 0;
    for (const [id, conv] of activeConversions) {
        if (!conv || conv.status === 'running') continue;
        const when = conv.completedAt || conv.startedAt || 0;
        if (when && (now - when) > maxAgeMs) {
            activeConversions.delete(id);
            evicted++;
            if (onEvict) {
                try { onEvict(id, conv); } catch {}
            }
        }
    }
    return evicted;
}

function startActiveConversionsTTL(activeConversions, opts = {}) {
    const maxAgeMs   = opts.maxAgeMs   ?? 2 * 60 * 60 * 1000;
    const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    const onEvict    = opts.onEvict;

    const timer = setInterval(() => {
        sweepOnce(activeConversions, maxAgeMs, onEvict);
    }, intervalMs);
    // Don't keep Node alive just for the sweeper — the server's app.listen
    // is the real lifetime anchor. unref() lets the process exit cleanly
    // when everything else is done.
    if (timer.unref) timer.unref();

    return function stop() { clearInterval(timer); };
}

module.exports = { startActiveConversionsTTL, sweepOnce };
