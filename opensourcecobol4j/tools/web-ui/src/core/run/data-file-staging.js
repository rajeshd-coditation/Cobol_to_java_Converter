/**
 * Data-file staging for /api/run.
 *
 * When a COBOL program does `SELECT CUSTOMER-FILE ASSIGN TO 'CUST.DAT'`,
 * libcob looks for the file relative to the current working directory.
 * The graph-building step in /api/convert-azure already resolved which
 * ASSIGN targets map to which files in the repo (stored on the conversion
 * as `dataFileLookup`). We use that lookup to copy those data files into
 * BOTH run work dirs (Java and COBOL) before either program runs.
 *
 * Why multiple variants (FOO, FOO.txt, FOO.dat, FOO.upper, FOO.lower)?
 * COBOL source uses inconsistent conventions for external file names —
 * same program might reference `CUSTOMER`, `customer.txt`, or the SELECT
 * might say one thing and the generated Java BufferedReader expects
 * another. Staging every plausible variant avoids a cascade of "file not
 * found" bugs that are only caught at runtime.
 *
 * Functions:
 *   resolveDataAssignments(reportFile, conversion)
 *     Finds what data files this program needs. Prefers the cached
 *     conversion.dataFileLookup map (built during scan), falls back to
 *     re-parsing the source for `SELECT … ASSIGN TO` if the lookup is
 *     missing (older conversions / cancelled runs). Filters out synthetic
 *     ASSIGN names (PRINTER, CONSOLE, RANDOM, DISK, TAPE, STDIN, STDOUT,
 *     DISPLAY) that resolve inside libcob rather than to real files.
 *     Returns: [{ expected, matchedPath, variants }]
 *
 *   stageDataFilesInto(workDir, dataAssignments)
 *     Copy each matchedPath into workDir under every variant name. No-op
 *     if the variant already exists.
 */

const fs = require('fs');
const path = require('path');

const SYNTHETIC_ASSIGN = /^(PRINTER|CONSOLE|RANDOM|DISK|TAPE|STDIN|STDOUT|DISPLAY)$/i;

function buildVariants(expected) {
    return [expected, expected + '.txt', expected + '.dat', expected.toUpperCase(), expected.toLowerCase()];
}

function resolveDataAssignments(reportFile, conversion) {
    const out = [];
    try {
        const srcText = fs.existsSync(reportFile.source_path) ? fs.readFileSync(reportFile.source_path, 'utf-8') : '';
        const assignRe = /SELECT\s+[\w-]+\s+ASSIGN\s+TO\s+(?:['"]([^'"]+)['"]|([A-Z0-9_-]+))/gi;
        const expected = new Set();
        let am;
        while ((am = assignRe.exec(srcText)) !== null) {
            const n = (am[1] || am[2] || '').trim();
            if (!n || SYNTHETIC_ASSIGN.test(n)) continue;
            expected.add(n);
        }
        const lookup = conversion.dataFileLookup || {};
        const reportFiles = (conversion.result && conversion.result.report && conversion.result.report.files) || [];
        for (const exp of expected) {
            const cached = lookup[exp.toUpperCase()];
            if (cached && fs.existsSync(cached)) {
                out.push({ expected: exp, matchedPath: cached, variants: buildVariants(exp) });
                continue;
            }
            // Fallback: walk the full report for a basename match. This covers
            // older conversions where the lookup wasn't built, and cancelled
            // runs that didn't reach the data-file resolution step.
            const pool = reportFiles
                .filter(f => f.source_path && (f.java_status === 'SKIPPED_DATA' || f.java_status === 'SKIPPED_OTHER') && fs.existsSync(f.source_path))
                .map(f => f.source_path);
            const hit = pool.find(p => {
                const base = path.basename(p).toUpperCase();
                const stem = path.basename(p, path.extname(p)).toUpperCase();
                const E = exp.toUpperCase();
                return base === E || stem === E || base === E + '.TXT' || base === E + '.DAT';
            });
            if (hit) out.push({ expected: exp, matchedPath: hit, variants: buildVariants(exp) });
        }
    } catch { /* non-fatal */ }
    return out;
}

function stageDataFilesInto(workDir, dataAssignments) {
    if (!workDir || !fs.existsSync(workDir)) return;
    for (const d of dataAssignments) {
        for (const v of d.variants) {
            const dest = path.join(workDir, v);
            if (!fs.existsSync(dest)) {
                try { fs.copyFileSync(d.matchedPath, dest); } catch {}
            }
        }
    }
}

module.exports = { resolveDataAssignments, stageDataFilesInto };
