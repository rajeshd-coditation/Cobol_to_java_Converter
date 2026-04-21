/**
 * Curated COBOL identifier typo fixes — things we've seen real repos ship
 * that `editDistance()` alone can't catch because the distance is too
 * large or the correction isn't present in the file (it lives in a
 * copybook or a different program).
 *
 * Two tiers:
 *   AUTO_APPLY  — unambiguous typos the preprocessor can rewrite without
 *                 checking context. The bad token is never a legal COBOL
 *                 construct (`PRINT-REX`, `CURRENT-DATA`) or is always
 *                 wrong wherever it appears (`COMP3`, `FILLER1`).
 *   HINT_ONLY   — context-dependent typos we only SUGGEST on compile
 *                 failure. Example: `ACCTREC` looks like a typo of
 *                 `ACCT-REC` but is also a legitimate external file name
 *                 in `SELECT FOO ASSIGN TO ACCTREC`. Silent rewriting
 *                 would break the JCL linkage.
 *
 * Both dicts feed the hint path (priority 1 lookup before edit-distance).
 * Only AUTO_APPLY feeds the preprocessor's rewrite pass.
 *
 * Keys and values are UPPERCASE — matches how cobc surfaces `'X' is not
 * defined` errors. Add entries as new typo patterns are seen in the wild;
 * don't add speculative mappings. When unsure, put it in HINT_ONLY.
 */

// Unambiguous — safe to rewrite during preprocessing without checking
// context. Each of these is never a legal COBOL token on its own.
const AUTO_APPLY = {
    // COBOL Programming Course CBL0002 — PRINT-REC is declared, PRINT-REX referenced
    'PRINT-REX': 'PRINT-REC',
    // COBOL Programming Course CBL0009 — TLIMITED is declared but code
    // references TLIMIT (edit distance 2, too far for fuzzy-match default).
    'TLIMIT':   'TLIMITED',
    // COBOL Programming Course CBL0012 — FUNCTION CURRENT-DATA is invoked
    // but the intrinsic is named CURRENT-DATE (the -A is a trailing typo).
    'CURRENT-DATA': 'CURRENT-DATE',
    // Common COMP-3 typo — COMP3 without the hyphen doesn't parse
    'COMP3':    'COMP-3',
    // WS- prefix often mistyped as WK- or WRK-
    'WRKS-CNT': 'WS-CNT',
    // FILLER-1 / FILLER1 drift (some dialects require the hyphen)
    'FILLER1':  'FILLER',
};

// Hint-only — suggest but don't auto-rewrite. Context-dependent.
const HINT_ONLY = {
    // CardDemo sample — ACCT-REC vs ACCTREC. Common as a typo inside
    // working-storage references, but ACCTREC is ALSO a legitimate
    // external file name in SELECT ... ASSIGN TO ACCTREC (COBOL
    // Programming Course uses it this way). Don't auto-rewrite — surface
    // the suggestion only when the compile actually fails with
    // `'ACCTREC' is not defined`.
    'ACCTREC':  'ACCT-REC',
};

// Combined view for the hint-lookup path (both tiers contribute hints).
const COBOL_TYPOS = Object.assign({}, HINT_ONLY, AUTO_APPLY);

/**
 * Look up a known-typo correction.
 * @param {string} bad — the identifier cobc reported as undefined
 * @returns {string|null} the canonical name, or null if not in the dictionary
 */
function lookupCobolTypo(bad) {
    if (!bad) return null;
    return COBOL_TYPOS[bad.toUpperCase()] || null;
}

module.exports = { lookupCobolTypo, COBOL_TYPOS, AUTO_APPLY, HINT_ONLY };
