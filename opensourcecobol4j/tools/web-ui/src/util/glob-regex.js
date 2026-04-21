/**
 * Convert a simple glob (* and **) to a RegExp anchored to the full string.
 * Only supports the subset we need:
 *   - `*`  → `[^/]*`  (does not cross path separator)
 *   - `**` → `.*`     (matches anything including separators)
 *   - `?`  → `[^/]`
 *   - all regex special chars escaped
 * Returns null on empty / invalid input. Case-insensitive by default.
 */
function globToRegex(glob) {
    if (!glob || typeof glob !== 'string') return null;
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 2; continue; }
        if (c === '*')                         { re += '[^/]*'; i++; continue; }
        if (c === '?')                         { re += '[^/]'; i++; continue; }
        if ('\\^$+.()|{}[]'.includes(c))       { re += '\\' + c; i++; continue; }
        re += c; i++;
    }
    try { return new RegExp('^' + re + '$', 'i'); } catch { return null; }
}

module.exports = { globToRegex };
