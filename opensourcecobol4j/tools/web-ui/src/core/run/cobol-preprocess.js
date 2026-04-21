/**
 * preprocessCobolSource — the one-line patches GnuCOBOL (cobc) needs to
 * accept real-world IBM mainframe COBOL.
 *
 * Many production COBOL files are sloppy about commentary-header periods:
 *   AUTHOR. Otto B. Relational
 *   DATE-WRITTEN. 1998-06-15 FRIDAY
 *   PROGRAM-ID. FOO
 *
 * cobc treats the missing period as a continuation and fails at the next
 * DIVISION with a confusing "unexpected" error. We rewrite the offending
 * lines into a patched copy before compiling — side-effect-free on disk
 * because the patched file lands in a caller-supplied work dir.
 *
 * Three patches applied in one pass:
 *   1. AUTHOR / DATE-WRITTEN / DATE-COMPILED / INSTALLATION / SECURITY /
 *      REMARKS: collapse to `<KW>.` with an empty value. We can't preserve
 *      the value because many embed literal periods inside it ("Otto B.
 *      Relational") which just shifts the problem.
 *   2. PROGRAM-ID. FOO with no trailing period inside cols 1-72. Re-emit
 *      the line so the period lands inside the compiler-visible range.
 *   3. Curated typo-dictionary rewrites (PRINT-REX→PRINT-REC, TLIMIT→
 *      TLIMITED, CURRENT-DATA→CURRENT-DATE, etc). These are upstream
 *      bugs in public COBOL repos — we auto-apply because the mapping
 *      is vetted and applying it unblocks compile without the user
 *      having to click "Apply typo fix" in the UI first.
 *
 * Returns: patched file path (same as srcPath if no changes were needed).
 *          mods.periodsAdded tracks header-period fixes.
 *          mods.typosFixed  (array) tracks applied typo rewrites.
 *
 * EXEC SQL / CICS / DLI / MQ stripping was intentionally removed. GnuCOBOL
 * can't run those programs regardless because the stripped blocks declare
 * SQLCODE / SQLCA / DFHCOMMAREA that the rest of the source references.
 * /api/run does a clean "requires mainframe preprocessor" short-circuit
 * instead.
 */

const fs = require('fs');
const path = require('path');
const { AUTO_APPLY } = require('../cobol-typo-dictionary');

const COMMENTARY_HEADERS = /^(\s*)(AUTHOR|DATE-WRITTEN|DATE-COMPILED|INSTALLATION|SECURITY|REMARKS)\s*\.(.*)$/i;
const PROGRAM_ID_RE = /^(\s*)PROGRAM-ID\s*\.\s*([A-Za-z0-9_-]+)/i;

// Build a single combined whole-word regex across every AUTO_APPLY key
// so we only traverse each line once. HINT_ONLY entries are excluded —
// those are context-dependent and surface only on compile failure.
// Sorted by length desc so longer keys are tried before shorter prefixes.
// Guard uses lookaround so PRINT-REX matches but PRINT-REXX does not.
const TYPO_KEYS = Object.keys(AUTO_APPLY).sort((a, b) => b.length - a.length);
const TYPO_RE = TYPO_KEYS.length
    ? new RegExp(
        `(?<![A-Za-z0-9_\\-])(?:${TYPO_KEYS.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})(?![A-Za-z0-9_\\-])`,
        'gi'
    )
    : null;

function applyTypoRewrites(line, mods) {
    if (!TYPO_RE) return line;
    // Skip comment lines (fixed-format: col 7 = '*'; free-format: leading
    // '*>' anywhere). No COBOL identifier is valid inside a comment, and
    // the text inside comments often looks like "PRINT-REX (old name)"
    // which shouldn't be rewritten.
    if (line.length >= 7 && line[6] === '*') return line;
    if (/^\s*\*>/.test(line)) return line;
    return line.replace(TYPO_RE, (match) => {
        const canonical = AUTO_APPLY[match.toUpperCase()];
        if (!canonical) return match;
        mods.typosFixed = mods.typosFixed || [];
        mods.typosFixed.push({ bad: match, suggestion: canonical });
        return canonical;
    });
}

function preprocessCobolSource(srcPath, outDir, mods) {
    try {
        const orig = fs.readFileSync(srcPath, 'utf-8');
        const lines = orig.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            let l = lines[i];
            // Apply typo-dictionary rewrites first so header-period logic
            // sees the canonical form. Rewrites stay whole-word; commentary
            // lines pass through untouched.
            l = applyTypoRewrites(l, mods);

            const m = l.match(COMMENTARY_HEADERS);
            if (m) {
                const indent = m[1];
                const kw = m[2].toUpperCase();
                const rest = m[3];
                if (rest.trim().length > 0) {
                    l = indent + kw + '.';
                    mods.periodsAdded++;
                }
                lines[i] = l;
                continue;
            }
            const pm = l.match(PROGRAM_ID_RE);
            if (pm) {
                // fixed-format area B is cols 8-72; check only cols 1-72
                // because cobc ignores column 73+ as the identification area.
                const contentInAreaB = l.slice(0, 72);
                if (!/\.\s*$/.test(contentInAreaB.trimEnd())) {
                    l = pm[1] + 'PROGRAM-ID. ' + pm[2] + '.';
                    mods.periodsAdded++;
                }
            }
            lines[i] = l;
        }

        const patched = lines.join('\n');
        if (patched === orig) return srcPath;
        const outName = path.join(outDir, 'patched_' + path.basename(srcPath));
        fs.writeFileSync(outName, patched, 'utf-8');
        return outName;
    } catch {
        return srcPath;
    }
}

module.exports = { preprocessCobolSource };
