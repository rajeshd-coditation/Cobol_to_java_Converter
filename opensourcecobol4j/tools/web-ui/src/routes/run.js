/**
 * POST /api/run/:id/:fileId — runs a converted file's COBOL source and the
 * generated Java output side by side with the same stdin, then diffs their
 * outputs. Called from the Run panel in the results browser; the companion
 * /ws/run/:id/:fileId (src/routes/run-ws.js) is the interactive live-terminal
 * variant.
 *
 * Body: { input?: string } — optional custom stdin. Commas and escaped `\n`
 * are both treated as line separators. Whatever the user supplies gets
 * padded with `4\n4\n4\nq\n0\nn\n` so menu-driven programs eventually hit
 * an exit path instead of looping forever.
 *
 * Returns: { cobol: {...}, java: {...}, effectiveStdin: {user, padded} }.
 * Each side carries ok / exitCode / duration / output / error / outputFiles
 * / optional typoFix (COBOL only) / timedOut.
 *
 * --- Execution strategy ---------------------------------------------------
 * Java side: target + its referenced siblings (discovered by class-name
 *            grep on the stripped source) get `javac`'d together. On
 *            compile failure, fall back to target-alone (broken siblings
 *            shouldn't block running a working target). Then `java
 *            <class>` with 5-second timeout.
 *
 * COBOL side: pre-flight EXEC SQL/CICS/DLI/MQ detection (cobc can't run
 *             those — surface a clean "requires mainframe preprocessor"
 *             message instead of cryptic cobc errors). Otherwise, every
 *             sibling is compiled as a callable module (-m) named by
 *             PROGRAM-ID so CALL 'FOO' resolves; then the target is
 *             compiled as the executable (-x). Tried across dialects
 *             (mf → default → minimal) and formats (free → fixed) until
 *             one combination works.
 *
 * Preprocessor (src/core/run/cobol-preprocess.js): auto-fixes header
 * periods, auto-applies curated typo dictionary (PRINT-REX → PRINT-REC
 * etc), auto-strips dangling END-IF periods. Surfaces counts in the
 * error footer so the user sees what got touched.
 *
 * Typo hint: when cobc errors with `'FOO' is not defined`, priority 1 is
 * a curated dictionary match; priority 2 is Levenshtein ≤ maxDist (1 for
 * short IDs, 2 for ≥7-char IDs) against 01-level and FD/SD declarations
 * in the same source. Surfaces as both human text AND a structured
 * `typoFix` object the UI uses for a one-click apply-fix button.
 *
 * mount(app, deps) where deps = {
 *   activeConversions,
 *   resolveDataAssignments, stageDataFilesInto, preprocessCobolSource,
 *   listOutputFiles, stripAnsi, lookupCobolTypo, editDistance, log
 * }.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

function mount(app, deps) {
    const {
        activeConversions,
        resolveDataAssignments,
        stageDataFilesInto,
        preprocessCobolSource,
        listOutputFiles,
        stripAnsi,
        lookupCobolTypo,
        editDistance,
        log
    } = deps;

    app.post('/api/run/:id/:fileId(*)', async (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        if (!conversion.result) return res.status(400).json({ error: 'Conversion not complete yet' });

        const fileId = req.params.fileId;
        const reportFile = (conversion.result.report.files || []).find(f => f.path === fileId);
        if (!reportFile) return res.status(404).json({ error: 'File not in report' });

        // Custom stdin from the user. Commas + escaped \n both act as line
        // separators for convenience (e.g. "1,4" or "1\\n100.50\\n4").
        let userInput = (req.body && typeof req.body.input === 'string') ? req.body.input : '';
        if (userInput.trim()) {
            userInput = userInput.replace(/\\n/g, '\n').replace(/,/g, '\n');
            if (!userInput.endsWith('\n')) userInput += '\n';
        } else {
            userInput = '';
        }
        // Pad with exit-ish values so menu programs don't loop forever when
        // ACCEPT reads past the supplied input.
        userInput += '4\n4\n4\nq\n0\nn\n';

        const result = { cobol: null, java: null };
        const runStartMs = Date.now();

        // Data-file staging: copy SELECT-ASSIGN targets into the Java work
        // dir under every plausible name variant. COBOL side gets the same
        // treatment just before cobc runs.
        const dataAssignments = resolveDataAssignments(reportFile, conversion);
        stageDataFilesInto(reportFile.work_dir, dataAssignments);

        runJava(result, reportFile, conversion, userInput);
        runCobol(result, reportFile, conversion, userInput, dataAssignments, {
            preprocessCobolSource, stageDataFilesInto, lookupCobolTypo, editDistance, log
        });

        // Strip ANSI escape sequences before sending to the browser.
        if (result.cobol && result.cobol.output) result.cobol.output = stripAnsi(result.cobol.output);
        if (result.cobol && result.cobol.error)  result.cobol.error  = stripAnsi(result.cobol.error);
        if (result.java  && result.java.output)  result.java.output  = stripAnsi(result.java.output);
        if (result.java  && result.java.error)   result.java.error   = stripAnsi(result.java.error);

        // Surface files the program wrote during the run (PRTLINE, REPORT,
        // OUT*, etc.). Exclude the data files we just staged — they're
        // inputs, not outputs.
        try {
            const stagedInputs = new Set(Object.keys(conversion.dataFileLookup || {}));
            const staged = new Set();
            for (const nm of stagedInputs) {
                const bases = [nm, nm.toLowerCase(), nm.toUpperCase()];
                for (const b of bases) { staged.add(b); staged.add(b + '.txt'); staged.add(b + '.dat'); }
            }
            if (result.java && reportFile.work_dir) {
                result.java.outputFiles = listOutputFiles(reportFile.work_dir, runStartMs, staged);
            }
            if (result.cobol && result.cobol._workDir) {
                result.cobol.outputFiles = listOutputFiles(result.cobol._workDir, runStartMs, staged);
                delete result.cobol._workDir;
            }
        } catch {}

        // Cache last-run outputs per file so /api/fix-java can feed them to
        // the repair agent as context.
        conversion._lastRun = conversion._lastRun || {};
        conversion._lastRun[fileId] = {
            cobolOutput: (result.cobol && result.cobol.output) || '',
            cobolError:  (result.cobol && result.cobol.error)  || '',
            javaOutput:  (result.java  && result.java.output)  || '',
            javaError:   (result.java  && result.java.error)   || '',
            cobolExit:   result.cobol ? result.cobol.exitCode : null,
            javaExit:    result.java  ? result.java.exitCode  : null
        };

        // Echo back the effective stdin (user + padding) so the UI can show
        // what the program actually saw.
        result.effectiveStdin = {
            user: (req.body && typeof req.body.input === 'string') ? req.body.input : '',
            padded: userInput
        };

        log('run', 'complete', {
            file: fileId,
            cobolExit: result.cobol ? result.cobol.exitCode : null,
            cobolOk:   result.cobol ? result.cobol.ok : null,
            javaExit:  result.java  ? result.java.exitCode  : null,
            javaOk:    result.java  ? result.java.ok  : null,
            cobolErrorSnippet: result.cobol && result.cobol.error ? result.cobol.error.slice(0, 200) : null
        });

        res.json(result);
    });
}

// --- Java ---------------------------------------------------------------
// Compile target + its referenced siblings (discovered by class-name grep),
// fall back to target-alone if siblings fail. Then `java <class>` with a
// 5-second timeout.
function runJava(result, reportFile, conversion, userInput) {
    if (!(reportFile.work_dir && reportFile.java_path)) {
        result.java = { ok: false, output: '', error: 'No Java output for this file' };
        return;
    }
    try {
        const javaClass = path.basename(reportFile.java_path, '.java');

        // Build a map of available sibling classes.
        const siblingByClass = {};
        for (const f of (conversion.result.report.files || [])) {
            if (!f.java_path || f === reportFile || !fs.existsSync(f.java_path)) continue;
            siblingByClass[path.basename(f.java_path, '.java')] = f.java_path;
        }

        // Scan the target for class references (strip comments/strings first).
        let targetSource = '';
        try { targetSource = fs.readFileSync(reportFile.java_path, 'utf-8'); } catch {}
        const stripped = targetSource
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/"(?:\\.|[^"\\])*"/g, '""');
        const referencedClasses = new Set();
        const refRe = /\b([A-Z][A-Za-z0-9_]*)\s*(?:\(|\.)/g;
        let _m;
        while ((_m = refRe.exec(stripped)) !== null) {
            if (siblingByClass[_m[1]]) referencedClasses.add(_m[1]);
        }

        // Stage only the referenced siblings into the work dir.
        const stagedSiblings = [];
        for (const cls of referencedClasses) {
            const src = siblingByClass[cls];
            try {
                const dest = path.join(reportFile.work_dir, path.basename(src));
                if (dest !== src && !fs.existsSync(dest)) {
                    fs.copyFileSync(src, dest);
                }
                stagedSiblings.push(dest);
            } catch {}
        }

        const tryCompile = (paths) => {
            const cmd = `javac ${paths.map(p => `"${p}"`).join(' ')}`;
            try {
                execSync(cmd, { cwd: reportFile.work_dir, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
                return { ok: true };
            } catch (e) {
                return { ok: false, stderr: e.stderr ? e.stderr.toString() : e.message };
            }
        };

        // Attempt 1: target + referenced siblings. Attempt 2: target alone.
        let compileRes = tryCompile([reportFile.java_path, ...stagedSiblings]);
        let compileNote = null;
        if (!compileRes.ok) {
            const fallback = tryCompile([reportFile.java_path]);
            if (fallback.ok) {
                compileRes = fallback;
                compileNote = stagedSiblings.length > 0
                    ? `Note: compiled target alone (${stagedSiblings.length} referenced sibling class(es) failed to compile — cross-class calls may fail at runtime).`
                    : null;
            }
        }

        if (!compileRes.ok) {
            result.java = { ok: false, output: '', error: 'Compilation failed:\n' + compileRes.stderr };
            return;
        }

        const RUN_TIMEOUT_MS = 5000;
        const start = Date.now();
        const run = spawnSync('java', ['-cp', reportFile.work_dir, javaClass], {
            cwd: reportFile.work_dir,
            timeout: RUN_TIMEOUT_MS,
            encoding: 'utf-8',
            input: userInput,
            maxBuffer: 10 * 1024 * 1024
        });
        const dur = Date.now() - start;
        let output = (run.stdout || '').trim();
        if (run.stderr && run.stderr.trim()) output += (output ? '\n' : '') + run.stderr.trim();

        const wasTimedOut =
            (run.signal === 'SIGTERM' || run.error && /ETIMEDOUT|timed/i.test(run.error.message || '')) ||
            dur >= RUN_TIMEOUT_MS - 100;

        if (wasTimedOut) {
            output = (output || '[no output before timeout]') +
                `\n\n[Program did not exit within ${RUN_TIMEOUT_MS}ms — likely stuck in an input/validation loop.]`;
        } else if (output.length > 8000) {
            output = output.slice(0, 8000) + '\n\n[…output truncated — program produced ' + output.length + ' bytes. It may be stuck in an input loop.]';
        }

        result.java = {
            ok: !wasTimedOut && (run.status === 0 || output.length > 0),
            exitCode: run.status,
            duration: dur,
            output: (compileNote ? compileNote + '\n\n' : '') + (output || '[no output]'),
            timedOut: wasTimedOut,
            error: run.error
                ? (run.error.message.includes('ENOBUFS')
                    ? 'Output exceeded buffer (program likely in an input loop)'
                    : (wasTimedOut ? null : run.error.message))
                : null
        };
    } catch (err) {
        result.java = { ok: false, output: '', error: err.message };
    }
}

// --- COBOL --------------------------------------------------------------
// Pre-flight DB2/CICS/IMS/MQ check → compile every sibling as a CALLable
// module (-m) → compile target as executable (-x) → run with 5s timeout.
// See the module-level docstring for the full strategy.
function runCobol(result, reportFile, conversion, userInput, dataAssignments, helpers) {
    const { preprocessCobolSource, stageDataFilesInto, lookupCobolTypo, editDistance, log } = helpers;

    if (!(reportFile.source_path && fs.existsSync(reportFile.source_path))) {
        result.cobol = { ok: false, output: '', error: 'COBOL source file not found' };
        return;
    }

    try {
        let hasCobc = false;
        try { execSync('which cobc', { stdio: 'ignore' }); hasCobc = true; } catch {}
        if (!hasCobc) {
            result.cobol = {
                ok: false,
                output: '',
                error: 'GnuCOBOL (cobc) is not installed on this server. Install with `brew install gnu-cobol` to enable native COBOL execution.'
            };
            return;
        }

        // Pre-check: if the source uses DB2/CICS/IMS constructs, short-circuit
        // with a clean message — cobc literally cannot compile those without
        // a mainframe preprocessor.
        let cobolPrecheckSkip = null;
        try {
            const srcText = fs.readFileSync(reportFile.source_path, 'utf-8');
            const execHit = srcText.match(/\bEXEC\s+(SQL|CICS|DLI|MQ)\b/i);
            if (execHit) {
                const kind = execHit[1].toUpperCase();
                cobolPrecheckSkip = {
                    kind,
                    message: 'COBOL cannot run locally: requires mainframe preprocessor ('
                        + (kind === 'SQL'  ? 'DB2 precompiler — `db2 prep` / `dsnhpc`'
                         : kind === 'CICS' ? 'CICS translator — `DFHECP1$` / `cicstran`'
                         : kind === 'DLI'  ? 'IMS DLI — `DFSRRC00` load + DLI preprocessor'
                         :                   'MQ preprocessor')
                        + ').\n\n'
                        + 'GnuCOBOL has no preprocessor for ' + kind + ' directives. The Java\n'
                        + 'conversion below simulates these constructs with TODO markers so\n'
                        + 'you can read the business logic; the AI verdict above shows the\n'
                        + 'best available semantic comparison.\n\n'
                        + 'To run the COBOL for a true runtime compare, deploy on a z/OS or\n'
                        + 'a mainframe-emulator environment with the required preprocessor.'
                };
            }
        } catch {}

        const cobolWork = path.join(os.tmpdir(), `cobrun_${Date.now()}`);
        fs.mkdirSync(cobolWork, { recursive: true });
        const binPath = path.join(cobolWork, 'cobprog');

        const allCobolSources = (conversion.result.report.files || [])
            .filter(f => f.source_path && /\.(cob|cbl|cobol)$/i.test(f.source_path) && fs.existsSync(f.source_path))
            .map(f => f.source_path);

        // Extract PROGRAM-ID from every source. We compile EVERY sibling as
        // a CALLable module regardless of whether it has a USING clause.
        const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
        const sourceInfo = [];
        for (const s of allCobolSources) {
            try {
                const src = fs.readFileSync(s, 'utf-8');
                const m = src.match(programIdRe);
                sourceInfo.push({ path: s, programId: m ? m[1] : null });
            } catch { sourceInfo.push({ path: s, programId: null }); }
        }

        let compiled = false;
        const hasMultiple = allCobolSources.length > 1;

        if (cobolPrecheckSkip) {
            result.cobol = {
                ok: false,
                output: '',
                error: cobolPrecheckSkip.message,
                requiresPrecompile: cobolPrecheckSkip.kind
            };
            log('cobol-compile', 'skipped-precompile', {
                file: reportFile.path,
                kind: cobolPrecheckSkip.kind
            });
        }

        // Preprocessor mod tracking — header periods, typo rewrites, dangling
        // END-IF fixes. Counts surface in the error footer if compile fails.
        const preprocessMods = { periodsAdded: 0 };
        const preprocessSource = (srcPath) => preprocessCobolSource(srcPath, cobolWork, preprocessMods);

        // Copybook include paths for cobc: target's dir + every dir
        // containing a .cpy file + conventional repo-root dirs.
        const cpyDirs = new Set();
        cpyDirs.add(path.dirname(reportFile.source_path));
        for (const f of (conversion.result.report.files || [])) {
            if (f.source_path && /\.(cpy|copy)$/i.test(f.source_path)) {
                cpyDirs.add(path.dirname(f.source_path));
            }
        }
        if (conversion.inputPath) {
            for (const candidate of ['cpy', 'copybooks', 'copy', 'include']) {
                const p = path.join(conversion.inputPath, candidate);
                if (fs.existsSync(p) && fs.statSync(p).isDirectory()) cpyDirs.add(p);
            }
        }
        const includeFlags = [...cpyDirs].map(d => `-I "${d}"`).join(' ');

        const COBC_DIALECTS = [
            `-std=mf -frelax-syntax-checks -Wno-obsolete ${includeFlags}`,
            `-frelax-syntax-checks -Wno-obsolete ${includeFlags}`,
            includeFlags
        ];

        // Compile every sibling as a shared module so CALL 'FOO' resolves.
        if (hasMultiple && !result.cobol) {
            for (const info of sourceInfo) {
                if (info.path === reportFile.source_path) continue;
                const pid = info.programId;
                const srcToUse = preprocessSource(info.path);
                let ok = false;
                for (const dialect of COBC_DIALECTS) {
                    if (ok) break;
                    for (const fmt of ['-free', '-fixed']) {
                        try {
                            if (pid) {
                                execSync(`cobc -m ${fmt} ${dialect} -o "${path.join(cobolWork, pid)}" "${srcToUse}"`, {
                                    cwd: cobolWork, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
                                });
                            } else {
                                execSync(`cobc -m ${fmt} ${dialect} "${srcToUse}"`, {
                                    cwd: cobolWork, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
                                });
                            }
                            ok = true;
                            break;
                        } catch {}
                    }
                }
            }
        }

        // Compile the requested file as executable (-x).
        const entryFile = preprocessSource(reportFile.source_path);
        let lastErr = '';
        for (const dialect of COBC_DIALECTS) {
            if (compiled || result.cobol) break;
            for (const fmt of ['-free', '-fixed']) {
                try {
                    execSync(`cobc -x ${fmt} ${dialect} -o "${binPath}" "${entryFile}"`, {
                        cwd: cobolWork, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
                    });
                    compiled = true;
                    break;
                } catch (compileErr) {
                    const errMsg = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                    lastErr = errMsg;
                    if (errMsg.includes('USING clause') || errMsg.includes('PROCEDURE/ENTRY has USING')) {
                        result.cobol = {
                            ok: false,
                            output: '',
                            error: 'This is a subroutine (PROCEDURE DIVISION USING) — no standalone main program was found in this conversion to link against.'
                        };
                        break;
                    }
                }
            }
        }

        if (!compiled && !result.cobol) {
            log('cobol-compile', 'failed', {
                file: reportFile.path,
                error: (lastErr || '').slice(0, 1500)
            });

            // Typo hint: priority 1 = curated dictionary, priority 2 =
            // edit-distance fuzzy match against 01/05/FD/SD identifiers
            // in the same file. Threshold scales with ID length.
            let typoHint = '';
            let typoFix = null;
            const undefMatch = /'([A-Z0-9_-]+)'\s+is\s+not\s+defined/i.exec(lastErr);
            if (undefMatch) {
                try {
                    const bad = undefMatch[1];
                    const curated = lookupCobolTypo(bad);
                    if (curated) {
                        typoHint = `\n\nKnown typo: \`${bad}\` should be \`${curated}\`. Edit the COBOL to use the canonical name.`;
                        typoFix = { bad, suggestion: curated, source: 'dictionary' };
                        log('cobol-compile', 'typo-hint', { bad, suggestion: curated, source: 'dictionary', file: reportFile.path });
                    } else {
                        const src = fs.readFileSync(reportFile.source_path, 'utf-8');
                        const idents = new Set();
                        const idRe = /^\s*(?:\d+\s+)?(?:FD|SD|\d{2})\s+([A-Z][A-Z0-9_-]*)/gim;
                        let im;
                        while ((im = idRe.exec(src)) !== null) idents.add(im[1].toUpperCase());
                        const badU = bad.toUpperCase();
                        const maxDist = badU.length >= 7 ? 2 : 1;
                        const hit = [...idents].find(i => i !== badU && editDistance(i, badU) <= maxDist);
                        if (hit) {
                            typoHint = `\n\nHint: \`${bad}\` is not defined, but \`${hit}\` is — likely a typo in the source file. Edit the COBOL and change \`${bad}\` → \`${hit}\`.`;
                            typoFix = { bad, suggestion: hit, source: 'edit-distance' };
                            log('cobol-compile', 'typo-hint', { bad, suggestion: hit, source: 'edit-distance', file: reportFile.path });
                        }
                    }
                } catch {}
            }

            const modsParts = [];
            if (preprocessMods.periodsAdded) {
                modsParts.push(`${preprocessMods.periodsAdded} header-period fix(es)`);
            }
            if (preprocessMods.typosFixed && preprocessMods.typosFixed.length) {
                const uniq = [...new Set(preprocessMods.typosFixed.map(t => `${t.bad}→${t.suggestion}`))];
                modsParts.push(`typo fix(es): ${uniq.join(', ')}`);
            }
            if (preprocessMods.endifDanglingFixed) {
                modsParts.push(`${preprocessMods.endifDanglingFixed} dangling END-IF fix(es)`);
            }
            const modsNote = modsParts.length
                ? `\n\nPreprocessor mods applied: ${modsParts.join('; ')}.`
                : '';
            result.cobol = {
                ok: false,
                output: '',
                error: 'COBOL compile failed (tried all dialect/format combinations):\n' + lastErr + typoHint + modsNote,
                typoFix
            };
        } else if (compiled) {
            log('cobol-compile', 'ok', {
                file: reportFile.path,
                periodsAdded: preprocessMods.periodsAdded
            });
        }

        if (!result.cobol && compiled) {
            // libcob resolves SELECT-ASSIGN relative to cwd, so we need the
            // input data staged in cobolWork too (not just the Java dir).
            stageDataFilesInto(cobolWork, dataAssignments);

            const RUN_TIMEOUT_MS = 5000;
            const start = Date.now();
            const run = spawnSync(binPath, [], {
                cwd: cobolWork,
                timeout: RUN_TIMEOUT_MS,
                encoding: 'utf-8',
                input: userInput,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, COB_LIBRARY_PATH: cobolWork }
            });
            const dur = Date.now() - start;
            let output = (run.stdout || '').trim();
            if (run.stderr && run.stderr.trim()) output += (output ? '\n' : '') + run.stderr.trim();

            const wasTimedOut =
                (run.signal === 'SIGTERM' || run.error && /ETIMEDOUT|timed/i.test(run.error.message || '')) ||
                dur >= RUN_TIMEOUT_MS - 100;

            if (wasTimedOut) {
                const hint = `\n\n[Program did not exit within ${RUN_TIMEOUT_MS}ms — likely stuck in an input/validation loop.\n` +
                             ` The provided stdin may not match the prompts the program was waiting on.\n` +
                             ` Try again with more explicit inputs (e.g. newline-separated values covering every ACCEPT) via the stdin box.]`;
                output = (output || '[no output before timeout]') + hint;
            } else if (output.length > 8000) {
                output = output.slice(0, 8000) + '\n\n[…output truncated — program produced ' + output.length + ' bytes. It may be stuck in an input loop.]';
            }

            result.cobol = {
                ok: !wasTimedOut && (run.status === 0 || output.length > 0),
                exitCode: run.status,
                duration: dur,
                output: output || '[no output]',
                timedOut: wasTimedOut,
                error: run.error
                    ? (run.error.message.includes('ENOBUFS')
                        ? 'Output exceeded buffer (program likely in an input loop)'
                        : (wasTimedOut ? null : run.error.message))
                    : null,
                // Internal hint for listOutputFiles; stripped before send.
                _workDir: cobolWork
            };
        }
    } catch (err) {
        result.cobol = { ok: false, output: '', error: err.message };
    }
}

module.exports = { mount };
