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
 *     conversion.dataFileLookup map (built during scan). If that's empty
 *     (conversion rehydrated from an old checkpoint that didn't persist
 *     the lookup), ensureDataFileLookup rebuilds it on the fly by
 *     re-parsing the report's JCL entries + matching DSN qualifiers to
 *     SKIPPED_DATA / SKIPPED_OTHER files. Filters out synthetic ASSIGN
 *     names (PRINTER, CONSOLE, RANDOM, DISK, TAPE, STDIN, STDOUT,
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
        const lookup = ensureDataFileLookup(conversion);
        const reportFiles = (conversion.result && conversion.result.report && conversion.result.report.files) || [];
        for (const exp of expected) {
            const cached = lookup[exp.toUpperCase()];
            if (cached && fs.existsSync(cached)) {
                out.push({ expected: exp, matchedPath: cached, variants: buildVariants(exp) });
                continue;
            }
            // Fallback 1: walk the full report for a basename match.
            const pool = reportFiles
                .filter(f => f.source_path && (f.java_status === 'SKIPPED_DATA' || f.java_status === 'SKIPPED_OTHER') && fs.existsSync(f.source_path))
                .map(f => f.source_path);
            const E = exp.toUpperCase();
            let hit = pool.find(p => {
                const base = path.basename(p).toUpperCase();
                const stem = path.basename(p, path.extname(p)).toUpperCase();
                return base === E || stem === E || base === E + '.TXT' || base === E + '.DAT';
            });
            if (hit) { out.push({ expected: exp, matchedPath: hit, variants: buildVariants(exp) }); continue; }

            // Fallback 2: search data/ directories relative to inputPath and
            // its parent. Matches by exact stem or by shared prefix (covers
            // ACCTFILE → acctdata.txt, CARDFILE → carddata.txt, etc.).
            if (!hit && conversion && conversion.inputPath) {
                const prefix = E.replace(/FILE$/, '').slice(0, 4).toLowerCase();
                const searchRoots = [conversion.inputPath, path.dirname(conversion.inputPath)];
                outer: for (const root of searchRoots) {
                    for (const dataDir of ['data/ASCII', 'data/EBCDIC', 'data', 'testdata', 'input']) {
                        const dir = path.join(root, dataDir);
                        if (!fs.existsSync(dir)) continue;
                        let files;
                        try { files = fs.readdirSync(dir); } catch { continue; }
                        const match = files.find(f => {
                            const fu = f.toUpperCase();
                            const stem = fu.replace(/\.[^.]+$/, '');
                            return stem === E || fu === E || (prefix.length >= 3 && stem.toLowerCase().startsWith(prefix));
                        });
                        if (match) {
                            hit = path.join(dir, match);
                            out.push({ expected: exp, matchedPath: hit, variants: buildVariants(exp) });
                            break outer;
                        }
                    }
                }
            }
        }
    } catch { /* non-fatal */ }
    return out;
}

/**
 * Rebuild dataFileLookup on the fly when the conversion was rehydrated
 * from a pre-checkpoint-fields version (conv.dataFileLookup is undefined).
 * Uses the report's SKIPPED_DATA / SKIPPED_OTHER / SKIPPED_JCL entries,
 * re-parses any JCL files, and maps each DD name → matching data file.
 *
 * Canonical shape of the scan-side lookup (UPPER(DD/ASSIGN) → path). Same
 * logic as buildConversionGraph's JCL-DD scan — kept in sync if one side
 * grows a new heuristic, both should.
 *
 * Idempotent: caches the result on conv.dataFileLookup so repeat /api/run
 * calls on the same file don't re-do the work.
 */
function ensureDataFileLookup(conversion) {
    if (conversion.dataFileLookup && Object.keys(conversion.dataFileLookup).length > 0) {
        return conversion.dataFileLookup;
    }
    const lookup = {};
    const reportFiles = (conversion.result && conversion.result.report && conversion.result.report.files) || [];
    const inputPath = conversion.inputPath;
    if (!inputPath) return lookup;

    // Pool of candidate data files — anything the scanner classified as
    // SKIPPED_DATA or SKIPPED_OTHER. JCL files themselves are excluded.
    const dataPool = reportFiles
        .filter(f => f.source_path && (f.java_status === 'SKIPPED_DATA' || f.java_status === 'SKIPPED_OTHER') && fs.existsSync(f.source_path))
        .map(p => ({
            path: p.source_path,
            base: path.basename(p.source_path).toUpperCase(),
            stem: path.basename(p.source_path, path.extname(p.source_path)).toUpperCase()
        }));

    // Walk every JCL file the conversion knows about and parse DD → DSN.
    // parseJcl lives in src/scan/jcl-parser.js — require here (not at
    // top-of-file) so older conversions without JCL skip the resolve
    // without needing the module on the fast path.
    const jclFiles = reportFiles
        .filter(f => f.source_path && f.java_status === 'SKIPPED_JCL' && fs.existsSync(f.source_path))
        .map(f => f.source_path);
    if (jclFiles.length === 0) return (conversion.dataFileLookup = lookup);

    let parseJcl;
    try { ({ parseJcl } = require('../../scan/jcl-parser')); }
    catch { return (conversion.dataFileLookup = lookup); }

    for (const jclPath of jclFiles) {
        try {
            const parsed = parseJcl(fs.readFileSync(jclPath, 'utf-8'));
            if (!parsed) continue;
            for (const step of parsed.steps || []) {
                for (const dd of step.dds || []) {
                    if (!dd.name || !dd.dsn) continue;
                    // Extract the last qualifier of the DSN (strip &SYSUID.)
                    const qual = dd.dsn
                        .replace(/^[&]?[A-Z0-9]+\./i, '')
                        .split('.')
                        .filter(Boolean)
                        .pop();
                    if (!qual) continue;
                    const candidates = dataPool.filter(e =>
                        e.base.startsWith(qual.toUpperCase()) || e.stem === qual.toUpperCase()
                    );
                    if (candidates.length > 0) {
                        const upperDD = dd.name.toUpperCase();
                        if (!lookup[upperDD]) lookup[upperDD] = candidates[0].path;
                    }
                }
            }
        } catch {}
    }
    conversion.dataFileLookup = lookup;
    return lookup;
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
