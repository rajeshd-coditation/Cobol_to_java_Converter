/**
 * Pure-ish helpers for convert-azure.js processFile.
 *
 * Phase 3b of the /api/convert-azure extraction. Each helper takes its
 * inputs explicitly and returns a value — no closure capture of the
 * running conversion's mutable state. Three of the four mutate nothing at
 * all; buildContext() mutates a copybook-body cache it receives by ref
 * (that cache is explicitly shared across files in a wave to avoid
 * re-reading the same .cpy files thousands of times).
 *
 * Each helper is thin — the goal is readability, not reuse. processFile
 * stays as the orchestrator. Keeping these in a sibling file rather than
 * embedding them inside convert-azure.js means a future maintainer can
 * unit-test any stage in isolation without spinning up a full conversion.
 */

const fs = require('fs');
const path = require('path');

/**
 * Preflight gates that run before any AI call. Returns a fileResult-shape
 * object if the file must be skipped, or null to continue.
 *
 * Captures conversion.cancelled, tokenBudget overrun, "is this a
 * copybook masquerading as a program", tiny-file skip, truncated-source
 * detection, and the oversize-source ceiling (with divisional-split
 * attempt before giving up).
 *
 * Returning a fileResult here instead of throwing keeps the caller's
 * control flow linear — processFile just checks `if (skip) return skip`.
 */
function preflightCheck(args) {
    const {
        relativePath, baseName, cobolPath, cobolSource,
        conversion,
        isLikelyTruncated,
        isDivisionalSplitEnabled,
        splitAtProcedureDivision,
        pushTimeline
    } = args;

    if (conversion.cancelled) {
        conversion.fileStates[relativePath] = 'skipped';
        return {
            outcome: 'skip',
            fileResult: { relativePath, baseName, cobolPath, status: 'skipped_cancelled', reportEntry: null }
        };
    }

    if (conversion.tokenBudget > 0 && conversion.tokens.total >= conversion.tokenBudget) {
        conversion.fileStates[relativePath] = 'skipped';
        return {
            outcome: 'skip',
            fileResult: {
                relativePath, baseName, cobolPath,
                status: 'error',
                error: `Token budget exceeded (${conversion.tokens.total} / ${conversion.tokenBudget})`,
                reportEntry: {
                    path: relativePath,
                    source_path: cobolPath,
                    java_status: 'SKIPPED_BUDGET',
                    error: `Token budget of ${conversion.tokenBudget} reached; ${conversion.tokens.total} tokens used. Set MAX_TOKENS_PER_CONVERSION=0 to disable the cap.`
                }
            }
        };
    }

    // No PROGRAM-ID → likely a copybook. AI would fabricate one.
    if (!cobolSource.match(/PROGRAM-ID/i)) {
        return {
            outcome: 'skip',
            fileResult: {
                relativePath, baseName, cobolPath,
                status: 'skipped_noid',
                reportEntry: { path: relativePath, source_path: cobolPath, java_status: 'SKIPPED_NO_ID' }
            }
        };
    }

    if (cobolSource.trim().length < 50) {
        return {
            outcome: 'skip',
            fileResult: {
                relativePath, baseName, cobolPath,
                status: 'skipped_small',
                reportEntry: { path: relativePath, source_path: cobolPath, java_status: 'SKIPPED_NO_ID' }
            }
        };
    }

    // Truncation gate (§13). Better to skip with a note than let the
    // model invent a plausible ending we can't validate.
    const integrity = isLikelyTruncated(cobolSource);
    if (integrity.truncated) {
        return {
            outcome: 'skip',
            fileResult: {
                relativePath, baseName, cobolPath,
                status: 'skipped_incomplete',
                error: integrity.reason,
                reportEntry: {
                    path: relativePath,
                    source_path: cobolPath,
                    java_status: 'SKIPPED_INCOMPLETE_SOURCE',
                    error: integrity.reason,
                    sourceBytes: cobolSource.length
                }
            }
        };
    }

    // Oversize: either skip outright, or attempt divisional split at
    // PROCEDURE DIVISION. Flag set via env so demo runs don't double-spend
    // tokens on big files by default.
    const MAX_COBOL_CHARS = parseInt(process.env.MAX_COBOL_CHARS || '80000', 10);
    let divisionalSplit = null;
    if (cobolSource.length > MAX_COBOL_CHARS) {
        if (isDivisionalSplitEnabled()) {
            divisionalSplit = splitAtProcedureDivision(cobolSource);
        }
        if (!divisionalSplit) {
            const hint = isDivisionalSplitEnabled()
                ? ' Divisional split attempted but failed — no clean PROCEDURE DIVISION boundary detected.'
                : ' Set ENABLE_DIVISIONAL_SPLIT=1 to attempt a two-pass DATA/PROCEDURE split, or raise MAX_COBOL_CHARS for a larger-context deployment.';
            const error = `Source is ${cobolSource.length} chars — exceeds ${MAX_COBOL_CHARS}-char cap for a single-pass conversion.${hint}`;
            return {
                outcome: 'skip',
                fileResult: {
                    relativePath, baseName, cobolPath,
                    status: 'error',
                    error,
                    reportEntry: {
                        path: relativePath,
                        source_path: cobolPath,
                        java_status: 'SKIPPED_TOO_LARGE',
                        error,
                        sourceBytes: cobolSource.length
                    }
                }
            };
        }
        pushTimeline(relativePath, 'split', `Source is ${cobolSource.length} chars — splitting at PROCEDURE DIVISION`, {
            partABytes: divisionalSplit.partA.length,
            partBBytes: divisionalSplit.partB.length
        });
    }

    return { outcome: 'continue', divisionalSplit };
}

/**
 * Assemble the context object handed to azureAgent.convertCobolToJava.
 *
 * Pulls CALL/COPY references from the source, builds a PROGRAM-ID → Java
 * class map across the whole conversion graph, inlines copybook bodies
 * (size-capped at 40KB to keep the prompt within context budget), and
 * gathers JCL invocations both by basename and by PROGRAM-ID.
 *
 * `copybookBodyCache` is mutated — that cache lives on the closure so
 * other files in the same wave reuse it. `toPascalCase` is passed as
 * an arg to keep this module free of project-specific name imports.
 */
function buildContext(args) {
    const {
        cobolSource, baseName,
        conversion,
        copybookPathByName,
        copybookBodyCache,
        toPascalCase
    } = args;

    const _callRe = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
    const _copyRe = /COPY\s+['"]?([A-Z0-9_-]+)['"]?/gi;
    const calledPrograms = [];
    const copybooks = [];
    const _seenCalls = new Set();
    const _seenCopy = new Set();
    let _m;
    while ((_m = _callRe.exec(cobolSource)) !== null) {
        const n = _m[1].toUpperCase();
        if (!_seenCalls.has(n)) { _seenCalls.add(n); calledPrograms.push(n); }
    }
    while ((_m = _copyRe.exec(cobolSource)) !== null) {
        const n = _m[1].toUpperCase();
        if (!_seenCopy.has(n)) { _seenCopy.add(n); copybooks.push(n); }
    }

    // PROGRAM-ID → Java class map. Derived from every program node in
    // the graph via toPascalCase(basename), then overlaid with any file
    // whose PROGRAM-ID differs from its basename (CBL0033.cbl with
    // PROGRAM-ID. PAYROL00. is the canonical example).
    const programIdToJavaClass = {};
    const gNodes = (conversion.graph && conversion.graph.nodes) || [];
    for (const n of gNodes) {
        if (n.type !== 'program') continue;
        const base = path.basename(n.path || n.id, path.extname(n.path || n.id));
        programIdToJavaClass[base.toUpperCase()] = toPascalCase(base);
    }
    const _pidRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
    for (const n of gNodes) {
        if (n.type !== 'program' || !n.path) continue;
        try {
            const src = fs.readFileSync(n.path, 'utf-8');
            const mm = src.match(_pidRe);
            if (mm) {
                const base = path.basename(n.path, path.extname(n.path));
                if (!programIdToJavaClass[mm[1].toUpperCase()]) {
                    programIdToJavaClass[mm[1].toUpperCase()] = toPascalCase(base);
                }
            }
        } catch {}
    }

    // Copybook bodies — inline every referenced .cpy we can find on
    // disk. Cached across files in the wave. Payload is size-capped
    // so a repo of 200 programs COPYing 50 large copybooks doesn't blow
    // past the deployment's context window.
    const copybookBodies = {};
    const MAX_COPYBOOK_PAYLOAD = 40000;
    let copybookPayloadSize = 0;
    const loadOrder = copybooks
        .map(name => ({ name, p: copybookPathByName[name.toUpperCase()] }))
        .filter(e => e.p);
    for (const { name, p } of loadOrder) {
        const key = name.toUpperCase();
        let body = copybookBodyCache[key];
        if (body === undefined) {
            try { body = fs.readFileSync(p, 'utf-8'); }
            catch { body = null; }
            copybookBodyCache[key] = body;
        }
        if (!body) continue;
        if (copybookPayloadSize + body.length > MAX_COPYBOOK_PAYLOAD) continue;
        copybookBodies[key] = body;
        copybookPayloadSize += body.length;
    }

    // JCL invocations: this program may be referenced by basename OR by
    // any declared PROGRAM-ID. Collect both paths, dedupe by file+step.
    const jclByProgram = conversion.jclContext || {};
    const jclInvocations = [];
    const seenJcl = new Set();
    const addJclFor = (key) => {
        const invs = jclByProgram[key.toUpperCase()];
        if (!invs) return;
        for (const inv of invs) {
            const fp = `${inv.jclFile}::${inv.stepName}`;
            if (seenJcl.has(fp)) continue;
            seenJcl.add(fp);
            jclInvocations.push(inv);
        }
    };
    addJclFor(baseName);
    const _pidOwn = cobolSource.match(/^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)/im);
    if (_pidOwn) addJclFor(_pidOwn[1]);

    return {
        calledPrograms,
        copybooks,
        programIdToJavaClass,
        copybookBodies,
        jclInvocations
    };
}

/**
 * Thread reviewer notes from earlier files in this batch into the next
 * file's conversion context. Takes up to the 5 most recent reject/edit
 * notes — more than that is usually prompt drift (the model is making
 * the same mistake on everything), not per-file signal.
 */
function extractReviewerFeedback(reviewHistory, currentRelativePath) {
    return (reviewHistory || [])
        .filter(h => (h.action === 'reject' || h.action === 'edit') && h.note && h.fileId !== currentRelativePath)
        .slice(-5)
        .map(h => ({
            fileBasename: (h.fileId || '').split('/').pop(),
            action: h.action,
            note: h.note
        }));
}

/**
 * Pull the primary non-main public method signature out of the final
 * Java source. The next wave's callers read this so `new Foo().run(...)`
 * gets the real parameter list instead of a guess.
 *
 * Returns the full signature string (e.g. `public void run(String arg)`)
 * or null if nothing matches. Non-throwing — regex misses are normal.
 */
function extractEntrySignature(javaCode, javaClassName) {
    try {
        const sigRe = /public\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(([^)]*)\)/g;
        const sigs = [];
        let sm;
        while ((sm = sigRe.exec(javaCode)) !== null) {
            sigs.push({ name: sm[1], args: sm[2].trim(), full: sm[0].trim() });
        }
        const entrySig = sigs.find(s => s.name !== 'main' && s.name !== javaClassName)
            || sigs.find(s => s.name === 'main')
            || sigs[0];
        return entrySig ? entrySig.full : null;
    } catch {
        return null;
    }
}

/**
 * javac + java on a single converted file.
 *
 * Strategy: compile the target .java with `javaDir` on the classpath so
 * cross-file `new Sibling().run(...)` references resolve to already-
 * converted siblings in the same batch. Run with the same classpath at
 * a 10s timeout, capturing stdout+stderr together. Writes java_output.txt
 * and native_output.txt into the per-file work dir so the UI's Run panel
 * can show what happened even before the user clicks Run.
 *
 * Pure in the functional sense — only touches `workDir` on disk. All
 * class identity comes in via args; no closure.
 *
 * Returns { javaOutput, compareStatus, compilationError } where
 * compareStatus is 'MATCH' on non-empty output or 'JAVA_ONLY' otherwise,
 * and compilationError is non-null when javac failed.
 */
async function compileAndRun({ javaDir, workDir, javaFileName, javaClassName }) {
    const path = require('path');
    const fs = require('fs');
    const { execSync, spawnSync } = require('child_process');

    const javaFileInWorkDir = path.join(workDir, javaFileName);
    let javaOutput = '';
    let compareStatus = 'JAVA_ONLY';
    let compilationError = null;
    try {
        try {
            // javaDir on the classpath resolves `new Sibling().run(...)`
            // across files in the same batch. workDir stays the primary
            // output dir so the per-file Run panel has everything local.
            execSync(`javac -cp "${javaDir}" -d "${workDir}" "${javaFileInWorkDir}"`, {
                cwd: workDir,
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            try {
                const result = spawnSync('java', ['-cp', workDir + path.delimiter + javaDir, javaClassName], {
                    cwd: workDir,
                    timeout: 10000,
                    encoding: 'utf-8',
                    shell: false,
                    input: '\n\n\n'
                });
                const stdout = result.stdout || '';
                const stderr = result.stderr || '';
                const exitCode = result.status;
                let combinedOutput = '';
                if (stdout.trim()) combinedOutput = stdout.trim();
                if (stderr.trim()) {
                    combinedOutput = combinedOutput
                        ? combinedOutput + '\n' + stderr.trim()
                        : stderr.trim();
                }
                if (combinedOutput.length > 0) {
                    javaOutput = combinedOutput;
                    compareStatus = 'MATCH';
                } else if (exitCode === 0) {
                    javaOutput = '[Program executed successfully but produced no console output]';
                } else if (result.error) {
                    const errMsg = result.error.message || '';
                    javaOutput = (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout'))
                        ? '[Program timed out - may require interactive input]'
                        : `[Runtime Error] ${errMsg}`;
                } else {
                    javaOutput = `[Program exited with code ${exitCode}]`;
                }
            } catch (runErr) {
                javaOutput = `[Runtime Error] ${runErr.message}`;
            }
        } catch (compileErr) {
            compilationError = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
            javaOutput = `[Compilation Error]\n${compilationError}`;
        }
        fs.writeFileSync(path.join(workDir, 'java_output.txt'), javaOutput);
        fs.writeFileSync(path.join(workDir, 'native_output.txt'),
            'COBOL native execution not available (requires mainframe environment)');
    } catch (execErr) {
        javaOutput = `[Execution Error] ${execErr.message}`;
        fs.writeFileSync(path.join(workDir, 'java_output.txt'), javaOutput);
    }
    return { javaOutput, compareStatus, compilationError };
}

/**
 * Orchestrate compile → accuracy → maybe-repair → recompile.
 *
 * Mirrors the original inline flow without changing behavior. When the
 * initial javac fails OR the accuracy scorer flags a fabricated-input
 * fallback, fire exactly one repair pass via fixJavaCodeFn (the repair
 * prompt already covers both cases — "COMPILES cleanly" AND "REMOVE
 * FABRICATED INPUT DATA"). Bypassed entirely when DISABLE_AUTOFIX=1 is
 * set — that's the A/B arm for measuring raw-AI output quality.
 *
 * On successful repair, re-writes the Java to disk, recompiles, reruns,
 * re-scores, and accumulates the repair call's token usage. On repair
 * failure, returns the initial state with a repair_failed timeline
 * event already pushed.
 *
 * pushTimeline is a thin wrapper the caller provides that writes a
 * phase entry to the per-file timeline. Passing it in (instead of
 * closing over) keeps this helper testable in isolation.
 *
 * Returns the final state: { javaCode, javaOutput, compareStatus,
 *   compilationError, accuracyResult, repairApplied }.
 */
async function runCompileAndRepair(args) {
    const path = require('path');
    const fs = require('fs');
    const {
        relativePath, baseName, javaClassName,
        javaDir, javaPath, workDir, javaFileName,
        initialJavaCode,
        cobolSource, programIdToJavaClass,
        conversion,
        azureAgent, normalizeClassName,
        pushTimeline, startMs
    } = args;

    let fixedJavaCode = initialJavaCode;

    // Initial compile + run.
    const _tCompile = Date.now();
    pushTimeline(relativePath, 'compile', 'Running javac + java to verify');
    const run1 = await compileAndRun({ javaDir, workDir, javaFileName, javaClassName });
    let { javaOutput, compareStatus, compilationError } = run1;
    pushTimeline(relativePath, 'compile_done', compilationError ? 'javac: FAIL' : 'javac: OK', {
        ms: Date.now() - _tCompile,
        compileStatus: compilationError ? 'fail' : 'ok',
        errorPreview: compilationError ? String(compilationError).split('\n').slice(0, 2).join(' | ').slice(0, 200) : null
    });

    // Initial accuracy score (cheap; regex-based).
    let accuracyResult = azureAgent.analyzeConversionAccuracy(cobolSource, fixedJavaCode);
    pushTimeline(relativePath, 'accuracy', 'Accuracy scored', {
        accuracy: accuracyResult.accuracy,
        penalties: (accuracyResult.semanticPenalties || []).length
    });

    // Repair-gate: compile-fail OR fabricated-fallback. Single repair
    // pass; the prompt covers both cases at once.
    const penalties = accuracyResult.semanticPenalties || [];
    const hasFabricatedFallback = penalties.includes('Fabricated input fallback');
    const needsRepair = process.env.DISABLE_AUTOFIX !== '1'
        && (compilationError || hasFabricatedFallback)
        && azureAgent.isAvailable();
    let repairApplied = null;

    if (needsRepair) {
        repairApplied = compilationError && hasFabricatedFallback
            ? 'compile+fallback'
            : (compilationError ? 'compile' : 'fallback');
        console.log(`    Auto-repair pass for ${relativePath} (${repairApplied})`);
        pushTimeline(relativePath, 'repair', 'Auto-repair triggered: ' + repairApplied);
        // Cached /api/run capture of the COBOL side (if the user ran this
        // file once already) gives the repair agent real target behavior
        // to match. Null on a fresh conversion — the repair prompt's
        // cobolOutput is optional.
        const priorRun = (conversion._lastRun && conversion._lastRun[relativePath]) || {};
        try {
            const repair = await azureAgent.fixJavaCode({
                javaCode: fixedJavaCode,
                cobolSource,
                compileErrors: compilationError || null,
                runOutput: javaOutput,
                cobolOutput: priorRun.cobolOutput || null,
                dependencies: programIdToJavaClass
            });
            if (repair && repair.success && repair.javaCode) {
                // Re-normalize the class name — the repair agent usually
                // preserves it, but a mismatch after repair breaks the
                // `java -cp workDir <javaClassName>` invocation.
                fixedJavaCode = normalizeClassName(repair.javaCode, javaClassName, baseName);
                fs.writeFileSync(javaPath, fixedJavaCode);
                fs.writeFileSync(path.join(workDir, javaFileName), fixedJavaCode);
                if (repair.usage) {
                    conversion.tokens.promptIn     += repair.usage.prompt_tokens || 0;
                    conversion.tokens.completionOut += repair.usage.completion_tokens || 0;
                    conversion.tokens.total        += repair.usage.total_tokens || 0;
                    conversion.tokens.calls        += 1;
                }
                const run2 = await compileAndRun({ javaDir, workDir, javaFileName, javaClassName });
                javaOutput       = run2.javaOutput;
                compareStatus    = run2.compareStatus;
                compilationError = run2.compilationError;
                accuracyResult   = azureAgent.analyzeConversionAccuracy(cobolSource, fixedJavaCode);
                pushTimeline(relativePath, 'repair_done',
                    compilationError ? 'Repair applied, still fails javac' : 'Repair fixed javac failure', {
                        compileStatus: compilationError ? 'fail' : 'ok',
                        tokens: repair.usage ? (repair.usage.total_tokens || null) : null,
                        accuracy: accuracyResult.accuracy
                    });
            } else {
                console.warn(`   [warn]  Repair pass failed: ${repair && repair.error}`);
                pushTimeline(relativePath, 'repair_failed', 'Repair call did not return usable Java', {
                    error: (repair && repair.error) || 'unknown'
                });
            }
        } catch (repairErr) {
            console.warn(`   [warn]  Repair pass errored: ${repairErr.message}`);
            pushTimeline(relativePath, 'repair_errored', 'Repair call errored', { error: repairErr.message });
        }
    }

    pushTimeline(relativePath, 'done', compilationError ? 'COMPILE_FAIL' : 'SUCCESS', {
        totalMs: Date.now() - startMs
    });

    return {
        javaCode: fixedJavaCode,
        javaOutput,
        compareStatus,
        compilationError,
        accuracyResult,
        repairApplied
    };
}

/**
 * Build the report entry object for a successful or compile-failed file.
 *
 * Pure. The two variants share most fields; the split keeps the caller's
 * control flow simple (COMPILE_FAIL path has `error`, SUCCESS path
 * doesn't).
 */
function buildReportEntry({
    success,
    relativePath, cobolPath, javaPath, workDir,
    compareStatus, repairApplied, accuracyResult,
    compilationError
}) {
    const base = {
        path: relativePath,
        source_path: cobolPath,
        java_path: javaPath,
        work_dir: workDir,
        compare: compareStatus,
        method: 'azure_ai',
        repair_applied: repairApplied,
        conversionAccuracy: accuracyResult.accuracy,
        accuracyDetails: accuracyResult.details,
        accuracyBreakdown: {
            cobolMetrics: accuracyResult.cobolMetrics,
            javaMetrics: accuracyResult.javaMetrics,
            semanticPenalties: accuracyResult.semanticPenalties || []
        }
    };
    if (success) {
        return Object.assign(base, { java_status: 'SUCCESS' });
    }
    return Object.assign(base, { java_status: 'COMPILE_FAIL', error: compilationError });
}

module.exports = {
    preflightCheck,
    buildContext,
    extractReviewerFeedback,
    extractEntrySignature,
    compileAndRun,
    runCompileAndRepair,
    buildReportEntry
};
