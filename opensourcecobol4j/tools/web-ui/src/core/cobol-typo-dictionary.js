/**
 * Curated COBOL identifier typo fixes — things we've seen real repos ship
 * that `editDistance()` alone can't catch because the distance is too
 * large or the correction isn't present in the file (it lives in a
 * copybook or a different program).
 *
 * Used by server.js's /api/run cobc-error handler as a PRIORITY lookup
 * before the edit-distance fuzzy match fires. A direct hit here produces
 * a higher-confidence hint ("Known typo: X → Y") than the fuzzy version
 * ("Did you mean Y?") because the mapping is vetted.
 *
 * Keys and values are both UPPERCASE to match the way `'X' is not
 * defined` errors surface from gnucobol. Add entries as new typo
 * patterns are seen in the wild; don't add speculative mappings.
 */

const COBOL_TYPOS = {
    // COBOL Programming Course repo — PRINT-REC is declared, PRINT-REX is referenced
    'PRINT-REX': 'PRINT-REC',
    // COBOL Programming Course CBL0009 — TLIMITED is declared but code
    // references TLIMIT (edit distance 2, too far for fuzzy-match default).
    'TLIMIT':   'TLIMITED',
    // CardDemo sample — ACCT-REC vs ACCTREC (hyphen drift)
    'ACCTREC':  'ACCT-REC',
    // Common COMP-3 typo — COMP3 without the hyphen doesn't parse
    'COMP3':    'COMP-3',
    // WS- prefix often mistyped as WK- or WRK-
    'WRKS-CNT': 'WS-CNT',
    // FILLER-1 / FILLER1 drift (some dialects require the hyphen)
    'FILLER1':  'FILLER',
};

/**
 * Look up a known-typo correction.
 * @param {string} bad — the identifier cobc reported as undefined
 * @returns {string|null} the canonical name, or null if not in the dictionary
 */
function lookupCobolTypo(bad) {
    if (!bad) return null;
    return COBOL_TYPOS[bad.toUpperCase()] || null;
}

module.exports = { lookupCobolTypo, COBOL_TYPOS };
