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
 * Two patches applied in one pass:
 *   1. AUTHOR / DATE-WRITTEN / DATE-COMPILED / INSTALLATION / SECURITY /
 *      REMARKS: collapse to `<KW>.` with an empty value. We can't preserve
 *      the value because many embed literal periods inside it ("Otto B.
 *      Relational") which just shifts the problem.
 *   2. PROGRAM-ID. FOO with no trailing period inside cols 1-72. Re-emit
 *      the line so the period lands inside the compiler-visible range.
 *
 * Returns: patched file path (same as srcPath if no changes were needed).
 *          Caller-visible mods.periodsAdded counter is mutated in-place.
 *
 * EXEC SQL / CICS / DLI / MQ stripping was intentionally removed. GnuCOBOL
 * can't run those programs regardless because the stripped blocks declare
 * SQLCODE / SQLCA / DFHCOMMAREA that the rest of the source references.
 * /api/run does a clean "requires mainframe preprocessor" short-circuit
 * instead.
 */

const fs = require('fs');
const path = require('path');

const COMMENTARY_HEADERS = /^(\s*)(AUTHOR|DATE-WRITTEN|DATE-COMPILED|INSTALLATION|SECURITY|REMARKS)\s*\.(.*)$/i;
const PROGRAM_ID_RE = /^(\s*)PROGRAM-ID\s*\.\s*([A-Za-z0-9_-]+)/i;

function preprocessCobolSource(srcPath, outDir, mods) {
    try {
        const orig = fs.readFileSync(srcPath, 'utf-8');
        const lines = orig.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const m = l.match(COMMENTARY_HEADERS);
            if (m) {
                const indent = m[1];
                const kw = m[2].toUpperCase();
                const rest = m[3];
                if (rest.trim().length > 0) {
                    lines[i] = indent + kw + '.';
                    mods.periodsAdded++;
                }
                continue;
            }
            const pm = l.match(PROGRAM_ID_RE);
            if (pm) {
                // fixed-format area B is cols 8-72; check only cols 1-72
                // because cobc ignores column 73+ as the identification area.
                const contentInAreaB = l.slice(0, 72);
                if (!/\.\s*$/.test(contentInAreaB.trimEnd())) {
                    lines[i] = pm[1] + 'PROGRAM-ID. ' + pm[2] + '.';
                    mods.periodsAdded++;
                }
            }
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
