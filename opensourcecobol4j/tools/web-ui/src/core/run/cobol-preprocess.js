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
 *   4. Dangling END-IF fix. Specific upstream pattern:
 *            IF <cond> <inline action>.
 *            END-IF.
 *      The period after the inline action closes the IF scope, leaving
 *      END-IF stranded — cobc errors "unexpected END-IF". Canonical
 *      example: COBOL Programming Course CBL0007 `IS-STATE-VIRGINIA`
 *      paragraph. Fix: strip the period on the IF line when the next
 *      non-comment line begins with END-IF.
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

        // Second pass: strip the period on a single-line `IF <cond> <action>.`
        // when the next non-comment non-blank line starts with END-IF. Narrow
        // by design: matches ONLY when IF and the action live on the same
        // line (that's the upstream bug shape). Multi-line IF blocks are
        // untouched because their IF line doesn't end with `.` — they end
        // with the condition or newline.
        const looksLikeCommentLine = (s) => {
            if (!s) return false;
            if (s.length >= 7 && s[6] === '*') return true; // fixed-format comment
            if (/^\s*\*>/.test(s)) return true;             // free-format comment
            return false;
        };
        const nextCodeLine = (from) => {
            for (let j = from + 1; j < lines.length; j++) {
                const t = lines[j];
                if (!t || !t.trim()) continue;
                if (looksLikeCommentLine(t)) continue;
                return { idx: j, text: t };
            }
            return null;
        };
        const IF_INLINE_PERIOD_RE = /^(\s*IF\s+\S.*\S)\s*\.\s*$/i;
        const ENDIF_LINE_RE = /^\s*END-IF\b/i;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (looksLikeCommentLine(l)) continue;
            const m = l.match(IF_INLINE_PERIOD_RE);
            if (!m) continue;
            const nx = nextCodeLine(i);
            if (!nx || !ENDIF_LINE_RE.test(nx.text)) continue;
            // Strip the trailing period on the IF line so END-IF terminates
            // the scope instead of being dangled behind a closed IF.
            lines[i] = m[1];
            mods.endifDanglingFixed = (mods.endifDanglingFixed || 0) + 1;
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
