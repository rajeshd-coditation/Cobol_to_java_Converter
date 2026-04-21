/**
 * validateRepoUrl — gate on what we'll accept as a git-clone target.
 *
 * Called by /api/scan-repo and /api/convert-azure before they invoke
 * `git clone`. The input can be:
 *   - an http(s) URL   → cloned from the remote
 *   - a git@host:path  → cloned via SSH
 *   - a local filesystem path → used as-is
 *
 * What we reject:
 *   - schemes other than http/https/git@ (e.g. file://, ftp://, javascript:)
 *     — those could point at local files or trigger URL-handler quirks
 *     in downstream tools.
 *   - shell metacharacters anywhere in the input — we interpolate into
 *     a `git clone "…"` command inside a shell, and even with quotes an
 *     embedded `$(command)` or backtick would execute. The quotes block
 *     space-splitting but NOT shell expansion.
 *   - whitespace at the start/end after the usual trim — a leading space
 *     in argv isn't a security issue but is almost certainly a paste bug.
 *
 * Returns { ok: true, kind: 'url' | 'path', value } on success, or
 * { ok: false, error } with a user-readable reason.
 */

// Disallow characters that have meaning to a POSIX shell. $, `, and ;
// are the dangerous ones even inside double quotes; the rest are just
// "paste bugs" that almost always indicate broken input.
// eslint-disable-next-line no-control-regex
const SHELL_METACHARS = /[\u0000-\u001f`$;|&<>\\!*?(){}\[\]"'\n\r]/;

function validateRepoUrl(raw) {
    if (typeof raw !== 'string') return { ok: false, error: 'Repo URL must be a string' };
    const input = raw.trim();
    if (input === '') return { ok: false, error: 'Repo URL or path is required' };

    // Shell-metacharacter check runs first — if the user typed
    // `x; rm -rf /` we want to reject before any scheme reasoning.
    if (SHELL_METACHARS.test(input)) {
        return { ok: false, error: 'Repo URL contains unsafe characters' };
    }

    // URL: must start with http(s):// or git@host:path. Anything else
    // that looks URL-ish (ftp, file, javascript, data) is rejected.
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) {
        return { ok: false, error: 'Only http(s) and git@ URLs are supported' };
    }
    if (/^git@[^:]+:/.test(input)) {
        return { ok: true, kind: 'url', value: input };
    }
    if (/^https?:\/\//i.test(input)) {
        return { ok: true, kind: 'url', value: input };
    }

    // Otherwise treat as a local path. Caller will fs.existsSync-check it.
    return { ok: true, kind: 'path', value: input };
}

module.exports = { validateRepoUrl };
