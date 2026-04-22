/**
 * POST /api/convert-azure — the AI conversion worker.
 *
 * Factored out of server.js in Phase 3d. The handler body is substantial
 * (~1250 lines, 30-step pipeline) with deep shared closure state across
 * processFile + the wave loop + sibling-signature cache + HITL Promise
 * plumbing. Rather than splinter the internals, the whole closure moved
 * verbatim into this module; dependencies it previously captured by
 * lexical scope are now passed as named arguments via createHandler(deps).
 *
 * Why factory + not mount(): the /api/resume route (src/routes/resume.js)
 * reuses the same handler to drive a resumed conversion. Exposing the
 * raw handler fn lets resume.js construct a fake req/res and call the
 * handler directly without an HTTP round-trip.
 *
 * Usage from server.js:
 *   const handler = createHandler(deps);
 *   app.post('/api/convert-azure', handler);
 *   require('./src/routes/resume').mount(app, { ..., convertAzureHandler: handler });
 *
 * Required deps:
 *   - activeConversions             shared in-memory Map
 *   - azureAgent                    facade for convertCobolToJava / fixJavaCode /
 *                                   analyzeConversionAccuracy / isAvailable /
 *                                   scanForAllMainframeFiles
 *   - buildConversionGraph          graph + data-file lookup + JCL context
 *   - globToRegex                   HITL review-glob compiler
 *   - isDivisionalSplitEnabled      env flag for §16 divisional split
 *   - isLikelyTruncated             oversized-source detector
 *   - normalizeClassName            rewrite AI-emitted class name to match file
 *   - parseJcl                      used by buildConversionGraph
 *   - saveCheckpoint                per-wave persistence
 *   - splitAtProcedureDivision
 *   - stitchJava                    divisional-split stitching
 *   - toPascalCase                  COBOL name → Java class name
 *   - validateRepoUrl               URL/path gate
 *   - log                           structured logger from src/util/logger.js
 *
 * Standard Node builtins (path / fs / os / child_process) are imported at
 * the top of this module — the handler does NOT receive those as deps.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    preflightCheck,
    buildContext,
    extractReviewerFeedback,
    extractEntrySignature
} = require('./convert-azure-helpers');

function createHandler(deps) {
    const {
        activeConversions, azureAgent, buildConversionGraph, globToRegex, isDivisionalSplitEnabled, isLikelyTruncated, normalizeClassName, parseJcl, saveCheckpoint, splitAtProcedureDivision, stitchJava, toPascalCase, validateRepoUrl, log
    } = deps;

    const convertAzureHandler = async (req, res) => {
    const { repoUrl, reviewMode, reviewGlob, selectedFiles, resumeState } = req.body;

    const urlCheck = validateRepoUrl(repoUrl);
    if (!urlCheck.ok) {
        return res.status(400).json({ error: urlCheck.error });
    }

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    const conversionId = Date.now().toString();
    // Resumed runs reuse the original outputDir so the Java files already
    // written to disk in the interrupted attempt stay put — the worker only
    // rewrites files it re-converts this time.
    const outputDir = (resumeState && resumeState.outputDir)
        ? resumeState.outputDir
        : path.join(os.tmpdir(), `azure_cobol_output_${conversionId}`);
    const javaDir = path.join(outputDir, 'java');

    // Create output directories
    fs.mkdirSync(javaDir, { recursive: true });

    // Initialize conversion status
    activeConversions.set(conversionId, {
        status: 'running',
        cancelled: false,
        logs: [resumeState
            ? ` Resuming conversion from ${resumeState.resumedFrom || 'previous run'}...\n`
            : ' Starting AI-powered conversion...\n'],
        result: null,
        useAzureAI: true,
        reviewMode: !!reviewMode,
        reviewGlob: reviewGlob || null,
        reviewGlobRe: globToRegex(reviewGlob),
        pendingReview: {}, // fileId -> { cobolSource, javaCode, resolve, queuedAt }
        reviewHistory: (resumeState && Array.isArray(resumeState.reviewHistory))
            ? resumeState.reviewHistory.slice()
            : [], // [{ fileId, action, at, note? }]
        tokens: { promptIn: 0, completionOut: 0, total: 0, calls: 0 },
        // Hard ceiling on total tokens for this conversion. 0 = no cap. Default
        // pulled from env var so demo runs can be kept cheap without a code
        // change. When exceeded, processFile short-circuits with SKIPPED_BUDGET
        // on all remaining files so the user gets a clean partial result
        // instead of runaway cost.
        tokenBudget: parseInt(process.env.MAX_TOKENS_PER_CONVERSION || '0', 10) || 0,
        // Resume plumbing: if the client passed resumedFrom, carry it so the
        // history UI can chain interrupted → new run.
        resumedFrom: (resumeState && resumeState.resumedFrom)
            || (req.body && req.body.resumedFrom)
            || undefined,
        completedLevelIdx: -1,
        totalLevels: 0,
        levelPlan: [],
        outputDir,
        startedAt: Date.now()
    });

    // Process in background
    (async () => {
        const conversion = activeConversions.get(conversionId);
        const results = {
            outputDir,
            totalFiles: 0,
            converted: 0,
            skippedCopybook: 0,
            skippedNoId: 0,
            skippedError: 0,
            failCompile: 0,
            failExec: 0,
            otherFilesCount: 0,  // JCL, data files, etc. (not COBOL - doesn't affect success rate)
            convertedFiles: [],
            skippedFiles: [],
            errorFiles: [],
            report: { files: [], summary: {} }
        };

        try {
            // urlCheck was validated synchronously above; we know the value
            // is safe to shell-interpolate.
            let inputPath = urlCheck.value;

            if (urlCheck.kind === 'url') {
                conversion.logs.push(' Cloning repository...\n');
                const cloneDir = path.join(os.tmpdir(), `repo_${conversionId}`);
                const { execSync } = require('child_process');
                try {
                    execSync(`git clone --depth 1 "${inputPath}" "${cloneDir}"`, { timeout: 60000 });
                    inputPath = cloneDir;
                    conversion.logs.push('[ok] Repository cloned successfully\n');
                } catch (cloneErr) {
                    conversion.logs.push(`[error] Failed to clone repository: ${cloneErr.message}\n`);
                    conversion.status = 'completed';
                    conversion.result = results;
                    return;
                }
            }

            if (!fs.existsSync(inputPath)) {
                conversion.logs.push(`[error] Path not found: ${inputPath}\n`);
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }

            // Scan for ALL mainframe files (COBOL, Copybooks, JCL, data, etc.)
            conversion.logs.push(' Scanning for mainframe files...\n');
            const allFiles = azureAgent.scanForAllMainframeFiles(inputPath);
            let cobolFiles = allFiles.cobolFiles;

            // Pre-conversion HITL: filter to only user-selected files if provided.
            if (Array.isArray(selectedFiles) && selectedFiles.length > 0) {
                const selectedSet = new Set(selectedFiles.map(f => path.normalize(f)));
                const beforeCount = cobolFiles.length;
                cobolFiles = cobolFiles.filter(p => {
                    const rel = path.relative(inputPath, p);
                    return selectedSet.has(rel) || selectedSet.has(p);
                });
                conversion.logs.push(` User selection: converting ${cobolFiles.length} of ${beforeCount} COBOL files\n`);
            }

            // Calculate totals
            const totalMainframeFiles = cobolFiles.length +
                allFiles.copybookFiles.length +
                allFiles.jclFiles.length +
                allFiles.dataFiles.length +
                allFiles.otherFiles.length;

            results.totalFiles = cobolFiles.length;

            // Log file breakdown
            conversion.logs.push(` Found ${totalMainframeFiles} mainframe-related files:\n`);
            conversion.logs.push(`   - COBOL programs: ${cobolFiles.length} (will be converted)\n`);
            if (allFiles.copybookFiles.length > 0) {
                conversion.logs.push(`   - Copybooks (.cpy): ${allFiles.copybookFiles.length} (skipped)\n`);
            }
            if (allFiles.jclFiles.length > 0) {
                conversion.logs.push(`   - JCL files: ${allFiles.jclFiles.length} (skipped)\n`);
            }
            if (allFiles.dataFiles.length > 0) {
                conversion.logs.push(`   - Data files: ${allFiles.dataFiles.length} (skipped)\n`);
            }
            if (allFiles.otherFiles.length > 0) {
                conversion.logs.push(`   - Other files: ${allFiles.otherFiles.length} (skipped)\n`);
            }
            conversion.logs.push('\n');

            // Add other files to skipped list with category labels
            // Note: Only copybooks count towards skippedCopybook (affects success rate)
            // JCL, data, and other files go to otherFilesCount (doesn't affect success rate)
            for (const filePath of allFiles.copybookFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Copybook`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_COPYBOOK'
                });
            }
            results.skippedCopybook = allFiles.copybookFiles.length;

            // JCL files - tracked separately, don't affect COBOL success rate
            for (const filePath of allFiles.jclFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - JCL`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_JCL'
                });
            }
            results.otherFilesCount += allFiles.jclFiles.length;

            // Data files - tracked separately
            for (const filePath of allFiles.dataFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Data File`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_DATA'
                });
            }
            results.otherFilesCount += allFiles.dataFiles.length;

            // Other files - tracked separately
            for (const filePath of allFiles.otherFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Other`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_OTHER'
                });
            }
            results.otherFilesCount += allFiles.otherFiles.length;

            if (cobolFiles.length === 0) {
                conversion.logs.push('[warn] No COBOL files found in the repository\n');
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }

            // Build the dependency graph + data-file lookup + JCL context in
            // one pass → src/core/conversion-graph.js. The worker rebuilds its
            // own PROGRAM-ID map from graph nodes, so fileContents/nameIndex
            // don't need to leak out of the helper.
            const graphBuild = buildConversionGraph({ inputPath, cobolFiles, allFiles, parseJcl });
            conversion.dataFileLookup = graphBuild.dataFileLookup; // used by /api/run
            conversion.jclContext     = graphBuild.jclContextByProgram; // used by processFile
            conversion.graph          = graphBuild.graph;
            conversion.fileStates     = graphBuild.fileStates;
            conversion.currentFiles   = [];
            conversion.inputPath      = inputPath;

            // --- Resume seeding -----------------------------------------
            // If this is a resumed run, replay state from the interrupted
            // checkpoint onto the fresh worker: file states (so the wave
            // loop skips already-done files), prior report rows (so the UI
            // shows the carried-over accuracy numbers), and the sibling
            // signatures cache (so callers in later waves don't regress
            // after we skip re-converting their callees).
            if (resumeState && typeof resumeState === 'object') {
                if (resumeState.fileStates && typeof resumeState.fileStates === 'object') {
                    // Only apply terminal states from the prior run — active /
                    // awaiting_review can't resume (the Promises are gone) and
                    // should re-enter the queue.
                    const terminal = new Set(['done', 'skipped', 'failed']);
                    let seeded = 0;
                    for (const [k, v] of Object.entries(resumeState.fileStates)) {
                        if (terminal.has(v) && k in conversion.fileStates) {
                            conversion.fileStates[k] = v;
                            seeded++;
                        }
                    }
                    conversion.logs.push(`   Seeded ${seeded} file state(s) from prior run\n`);
                }
                if (Array.isArray(resumeState.reportFiles)) {
                    // Pre-populate report rows and counters so the final
                    // summary reflects prior successes. Dedupe by path —
                    // we'll overwrite any prior entry if the resumed run
                    // re-processes that file (stays in terminal state so
                    // it's skipped; but defensively we dedupe anyway).
                    const seenPaths = new Set();
                    for (const entry of resumeState.reportFiles) {
                        if (!entry || !entry.path || seenPaths.has(entry.path)) continue;
                        seenPaths.add(entry.path);
                        results.report.files.push(entry);
                        if (entry.java_status === 'SUCCESS' || entry.java_status === 'JAVA_ONLY') {
                            results.converted++;
                            results.convertedFiles.push(`${entry.path} [AZURE_AI]`);
                        } else if (entry.java_status === 'COMPILE_FAIL' ||
                                   entry.java_status === 'CONVERT_FAIL' ||
                                   entry.java_status === 'FAIL') {
                            results.skippedError++;
                            results.errorFiles.push(`${entry.path} - ${entry.error || 'carried forward'}`);
                        } else if (entry.java_status === 'SKIPPED_NO_ID' ||
                                   entry.java_status === 'SKIPPED_TOO_LARGE' ||
                                   entry.java_status === 'SKIPPED_BUDGET' ||
                                   entry.java_status === 'SKIPPED_CANCELLED') {
                            results.skippedNoId++;
                            results.skippedFiles.push(`${entry.path} - Skipped`);
                        }
                    }
                }
                if (resumeState.siblingSignatures && typeof resumeState.siblingSignatures === 'object') {
                    conversion.siblingSignatures = Object.assign({}, resumeState.siblingSignatures);
                }
                if (resumeState.fileTimeline && typeof resumeState.fileTimeline === 'object') {
                    conversion.fileTimeline = Object.assign({}, resumeState.fileTimeline);
                }
            }


            // Parallel processing configuration. User can override via the
            // settings-cog slider (req.body.batchSize) or the CONVERSION_BATCH_SIZE
            // env var. Defaults to 5, clamped to 1-10 to stay inside typical
            // Azure rate-limit tiers (gpt-4.1-mini default tier maxes around 10
            // concurrent non-trivial requests before 429s start).
            const envBatch = parseInt(process.env.CONVERSION_BATCH_SIZE, 10);
            const requestedBatch = parseInt((req.body && req.body.batchSize), 10);
            const rawBatch = Number.isFinite(requestedBatch) ? requestedBatch
                          : Number.isFinite(envBatch)       ? envBatch
                          : 5;
            const BATCH_SIZE = Math.min(10, Math.max(1, rawBatch));
            conversion.batchSize = BATCH_SIZE; // surfaced in /api/status for the UI

            // Index copybook files by UPPERCASE stem so processFile can look up
            // the actual .cpy path for any `COPY X` reference and inline its
            // body into the AI prompt. Without this, the AI gets only the name
            // "X" and has to guess field names / PIC clauses — which produces
            // wrong Java data classes that then fail compile.
            const copybookPathByName = {};
            for (const p of (allFiles.copybookFiles || [])) {
                const stem = path.basename(p, path.extname(p)).toUpperCase();
                copybookPathByName[stem] = p;
            }
            // Cache of already-read copybook contents so concurrent processFile
            // calls in the same batch don't re-read the same files N times.
            const copybookBodyCache = {};

            // Cache of public method signatures extracted from already-converted
            // Java siblings, keyed by UPPERCASE PROGRAM-ID / basename. Populated
            // AFTER a file is successfully converted (end of processFile) so the
            // NEXT wave's callers see real signatures instead of guessing args.
            // Wave ordering guarantees callees convert before callers.
            conversion.siblingSignatures = conversion.siblingSignatures || {};

            // Per-file timeline for the UI side-panel. Each phase push records
            // `{ step, label, at, ms?, tokens?, meta? }`. Reads via GET /api/graph/:id.
            // Kept compact — max ~15 entries per file is typical (convert →
            // compile → [repair] → score → persist).
            conversion.fileTimeline = conversion.fileTimeline || {};
            const pushTimeline = (relPath, step, label, extra = {}) => {
                const arr = (conversion.fileTimeline[relPath] = conversion.fileTimeline[relPath] || []);
                arr.push(Object.assign({ step, label, at: Date.now() }, extra));
            };

            // Helper function to process a single file
            async function processFile(cobolPath, index, total, inputPath) {
                const relativePath = path.relative(inputPath, cobolPath);
                const baseName = path.basename(cobolPath, path.extname(cobolPath));
                const _t0 = Date.now();
                pushTimeline(relativePath, 'queued', 'Picked up by worker');

                // Mark active for live graph. The preflight check below may
                // flip it back to 'skipped' immediately; for cancelled /
                // budget-overrun that's expected behavior (the wave loop's
                // .then() completes within a single event-loop tick so the
                // UI's 800ms poll never shows the intermediate 'active'
                // state).
                conversion.fileStates[relativePath] = 'active';
                if (!conversion.currentFiles.includes(relativePath)) {
                    conversion.currentFiles.push(relativePath);
                }

                const fileResult = {
                    relativePath,
                    baseName,
                    cobolPath,
                    status: null,
                    reportEntry: null
                };

                let divisionalSplit = null;
                let cobolSource;
                try {
                    cobolSource = fs.readFileSync(cobolPath, 'utf-8');

                    // All skip gates consolidated into preflightCheck:
                    // cancelled, token-budget, no-PROGRAM-ID, tiny-file,
                    // truncated, oversize (with divisional-split fallback).
                    // → src/routes/convert-azure-helpers.js
                    const pre = preflightCheck({
                        relativePath, baseName, cobolPath, cobolSource,
                        conversion,
                        isLikelyTruncated,
                        isDivisionalSplitEnabled,
                        splitAtProcedureDivision,
                        pushTimeline
                    });
                    if (pre.outcome === 'skip') return pre.fileResult;
                    divisionalSplit = pre.divisionalSplit;

                    // Build the AI prompt context — CALL/COPY/PROGRAM-ID extraction,
                    // copybook inlining (size-capped), JCL invocation lookup by both
                    // basename and declared PROGRAM-ID. copybookBodyCache is shared
                    // across files in the wave, so a repo that COPYs the same .cpy
                    // from 200 programs reads it once.
                    // → src/routes/convert-azure-helpers.js
                    const {
                        calledPrograms, copybooks, programIdToJavaClass,
                        copybookBodies, jclInvocations
                    } = buildContext({
                        cobolSource, baseName, conversion,
                        copybookPathByName, copybookBodyCache, toPascalCase
                    });

                    pushTimeline(relativePath, 'context_built', 'Context assembled', {
                        calls: calledPrograms.length,
                        copybooks: copybooks.length,
                        copybookBodies: Object.keys(copybookBodies || {}).length,
                        jclInvocations: jclInvocations.length
                    });
                    // Convert using Azure AI — pass the context so CALL targets resolve
                    // to real Java classes, copybooks surface real field definitions,
                    // sibling-class calls match their actual method signatures, and
                    // JCL-staged files use real DD names instead of guessed paths.
                    //
                    // Thread HITL reject/edit notes from earlier files in this
                    // batch into the next file's context so the model can avoid
                    // repeating a flagged mistake. Capped at 5 notes — beyond
                    // that is prompt drift, not per-file signal.
                    // → src/routes/convert-azure-helpers.js
                    const reviewerFeedback = extractReviewerFeedback(conversion.reviewHistory, relativePath);
                    const _tAI = Date.now();
                    pushTimeline(relativePath, 'ai_call', divisionalSplit ? 'Calling AI (split: Part A — DATA)' : 'Calling AI to generate Java');
                    let conversionResult;
                    if (divisionalSplit) {
                        // Two-pass convert — Part A first (data classes + skeletons),
                        // then Part B (procedure bodies) with Part A's Java in the
                        // context so the method bodies reference the right fields.
                        const partAResult = await azureAgent.convertCobolToJava(divisionalSplit.partA, 0, {
                            calledPrograms,
                            copybooks,
                            programIdToJavaClass,
                            copybookBodies,
                            siblingSignatures: conversion.siblingSignatures,
                            jclInvocations,
                            reviewerFeedback
                        });
                        if (!partAResult.success) {
                            conversionResult = partAResult;
                        } else {
                            pushTimeline(relativePath, 'ai_call', 'Calling AI (split: Part B — PROCEDURE)');
                            const partBResult = await azureAgent.convertCobolToJava(divisionalSplit.partB, 0, {
                                calledPrograms,
                                copybooks,
                                programIdToJavaClass,
                                copybookBodies,
                                siblingSignatures: conversion.siblingSignatures,
                                jclInvocations,
                                reviewerFeedback,
                                // Part B sees Part A's Java as a partial class
                                // skeleton; frames it as "complete the method bodies"
                                // via a synthetic copybook entry so the existing
                                // copybookBodies plumbing surfaces it in the prompt.
                                partialSkeleton: partAResult.javaCode
                            });
                            if (!partBResult.success) {
                                conversionResult = partBResult;
                            } else {
                                // Stitch: Part A provides the class skeleton; Part B
                                // provides the method bodies. Text-level substitution
                                // only — deterministic, no second AI call.
                                const stitched = stitchJava(partAResult.javaCode, partBResult.javaCode);
                                pushTimeline(relativePath, 'stitch', `Stitched Part A + Part B`, {
                                    partABytes: partAResult.javaCode.length,
                                    partBBytes: partBResult.javaCode.length,
                                    stitchedBytes: stitched.length
                                });
                                conversionResult = {
                                    success: true,
                                    javaCode: stitched,
                                    usage: {
                                        prompt_tokens:    (partAResult.usage?.prompt_tokens     || 0) + (partBResult.usage?.prompt_tokens     || 0),
                                        completion_tokens:(partAResult.usage?.completion_tokens || 0) + (partBResult.usage?.completion_tokens || 0),
                                        total_tokens:     (partAResult.usage?.total_tokens      || 0) + (partBResult.usage?.total_tokens      || 0)
                                    }
                                };
                            }
                        }
                    } else {
                        conversionResult = await azureAgent.convertCobolToJava(cobolSource, 0, {
                            calledPrograms,
                            copybooks,
                            programIdToJavaClass,
                            copybookBodies,
                            siblingSignatures: conversion.siblingSignatures,
                            jclInvocations,
                            reviewerFeedback
                        });
                    }
                    pushTimeline(relativePath, 'ai_done', conversionResult.success ? 'AI returned Java' : 'AI conversion failed', {
                        ms: Date.now() - _tAI,
                        tokens: conversionResult.usage ? (conversionResult.usage.total_tokens || null) : null,
                        javaBytes: conversionResult.javaCode ? conversionResult.javaCode.length : 0,
                        error: conversionResult.success ? null : conversionResult.error
                    });

                    // Accumulate token usage if the API returned it
                    if (conversionResult && conversionResult.usage) {
                        const u = conversionResult.usage;
                        conversion.tokens.promptIn += u.prompt_tokens || 0;
                        conversion.tokens.completionOut += u.completion_tokens || 0;
                        conversion.tokens.total += u.total_tokens || 0;
                        conversion.tokens.calls += 1;
                    }

                    // --- HITL pause point ---------------------------------
                    // If review mode is on and conversion succeeded, pause until
                    // a human approves/rejects/edits via /api/review/:id/:fileId.
                    // Optional glob filter: only pause for matching paths.
                    const shouldReview = conversion.reviewMode && conversionResult.success &&
                        (!conversion.reviewGlobRe || conversion.reviewGlobRe.test(relativePath));
                    if (shouldReview) {
                        conversion.fileStates[relativePath] = 'awaiting_review';
                        conversion.currentFiles = conversion.currentFiles.filter(f => f !== relativePath);

                        const decision = await new Promise(resolve => {
                            conversion.pendingReview[relativePath] = {
                                cobolSource,
                                javaCode: conversionResult.javaCode,
                                queuedAt: Date.now(),
                                resolve
                            };
                        });

                        delete conversion.pendingReview[relativePath];

                        if (decision.action === 'reject') {
                            fileResult.status = 'error';
                            fileResult.error = decision.note || 'Rejected by reviewer';
                            fileResult.reportEntry = {
                                path: relativePath,
                                source_path: cobolPath,
                                java_status: 'REJECTED_BY_REVIEW',
                                error: fileResult.error
                            };
                            return fileResult;
                        }
                        if (decision.action === 'edit' && typeof decision.editedJava === 'string' && decision.editedJava.length > 0) {
                            conversionResult.javaCode = decision.editedJava;
                        }
                        // Mark active again for the write/compile phase so the UI
                        // shows movement instead of staying frozen on yellow.
                        conversion.fileStates[relativePath] = 'active';
                        if (!conversion.currentFiles.includes(relativePath)) {
                            conversion.currentFiles.push(relativePath);
                        }
                    }

                    if (conversionResult.success) {
                        // Create work directory for this file (for UI buttons)
                        const workDir = path.join(outputDir, 'work', baseName);
                        fs.mkdirSync(workDir, { recursive: true });

                        // Get the correct class name (PascalCase)
                        const javaClassName = toPascalCase(baseName);
                        const javaFileName = javaClassName + '.java';
                        const javaPath = path.join(javaDir, javaFileName);

                        // Normalize the Java code's class name so it matches the
                        // COBOL basename (PascalCase). The AI occasionally invents
                        // a different name (e.g. CardAuthorizationProgram instead
                        // of COPAUA0C); also the file on disk is named after the
                        // basename, and `java <class>` requires the public class
                        // name to match the file name.
                        // A/B test switch: DISABLE_AUTOFIX=1 also skips class-name
                        // normalization so we measure the full effect of all
                        // post-AI regex patches.
                        let fixedJavaCode = process.env.DISABLE_AUTOFIX === '1'
                            ? conversionResult.javaCode
                            : normalizeClassName(conversionResult.javaCode, javaClassName, baseName);

                        fs.writeFileSync(javaPath, fixedJavaCode);

                        // Also save to work dir for UI access
                        fs.writeFileSync(path.join(workDir, javaFileName), fixedJavaCode);

                        // Copy original COBOL source to work dir
                        fs.copyFileSync(cobolPath, path.join(workDir, path.basename(cobolPath)));

                        // --- Compile + run helper -----------------------------
                        // Called up to twice per file: once on the initial AI
                        // output, and (if a repair pass runs) once on the fixed
                        // Java. Returns { javaOutput, compareStatus, compilationError }.
                        async function compileAndRun() {
                            const javaFileInWorkDir = path.join(workDir, javaFileName);
                            let javaOutput = '';
                            let compareStatus = 'JAVA_ONLY';
                            let compilationError = null;
                            try {
                                const { execSync, spawnSync } = require('child_process');
                                try {
                                    // Classpath: include javaDir (where all siblings of this
                                    // conversion live) so references like `new Hello().run()`
                                    // resolve to already-converted sibling classes. Without
                                    // this, per-file javac sees only this one .java and fails
                                    // with "cannot find symbol: class Hello" even though
                                    // Hello.java exists in the same batch. The per-file
                                    // workDir stays the primary output (kept for the per-file
                                    // Run panel), but compile AND run both need javaDir on
                                    // the classpath to resolve cross-file CALLs.
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

                        // Initial compile + run
                        const _tCompile = Date.now();
                        pushTimeline(relativePath, 'compile', 'Running javac + java to verify');
                        let run1 = await compileAndRun();
                        let { javaOutput, compareStatus, compilationError } = run1;
                        pushTimeline(relativePath, 'compile_done', compilationError ? 'javac: FAIL' : 'javac: OK', {
                            ms: Date.now() - _tCompile,
                            compileStatus: compilationError ? 'fail' : 'ok',
                            errorPreview: compilationError ? String(compilationError).split('\n').slice(0, 2).join(' | ').slice(0, 200) : null
                        });

                        // Initial accuracy analysis (cheap; regex-based)
                        let accuracyResult = azureAgent.analyzeConversionAccuracy(cobolSource, fixedJavaCode);
                        pushTimeline(relativePath, 'accuracy', 'Accuracy scored', {
                            accuracy: accuracyResult.accuracy,
                            penalties: (accuracyResult.semanticPenalties || []).length
                        });

                        // --- Quality gates: compile-fail OR fabricated-fallback -
                        // Either condition triggers a single repair pass via
                        // fixJavaCode. Its system prompt already covers:
                        //   - "COMPILES cleanly with plain javac"
                        //   - "REMOVE FABRICATED INPUT DATA"
                        // so one call handles both at once.
                        const penalties = accuracyResult.semanticPenalties || [];
                        const hasFabricatedFallback = penalties.includes('Fabricated input fallback');
                        // A/B test switch: DISABLE_AUTOFIX=1 also skips the
                        // auto-repair pass so we measure the full
                        // post-AI-intervention effect vs. raw AI output.
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
                            // Re-use a prior /api/run capture of COBOL's output if the user
                            // already ran this file once — gives the repair agent real target
                            // behavior to match, instead of just the Java error text. On a
                            // fresh conversion (no prior run) this is still null, which is
                            // fine — the repair prompt makes cobolOutput optional.
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
                                    // Re-run class-name normalization on the repaired
                                    // output — the repair agent usually preserves the
                                    // class name, but not always, and a mismatch breaks
                                    // `java -cp workDir <javaClassName>` after repair.
                                    fixedJavaCode = normalizeClassName(repair.javaCode, javaClassName, baseName);
                                    fs.writeFileSync(javaPath, fixedJavaCode);
                                    fs.writeFileSync(path.join(workDir, javaFileName), fixedJavaCode);
                                    if (repair.usage) {
                                        conversion.tokens.promptIn     += repair.usage.prompt_tokens || 0;
                                        conversion.tokens.completionOut += repair.usage.completion_tokens || 0;
                                        conversion.tokens.total        += repair.usage.total_tokens || 0;
                                        conversion.tokens.calls        += 1;
                                    }
                                    // Re-compile, re-run, re-score on the repaired code.
                                    const run2 = await compileAndRun();
                                    javaOutput       = run2.javaOutput;
                                    compareStatus    = run2.compareStatus;
                                    compilationError = run2.compilationError;
                                    accuracyResult = azureAgent.analyzeConversionAccuracy(cobolSource, fixedJavaCode);
                                    pushTimeline(relativePath, 'repair_done', compilationError ? 'Repair applied, still fails javac' : 'Repair fixed javac failure', {
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
                            totalMs: Date.now() - _t0
                        });

                        // Cache the primary non-main public method signature
                        // so the next wave's callers emit `new Foo().run(...)`
                        // with the real parameter list instead of guessing.
                        // Indexed by basename AND PROGRAM-ID (they often differ —
                        // CBL0033.cbl declares PROGRAM-ID. PAYROL00.).
                        // → src/routes/convert-azure-helpers.js
                        const entrySig = extractEntrySignature(fixedJavaCode, javaClassName);
                        if (entrySig) {
                            conversion.siblingSignatures[baseName.toUpperCase()] = entrySig;
                            const pidMatch = cobolSource.match(/^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)/im);
                            if (pidMatch) {
                                conversion.siblingSignatures[pidMatch[1].toUpperCase()] = entrySig;
                            }
                        }

                        // Final status: if Java still doesn't compile after any
                        // repair pass, this is COMPILE_FAIL — not SUCCESS. The
                        // UI can then surface the real error instead of hiding
                        // it behind a green checkmark.
                        if (compilationError) {
                            fileResult.status = 'error';
                            fileResult.error = compilationError;
                            fileResult.reportEntry = {
                                path: relativePath,
                                source_path: cobolPath,
                                java_path: javaPath,
                                work_dir: workDir,
                                java_status: 'COMPILE_FAIL',
                                compare: compareStatus,
                                method: 'azure_ai',
                                error: compilationError,
                                repair_applied: repairApplied,
                                conversionAccuracy: accuracyResult.accuracy,
                                accuracyDetails: accuracyResult.details,
                                accuracyBreakdown: {
                                    cobolMetrics: accuracyResult.cobolMetrics,
                                    javaMetrics: accuracyResult.javaMetrics,
                                    semanticPenalties: accuracyResult.semanticPenalties || []
                                }
                            };
                        } else {
                            fileResult.status = 'success';
                            fileResult.reportEntry = {
                                path: relativePath,
                                source_path: cobolPath,
                                java_path: javaPath,
                                work_dir: workDir,
                                java_status: 'SUCCESS',
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
                        }

                    } else {
                        fileResult.status = 'error';
                        fileResult.error = conversionResult.error;
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'CONVERT_FAIL',
                            error: conversionResult.error
                        };
                    }

                } catch (fileErr) {
                    fileResult.status = 'error';
                    fileResult.error = fileErr.message;
                    fileResult.reportEntry = {
                        path: relativePath,
                        source_path: cobolPath,
                        java_status: 'FAIL',
                        error: fileErr.message
                    };
                }

                return fileResult;
            }

            // --- Dependency stratification ---------------------------------
            // Group files into LEVELS where each level can run in parallel,
            // but levels run sequentially. Level 0 = files with no COBOL deps,
            // Level 1 = files whose deps are all in level 0, etc.
            const cobolAbsSet = new Set(cobolFiles);
            const idOfAbs = new Map();
            for (const p of cobolFiles) idOfAbs.set(p, idOf(p));
            const absOfId = new Map();
            for (const p of cobolFiles) absOfId.set(idOf(p), p);

            const fileDeps = new Map(); // relPath -> Set of relPaths it CALLs (cobol-only)
            const selectedRelSet = new Set([...cobolFiles].map(p => idOf(p)));
            for (const rel of selectedRelSet) fileDeps.set(rel, new Set());
            for (const e of graphEdges) {
                if (e.kind !== 'call') continue;
                if (!selectedRelSet.has(e.source) || !selectedRelSet.has(e.target)) continue;
                fileDeps.get(e.source).add(e.target);
            }

            // Kahn-style level assignment
            const levels = [];
            const remaining = new Set(selectedRelSet);
            const completed = new Set();
            let safety = remaining.size + 5;
            while (remaining.size > 0 && safety-- > 0) {
                const level = [];
                for (const rel of remaining) {
                    const deps = fileDeps.get(rel);
                    let allDone = true;
                    for (const d of deps) {
                        if (!completed.has(d)) { allDone = false; break; }
                    }
                    if (allDone) level.push(rel);
                }
                if (level.length === 0) {
                    // Cycle detected — flush everything remaining as a final level
                    for (const rel of remaining) level.push(rel);
                }
                levels.push(level);
                for (const rel of level) {
                    remaining.delete(rel);
                    completed.add(rel);
                }
            }

            conversion.logs.push(` Dependency stratification: ${levels.length} level(s)\n`);
            levels.forEach((lvl, i) => {
                const labels = lvl.map(r => path.basename(r)).join(', ');
                conversion.logs.push(`   Level ${i + 1}: ${lvl.length} file(s) — ${labels}\n`);
            });
            conversion.logs.push(`\n Processing ${cobolFiles.length} files (deps first, parallel within level)...\n\n`);

            // Persist the wave plan so a resume run can reconstruct it without
            // re-stratifying (the graph already lives on disk via checkpoint,
            // but the wave ordering is the resume contract).
            conversion.totalLevels = levels.length;
            conversion.levelPlan = levels.map(lvl => lvl.slice());
            conversion.result = results; // partial; refreshed below
            saveCheckpoint(conversionId);

            let completedCount = 0;
            for (let lvlIdx = 0; lvlIdx < levels.length; lvlIdx++) {
                if (conversion.cancelled) {
                    conversion.logs.push(`\n Conversion cancelled by user at level ${lvlIdx + 1}\n`);
                    break;
                }
                const levelRel = levels[lvlIdx];
                // Resume semantics: skip files that already have a terminal
                // state (done / skipped / failed) on the conversion record.
                // A fresh run has none; a resumed run (cloned from an
                // interrupted record) starts with those keys already set.
                const terminal = new Set(['done', 'skipped', 'failed']);
                const levelAbs = levelRel
                    .filter(r => !terminal.has(conversion.fileStates[r]))
                    .map(r => absOfId.get(r));
                if (levelAbs.length === 0) {
                    conversion.logs.push(` Level ${lvlIdx + 1}/${levels.length}: all files already processed — skipping\n`);
                    conversion.completedLevelIdx = lvlIdx;
                    saveCheckpoint(conversionId);
                    continue;
                }
                conversion.logs.push(` Level ${lvlIdx + 1}/${levels.length}: ${levelAbs.length} file(s)\n`);

                // Within a level, files have no inter-deps so we can fully parallelize.
                // Still cap concurrency at BATCH_SIZE to avoid rate limits.
                //
                // Each per-file promise flips its own terminal state the moment
                // it resolves (inside the .then()), rather than waiting for the
                // whole batch's Promise.all. Otherwise 5 parallel files all
                // appear green at once when the slowest one finishes — even
                // though 4 of them have been done for seconds. The UI polls
                // /api/graph every 800ms, so flipping state immediately lets
                // the user watch nodes turn green in real time.
                for (let i = 0; i < levelAbs.length; i += BATCH_SIZE) {
                    if (conversion.cancelled) break;
                    const batch = levelAbs.slice(i, Math.min(i + BATCH_SIZE, levelAbs.length));
                    const batchPromises = batch.map((cobolPath, idx) =>
                        processFile(cobolPath, completedCount + idx, cobolFiles.length, inputPath)
                            .then(fileResult => {
                                completedCount++;
                                const relPath = fileResult.relativePath;
                                conversion.currentFiles = conversion.currentFiles.filter(f => f !== relPath);

                                if (fileResult.status === 'success') {
                                    conversion.fileStates[relPath] = 'done';
                                    results.converted++;
                                    results.convertedFiles.push(`${fileResult.relativePath} [AZURE_AI]`);
                                    conversion.logs.push(`   [ok] ${fileResult.relativePath}\n`);
                                } else if (fileResult.status === 'skipped_noid' || fileResult.status === 'skipped_small') {
                                    conversion.fileStates[relPath] = 'skipped';
                                    results.skippedNoId++;
                                    results.skippedFiles.push(`${fileResult.relativePath} - No PROGRAM-ID`);
                                    conversion.logs.push(`   skipped ${fileResult.relativePath} (skipped)\n`);
                                } else if (fileResult.status === 'error') {
                                    conversion.fileStates[relPath] = 'failed';
                                    results.skippedError++;
                                    results.errorFiles.push(`${fileResult.relativePath} - ${fileResult.error}`);
                                    conversion.logs.push(`   [error] ${fileResult.relativePath}: ${fileResult.error?.substring(0, 50) || 'Error'}\n`);
                                }

                                if (fileResult.reportEntry) {
                                    results.report.files.push(fileResult.reportEntry);
                                }
                                return fileResult;
                            })
                    );
                    await Promise.all(batchPromises);

                    if (i + BATCH_SIZE < levelAbs.length) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                }

                conversion.logs.push(`    Progress: ${completedCount}/${cobolFiles.length} files (${Math.round(completedCount / cobolFiles.length * 100)}%)\n\n`);

                // Wave-boundary checkpoint: completedLevelIdx names the last
                // wave whose files all reached a terminal state. If the server
                // crashes after this save, /api/resume can skip waves 0..N.
                conversion.completedLevelIdx = lvlIdx;
                conversion.result = results; // partial snapshot
                saveCheckpoint(conversionId);

                // Small pause between levels so the UI clearly shows the wave
                if (lvlIdx + 1 < levels.length) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }

            // Calculate average conversion accuracy
            const accuracyValues = results.report.files
                .filter(f => f.conversionAccuracy !== undefined)
                .map(f => f.conversionAccuracy);
            const averageAccuracy = accuracyValues.length > 0
                ? Math.round(accuracyValues.reduce((a, b) => a + b, 0) / accuracyValues.length)
                : 0;

            // Update summary
            // Note: Azure AI conversions are JAVA_ONLY (no native COBOL comparison)
            results.report.summary = {
                total: results.totalFiles,
                processed: results.totalFiles - results.skippedCopybook - results.skippedNoId,
                matches: 0,
                mismatches: 0,
                success_java_only: results.converted,
                fail_conversion: results.skippedError,
                fail_compile: 0,
                fail_execution: 0,
                skipped_copybook: results.skippedCopybook,
                skipped_noid: results.skippedNoId,
                averageAccuracy: averageAccuracy
            };

            conversion.logs.push(`\n${'='.repeat(50)}\n`);
            conversion.logs.push(` Conversion Summary (Azure AI)\n`);
            conversion.logs.push(`${'='.repeat(50)}\n`);
            conversion.logs.push(`Total files scanned: ${results.totalFiles}\n`);
            conversion.logs.push(`[ok] Successfully converted: ${results.converted}\n`);
            conversion.logs.push(` Average Conversion Accuracy: ${averageAccuracy}%\n`);
            conversion.logs.push(`Skipped (no PROGRAM-ID): ${results.skippedNoId}\n`);
            if (results.skippedError > 0) {
                conversion.logs.push(`[error] Errors: ${results.skippedError}\n`);
            }
            conversion.logs.push(`\n Powered by Azure AI Agent\n`);

        } catch (err) {
            conversion.logs.push(`\n[error] Conversion error: ${err.message}\n`);
        }

        // --- Aggregate conversion risks for the UI ---------------------
        const risks = [];
        const reportFiles = (results.report && results.report.files) || [];
        const summaryAcc = ((results.report && results.report.summary) || {}).averageAccuracy || 0;
        // 1. Filename collisions: multiple COBOL files mapping to the same Java class
        const javaClassToFiles = {};
        for (const f of reportFiles) {
            if (f.java_status === 'SUCCESS' && f.path) {
                const baseName = (f.path.split('/').pop() || '').replace(/\.[^.]+$/, '');
                const cls = baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase();
                (javaClassToFiles[cls] = javaClassToFiles[cls] || []).push(f.path);
            }
        }
        const collisions = Object.entries(javaClassToFiles).filter(([, arr]) => arr.length > 1);
        if (collisions.length > 0) {
            const totalCollided = collisions.reduce((s, [, arr]) => s + arr.length, 0);
            risks.push({
                severity: 'high',
                title: 'Filename collisions',
                detail: `${totalCollided} COBOL programs across ${collisions.length} basename(s) generated the same Java class — later writes overwrote earlier ones on disk.`,
                items: collisions.slice(0, 5).map(([cls, arr]) => `${cls}.java ← ${arr.length} files`)
            });
        }
        // 2. Low average accuracy
        if (summaryAcc > 0 && summaryAcc < 60) {
            risks.push({
                severity: 'high',
                title: 'Low average conversion accuracy',
                detail: `Average accuracy is ${summaryAcc}%, below the 60% threshold. Many files likely need human review or manual fixes.`
            });
        } else if (summaryAcc > 0 && summaryAcc < 75) {
            risks.push({
                severity: 'medium',
                title: 'Moderate conversion accuracy',
                detail: `Average accuracy is ${summaryAcc}%. Spot-check the lower-scoring files before relying on the output.`
            });
        }
        // 3. Per-file low accuracy
        const lowAccFiles = reportFiles.filter(f => typeof f.conversionAccuracy === 'number' && f.conversionAccuracy < 50);
        if (lowAccFiles.length > 0) {
            risks.push({
                severity: 'medium',
                title: 'Files with very low accuracy',
                detail: `${lowAccFiles.length} file(s) scored below 50% conversion accuracy.`,
                items: lowAccFiles.slice(0, 5).map(f => `${f.path} (${f.conversionAccuracy}%)`)
            });
        }
        // 4. Conversion failures
        if (results.skippedError > 0) {
            risks.push({
                severity: 'high',
                title: 'Conversion errors',
                detail: `${results.skippedError} file(s) failed during AI conversion. See the dependency graph (red nodes) and the Files panel for details.`
            });
        }
        // 5. Unresolved CALL/COPY references (graph dangling refs)
        if (conversion.graph && conversion.graph.nodes && conversion.graph.edges) {
            const nodeIds = new Set(conversion.graph.nodes.map(n => n.id));
            // edges that target a node not in nodeIds were filtered already; this is a placeholder
            // for future CICS XCTL/LINK parsing where we'd track unresolved targets.
        }
        conversion.risks = risks;

        conversion.status = 'completed';
        conversion.result = results;
        saveCheckpoint(conversionId);
    })();

    res.json({ conversionId, outputDir, useAzureAI: true });
};

    return convertAzureHandler;
}

module.exports = { createHandler };
