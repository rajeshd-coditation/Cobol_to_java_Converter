/**
 * listOutputFiles(workDir, runStartMs, excludeNames) → [{ name, bytes, contentPreview }]
 *
 * Used by /api/run to surface files the program *wrote* during the run, not
 * just its stdout. Many COBOL programs write their real output to a FILE
 * via WRITE (PRTLINE, REPORT, OUT*, etc.) — the stdout pane alone makes
 * those runs look silent when the program actually produced a report file.
 *
 * Filters:
 *   - must be a regular file, not starting with "." (hidden / lockfiles)
 *   - mtime >= runStartMs — 100ms grace, so only files touched during this
 *     run are listed (input-staging from before the run is invisible)
 *   - skip source / class / compiler-output extensions by regex
 *   - skip common compiler binary names (cobprog, a.out)
 *   - skip anything in `excludeNames` — caller passes the set of staged
 *     input names (both variants: FOO, FOO.txt, FOO.dat, upper, lower)
 *   - binary sniff: if >30% of first 512 bytes are non-text, skip (keeps
 *     report files with UTF-8 replacement chars visible while rejecting
 *     real native binaries, which are typically >60% non-printable)
 *
 * Preview capped at 8KB per file; longer files get a "[…truncated — N
 * bytes total]" footer so the UI can still tell size.
 */

const fs = require('fs');
const path = require('path');

const OUT_PREVIEW_MAX = 8000;
const SKIP_EXT = /\.(java|class|cbl|cob|cobol|cpy|copy|dylib|so|dll|o|obj|exe|jar)$/i;
const KNOWN_COMPILE_BINARY_NAMES = new Set(['cobprog', 'a.out']);

function listOutputFiles(workDir, runStartMs, excludeNames) {
    const out = [];
    if (!workDir || !fs.existsSync(workDir)) return out;
    try {
        for (const name of fs.readdirSync(workDir)) {
            if (excludeNames && excludeNames.has(name)) continue;
            if (SKIP_EXT.test(name)) continue;
            if (KNOWN_COMPILE_BINARY_NAMES.has(name)) continue;
            if (name.startsWith('.')) continue;
            const fp = path.join(workDir, name);
            let stat;
            try { stat = fs.statSync(fp); } catch { continue; }
            if (!stat.isFile()) continue;
            if (runStartMs && stat.mtimeMs < runStartMs - 100) continue;

            let contentPreview = null;
            try {
                const buf = fs.readFileSync(fp);
                const head = buf.slice(0, Math.min(512, buf.length));
                let nonText = 0;
                for (const b of head) {
                    if (b === 9 || b === 10 || b === 13) continue;
                    if (b >= 32 && b < 127) continue;
                    nonText++;
                }
                if (nonText / (head.length || 1) > 0.30) continue;
                const text = buf.toString('utf-8');
                contentPreview = buf.length > OUT_PREVIEW_MAX
                    ? text.slice(0, OUT_PREVIEW_MAX) + `\n\n[…truncated — file is ${buf.length} bytes total]`
                    : text;
            } catch { continue; }
            out.push({ name, bytes: stat.size, contentPreview });
        }
    } catch {}
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

module.exports = { listOutputFiles };
