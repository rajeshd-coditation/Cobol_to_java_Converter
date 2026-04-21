// Load environment variables
require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const aiAgent = require('./aiAgent');
const azureAgent = require('./azureAgent');

const app = express();
// PORT defaults to 3000; override via env so integration tests can spin up
// the server on a free port without clobbering a live instance.
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Determine which AI provider to use
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// File-backed logger (src/util/logger.js). JSON-per-line to webui.log +
// mounts the /api/logs tail endpoint.
const { createLogger } = require('./src/util/logger');
const { log, mountLogRoute } = createLogger(__dirname);
mountLogRoute(app);
log('server', 'startup');

// ----------------------------------------------------------------------
// Crash handlers. Without these, an uncaught exception or unhandled
// promise rejection in a background worker (e.g. inside a conversion's
// processFile) silently kills the Node process — the structured log
// captures nothing and the UI sees ERR_CONNECTION_REFUSED. With these,
// the stack trace lands in webui.log and (for rejections) the process
// keeps running so in-flight work isn't lost.
// ----------------------------------------------------------------------
process.on('uncaughtException', (err, origin) => {
    try {
        log('crash', 'uncaughtException', {
            origin,
            message: String(err && err.message || err),
            stack: err && err.stack ? String(err.stack) : null
        });
    } catch {}
    // Mirror to stderr so a running terminal still sees it.
    try { process.stderr.write(`\n[uncaughtException] ${err && err.stack ? err.stack : err}\n`); } catch {}
    // Preserve Node's default behavior: exit so the process manager can
    // restart. Without exiting we'd leave the process in an undefined
    // state. Give the log write a tick to flush.
    setTimeout(() => process.exit(1), 50);
});

process.on('unhandledRejection', (reason, promise) => {
    try {
        log('crash', 'unhandledRejection', {
            message: String(reason && reason.message || reason),
            stack: reason && reason.stack ? String(reason.stack) : null
        });
    } catch {}
    try { process.stderr.write(`\n[unhandledRejection] ${reason && reason.stack ? reason.stack : reason}\n`); } catch {}
    // Don't exit on rejections — a single bad conversion shouldn't take
    // down an in-flight batch of other conversions. Just log and keep
    // running. If a rejection is fatal the next request will surface it.
});

// Classic Levenshtein edit distance → src/util/edit-distance.js
const { editDistance } = require('./src/util/edit-distance');

// Middleware
// 2MB body cap — default is 100KB, which can trip on POST /api/convert-azure
// when a user selects a few thousand files (the body is a selectedFiles path
// list, not file contents, but long paths x large selections can exceed 100KB
// and Express returns a silent 413 that looks like a network failure in the UI).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Path to the scanner script
const SCANNER_SCRIPT = path.join(__dirname, '..', 'cobol_repo_scanner.sh');

// toPascalCase → src/util/pascal-case.js
const { toPascalCase } = require('./src/util/pascal-case');

// Java class-name normalization → src/core/normalize-class.js
const { normalizeClassName } = require('./src/core/normalize-class');

// Conversion checkpointing → src/persistence/checkpoint.js
const {
    CHECKPOINT_DIR,
    checkpointPath,
    saveCheckpoint: _persistSaveCheckpoint,
    loadCheckpoints: _persistLoadCheckpoints,
    cleanupOldCheckpoints
} = require('./src/persistence/checkpoint');
const { startActiveConversionsTTL } = require('./src/persistence/active-conversions-ttl');

// In-memory conversion registry. Routes keep a stable reference.
const activeConversions = new Map();

// Bind the activeConversions map to the persistence functions so callers can
// use the old signatures: saveCheckpoint(id), loadCheckpoints().
const saveCheckpoint = (id) => _persistSaveCheckpoint(activeConversions, id);
const loadCheckpoints = () => _persistLoadCheckpoints(activeConversions);

const _restoredCount = loadCheckpoints();
console.log(`   Restored ${_restoredCount} completed conversion(s) from checkpoint`);

// One-shot GC of checkpoint files > 7 days old. Keeps the /tmp directory
// bounded without a cron — the server itself is the trigger.
const _gc = cleanupOldCheckpoints();
if (_gc.deleted > 0) {
    console.log(`   Pruned ${_gc.deleted} checkpoint(s) older than 7 days (${_gc.scanned} scanned)`);
}

// Periodic eviction of completed in-memory conversions (§17.3). Disk
// state survives via the existing checkpoint; users who deep-link back
// to an evicted conversion will get rehydrated on next request.
startActiveConversionsTTL(activeConversions, {
    onEvict: (id) => console.log(`[ttl] Evicted completed conversion ${id} from memory`)
});

// Glob → RegExp → src/util/glob-regex.js
const { globToRegex } = require('./src/util/glob-regex');

// /api/cancel/:id → src/routes/cancel.js
require('./src/routes/cancel').mount(app, { activeConversions });

// /api/scan-repo → src/routes/scan-repo.js (pre-conversion file enumeration).
require('./src/routes/scan-repo').mount(app, { azureAgent });

// /api/convert → src/routes/convert-local.js (local `cobj` path — the Azure
// AI path is /api/convert-azure, still inline below). Needs parseScannerOutput
// + runCompileGateOnReport + stripAnsi, which all live in src/.
const { parseScannerOutput } = require('./src/core/parse-scanner-output');
const { stripAnsi } = require('./src/util/strip-ansi');
const { listOutputFiles } = require('./src/core/run/list-output-files');
const { preprocessCobolSource } = require('./src/core/run/cobol-preprocess');
const { resolveDataAssignments, stageDataFilesInto } = require('./src/core/run/data-file-staging');
const { buildConversionGraph } = require('./src/core/conversion-graph');
const { parseJcl } = require('./src/scan/jcl-parser');
const { validateRepoUrl } = require('./src/util/validate-repo-url');
const { isLikelyTruncated } = require('./src/core/source-integrity');
const { runCompileGateOnReport } = require('./src/core/compile-gate-local');
require('./src/routes/convert-local').mount(app, {
    activeConversions,
    SCANNER_SCRIPT,
    parseScannerOutput,
    runCompileGateOnReport,
    stripAnsi
});

// Small self-contained routes → src/routes/misc.js
// (samples, file-content, ai/provider, dependencies). Mounted after aiAgent
// + azureAgent are required (see top of file).

app.post('/api/convert-azure', async (req, res) => {
    const { repoUrl, reviewMode, reviewGlob, selectedFiles } = req.body;

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
    const outputDir = path.join(os.tmpdir(), `azure_cobol_output_${conversionId}`);
    const javaDir = path.join(outputDir, 'java');

    // Create output directories
    fs.mkdirSync(javaDir, { recursive: true });

    // Initialize conversion status
    activeConversions.set(conversionId, {
        status: 'running',
        cancelled: false,
        logs: [' Starting AI-powered conversion...\n'],
        result: null,
        useAzureAI: true,
        reviewMode: !!reviewMode,
        reviewGlob: reviewGlob || null,
        reviewGlobRe: globToRegex(reviewGlob),
        pendingReview: {}, // fileId -> { cobolSource, javaCode, resolve, queuedAt }
        reviewHistory: [], // [{ fileId, action, at, note? }]
        tokens: { promptIn: 0, completionOut: 0, total: 0, calls: 0 },
        // Hard ceiling on total tokens for this conversion. 0 = no cap. Default
        // pulled from env var so demo runs can be kept cheap without a code
        // change. When exceeded, processFile short-circuits with SKIPPED_BUDGET
        // on all remaining files so the user gets a clean partial result
        // instead of runaway cost.
        tokenBudget: parseInt(process.env.MAX_TOKENS_PER_CONVERSION || '0', 10) || 0,
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


            // Parallel processing configuration
            const BATCH_SIZE = 5; // Process 5 files concurrently

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

                // If user cancelled, mark as skipped and return immediately
                if (conversion.cancelled) {
                    conversion.fileStates[relativePath] = 'skipped';
                    return { relativePath, baseName, cobolPath, status: 'skipped_cancelled', reportEntry: null };
                }

                // Token-budget guard. If the conversion has consumed more than
                // its ceiling, stop making new AI calls and mark remaining
                // files as SKIPPED_BUDGET. Protects against runaway token spend
                // on large repos — opt-in via MAX_TOKENS_PER_CONVERSION env.
                if (conversion.tokenBudget > 0 && conversion.tokens.total >= conversion.tokenBudget) {
                    conversion.fileStates[relativePath] = 'skipped';
                    return {
                        relativePath, baseName, cobolPath,
                        status: 'error',
                        error: `Token budget exceeded (${conversion.tokens.total} / ${conversion.tokenBudget})`,
                        reportEntry: {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_BUDGET',
                            error: `Token budget of ${conversion.tokenBudget} reached; ${conversion.tokens.total} tokens used. Set MAX_TOKENS_PER_CONVERSION=0 to disable the cap.`
                        }
                    };
                }

                // Mark active for live graph
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

                try {
                    const cobolSource = fs.readFileSync(cobolPath, 'utf-8');

                    // Skip if it looks like a copybook (no PROGRAM-ID)
                    if (!cobolSource.match(/PROGRAM-ID/i)) {
                        fileResult.status = 'skipped_noid';
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_NO_ID'
                        };
                        return fileResult;
                    }

                    // Skip if file is too small
                    if (cobolSource.trim().length < 50) {
                        fileResult.status = 'skipped_small';
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_NO_ID'
                        };
                        return fileResult;
                    }

                    // Pre-check for truncated / incomplete sources (§13).
                    // Flag + skip BEFORE sending to the AI — otherwise the
                    // model helpfully invents a plausible-looking ending
                    // and we get Java that doesn't match the user's intent.
                    const integrity = isLikelyTruncated(cobolSource);
                    if (integrity.truncated) {
                        fileResult.status = 'skipped_incomplete';
                        fileResult.error = integrity.reason;
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_INCOMPLETE_SOURCE',
                            error: integrity.reason,
                            sourceBytes: cobolSource.length
                        };
                        return fileResult;
                    }

                    // Skip if file is too large for a single conversion pass.
                    // The primary convert prompt sends the FULL COBOL source, so
                    // a 200KB file ~ 65k input tokens. Past ~80k chars we're at
                    // serious risk of blowing the deployment's context window —
                    // three retries later we'd fail with a cryptic "AI response
                    // truncated" error. Fail fast with a clear status instead.
                    const MAX_COBOL_CHARS = 80000;
                    if (cobolSource.length > MAX_COBOL_CHARS) {
                        fileResult.status = 'error';
                        fileResult.error = `Source is ${cobolSource.length} chars — exceeds ${MAX_COBOL_CHARS}-char cap for a single-pass conversion. Consider splitting the program or raising MAX_COBOL_CHARS if your deployment has a large context window.`;
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_TOO_LARGE',
                            error: fileResult.error,
                            sourceBytes: cobolSource.length
                        };
                        return fileResult;
                    }

                    // --- Build conversion context so the AI can emit REAL Java calls
                    // to sibling classes instead of fabricating/simulating CALL targets.
                    // Uses the same regexes the graph builder used earlier.
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
                    // Build PROGRAM-ID → Java class name map for everything in this conversion.
                    // The graph's nameIndex already maps PROGRAM-ID / filename → relative path.
                    // We derive the Java class name via toPascalCase of the file basename.
                    const programIdToJavaClass = {};
                    const gNodes = (conversion.graph && conversion.graph.nodes) || [];
                    for (const n of gNodes) {
                        if (n.type !== 'program') continue;
                        const base = path.basename(n.path || n.id, path.extname(n.path || n.id));
                        const javaClass = toPascalCase(base);
                        programIdToJavaClass[base.toUpperCase()] = javaClass;
                    }
                    // Overlay any PROGRAM-ID entries from the nameIndex (so 'HELLO-APP'
                    // inside a file named HELLO.cbl also resolves).
                    // The conversion's graph edges already stored resolution via name-index,
                    // but we don't persist the index itself; re-scan for PROGRAM-IDs here.
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

                    // Load copybook bodies for any COPY target we actually have on disk.
                    // Cached across files so a repo of 200 programs COPYing the same 10
                    // copybooks doesn't re-read the same files 2000 times. Size-gated:
                    // total inlined bodies capped at ~40k chars to keep the prompt
                    // within context budget; largest omitted first if we exceed.
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

                    // JCL invocations for this program — look up by basename AND by any
                    // declared PROGRAM-ID, since a file CBL0033.cbl may declare
                    // `PROGRAM-ID. PAYROL00.` and the JCL references the latter.
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
                    const _tAI = Date.now();
                    pushTimeline(relativePath, 'ai_call', 'Calling AI to generate Java');
                    const conversionResult = await azureAgent.convertCobolToJava(cobolSource, 0, {
                        calledPrograms,
                        copybooks,
                        programIdToJavaClass,
                        copybookBodies,
                        siblingSignatures: conversion.siblingSignatures,
                        jclInvocations
                    });
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

                        // --- Sibling signature cache ------------------------
                        // Pull the PRIMARY public method signature out of the
                        // final Java source and cache it on the conversion so
                        // the NEXT wave's callers can emit `new Foo().run(...)`
                        // with the exact parameter list this class expects,
                        // instead of guessing. Prefer a non-`main` public method
                        // (the COBOL "entry point" typically becomes `run(...)`
                        // or `execute(...)`); fall back to `main`.
                        try {
                            const sigRe = /public\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(([^)]*)\)/g;
                            const sigs = [];
                            let sm;
                            while ((sm = sigRe.exec(fixedJavaCode)) !== null) {
                                sigs.push({ name: sm[1], args: sm[2].trim(), full: sm[0].trim() });
                            }
                            const entrySig = sigs.find(s => s.name !== 'main' && s.name !== javaClassName)
                                || sigs.find(s => s.name === 'main')
                                || sigs[0];
                            if (entrySig) {
                                conversion.siblingSignatures[baseName.toUpperCase()] = entrySig.full;
                                // Also index by PROGRAM-ID if it differs from the basename
                                // (e.g. file CBL0033.cbl has PROGRAM-ID. PAYROL00.).
                                const pidMatch = cobolSource.match(/^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)/im);
                                if (pidMatch) {
                                    conversion.siblingSignatures[pidMatch[1].toUpperCase()] = entrySig.full;
                                }
                            }
                        } catch (sigErr) {
                            // Signature extraction is best-effort; a regex miss shouldn't fail the conversion.
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

            let completedCount = 0;
            for (let lvlIdx = 0; lvlIdx < levels.length; lvlIdx++) {
                if (conversion.cancelled) {
                    conversion.logs.push(`\n Conversion cancelled by user at level ${lvlIdx + 1}\n`);
                    break;
                }
                const levelRel = levels[lvlIdx];
                const levelAbs = levelRel.map(r => absOfId.get(r));
                conversion.logs.push(` Level ${lvlIdx + 1}/${levels.length}: ${levelAbs.length} file(s)\n`);

                // Within a level, files have no inter-deps so we can fully parallelize.
                // Still cap concurrency at BATCH_SIZE to avoid rate limits.
                for (let i = 0; i < levelAbs.length; i += BATCH_SIZE) {
                    if (conversion.cancelled) break;
                    const batch = levelAbs.slice(i, Math.min(i + BATCH_SIZE, levelAbs.length));
                    const batchPromises = batch.map((cobolPath, idx) =>
                        processFile(cobolPath, completedCount + idx, cobolFiles.length, inputPath)
                    );
                    const batchResults = await Promise.all(batchPromises);

                    for (const fileResult of batchResults) {
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
                    }

                    if (i + BATCH_SIZE < levelAbs.length) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                }

                conversion.logs.push(`    Progress: ${completedCount}/${cobolFiles.length} files (${Math.round(completedCount / cobolFiles.length * 100)}%)\n\n`);

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
});

// /api/status/:id → src/routes/status.js

// HITL review endpoints → src/routes/review.js
require('./src/routes/review').mount(app, { activeConversions, saveCheckpoint, globToRegex });

// /api/graph/:id, /api/file-timeline/:id → src/routes/graph.js
require('./src/routes/graph').mount(app, { activeConversions });

// API: Run a converted file's COBOL source + Java output side by side.
// Body: { input?: string }   — optional custom stdin to feed both programs
// Returns { cobol: {...}, java: {...} }
app.post('/api/run/:id/:fileId(*)', async (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    if (!conversion.result) return res.status(400).json({ error: 'Conversion not complete yet' });

    const fileId = req.params.fileId;
    const reportFile = (conversion.result.report.files || []).find(f => f.path === fileId);
    if (!reportFile) return res.status(404).json({ error: 'File not in report' });

    // Custom stdin from the user. Real newlines pass through;
    // escaped \n in a single-line context also converted.
    // Commas are also treated as line separators for convenience (e.g. "1,4").
    let userInput = (req.body && typeof req.body.input === 'string') ? req.body.input : '';
    if (userInput.trim()) {
        userInput = userInput.replace(/\\n/g, '\n').replace(/,/g, '\n');
        if (!userInput.endsWith('\n')) userInput += '\n';
    } else {
        userInput = '';
    }
    // Always pad with exit-like values to prevent infinite loops when ACCEPT
    // reads past the user-supplied input. Common COBOL menu exits: 4, q, 0, n.
    userInput += '4\n4\n4\nq\n0\nn\n';

    const { spawnSync, execSync } = require('child_process');
    const result = { cobol: null, java: null };
    // Record when the run actually started so the output-file scan below
    // only picks files created/modified during THIS run.
    const runStartMs = Date.now();

    // Data-file staging: resolve SELECT-ASSIGN targets (via the cached
    // dataFileLookup from scan, or by re-parsing the source as fallback),
    // then copy each match into the Java work dir under every plausible
    // name variant. COBOL side gets staged later, right before cobc runs.
    // → src/core/run/data-file-staging.js
    const dataAssignments = resolveDataAssignments(reportFile, conversion);
    stageDataFilesInto(reportFile.work_dir, dataAssignments);

    // --- Run Java ------------------------------------------------------
    // Strategy: try to compile the target with ONLY the siblings it actually
    // references (via `new ClassName(...)` or `ClassName.` patterns).
    // Falls back to target-only compilation if the reference-aware compile
    // fails — so that broken sibling files don't block users from running a
    // working target. A previous version always bundled ALL siblings, which
    // cascaded compile errors from unrelated files onto every run.
    if (reportFile.work_dir && reportFile.java_path) {
        try {
            const javaClass = path.basename(reportFile.java_path, '.java');

            // Build a map of available sibling classes so we can look them up.
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
            // `new ClassName(...)` OR static call `ClassName.method(...)`
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

            // Helper to run javac and return { ok, stderr }.
            const tryCompile = (paths) => {
                const cmd = `javac ${paths.map(p => `"${p}"`).join(' ')}`;
                try {
                    execSync(cmd, { cwd: reportFile.work_dir, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
                    return { ok: true };
                } catch (e) {
                    return { ok: false, stderr: e.stderr ? e.stderr.toString() : e.message };
                }
            };

            // Attempt 1: target + only its referenced siblings.
            let compileRes = tryCompile([reportFile.java_path, ...stagedSiblings]);
            let compileNote = null;

            // Attempt 2 fallback: target alone. If it compiles, we proceed but
            // note that cross-class calls may fail at runtime.
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
                result.java = {
                    ok: false,
                    output: '',
                    error: 'Compilation failed:\n' + compileRes.stderr
                };
            }
            if (!result.java) {
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
            }
        } catch (err) {
            result.java = { ok: false, output: '', error: err.message };
        }
    } else {
        result.java = { ok: false, output: '', error: 'No Java output for this file' };
    }

    // --- Run COBOL (best-effort, requires cobc/GnuCOBOL) ---------------
    if (reportFile.source_path && fs.existsSync(reportFile.source_path)) {
        try {
            // Check if cobc is available
            let hasCobc = false;
            try { execSync('which cobc', { stdio: 'ignore' }); hasCobc = true; } catch {}
            if (!hasCobc) {
                result.cobol = {
                    ok: false,
                    output: '',
                    error: 'GnuCOBOL (cobc) is not installed on this server. Install with `brew install gnu-cobol` to enable native COBOL execution.'
                };
            } else {
                // Fast pre-check: if this COBOL source uses DB2/CICS/IMS
                // constructs, GnuCOBOL literally cannot compile it regardless
                // of preprocessing (the stripped SQL declares SQLCODE/SQLCA
                // that the remaining code references). Surface a clean
                // "cannot run locally" message up front — don't waste cobc
                // cycles or dump compiler errors the user can't act on. The
                // Java side still runs below for a one-sided behavior check.
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

                // Gather all COBOL sources from this conversion for multi-file compile
                const allCobolSources = (conversion.result.report.files || [])
                    .filter(f => f.source_path && /\.(cob|cbl|cobol)$/i.test(f.source_path) && fs.existsSync(f.source_path))
                    .map(f => f.source_path);

                // Extract PROGRAM-ID from every source (multi-line form supported).
                // We compile EVERY sibling as a CALLable module — relying on the
                // "has PROCEDURE DIVISION USING" heuristic misses files that are
                // CALLed without arguments (common pattern).
                const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
                const sourceInfo = []; // { path, programId }
                for (const s of allCobolSources) {
                    try {
                        const src = fs.readFileSync(s, 'utf-8');
                        const m = src.match(programIdRe);
                        sourceInfo.push({ path: s, programId: m ? m[1] : null });
                    } catch { sourceInfo.push({ path: s, programId: null }); }
                }

                let compiled = false;
                const hasMultiple = allCobolSources.length > 1;

                // Short-circuit for DB2/CICS/IMS programs. cobc will never
                // compile these without a mainframe preprocessor; skip the
                // whole compile + run block and surface the clean message
                // we built above.
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

                // Compile every sibling (i.e. non-target) as a shared module. This
                // way, a CALL 'FOO' from the target resolves regardless of whether
                // FOO declares USING or not. The module file must be named by
                // PROGRAM-ID — libcob's runtime loader searches COB_LIBRARY_PATH
                // for that exact name.
                // Pre-process: many real-world COBOL files (esp. IBM mainframe
                // origin) omit the trailing period on header paragraphs like
                // `PROGRAM-ID. FOO` or `AUTHOR. Bob`. GnuCOBOL treats that as
                // a continuation and fails at the next DIVISION. We transparently
                // add the missing period into a temp copy before compiling.
                // Light preprocess pass — only fixes real mainframe sloppiness
                // that vanilla gnucobol trips on:
                //   - Missing trailing period on `AUTHOR.`, `DATE-WRITTEN.` etc.
                //     commentary paragraphs. We collapse the value to empty
                //     because many sources embed periods INSIDE author names
                //     (e.g. "Otto B. Relational") which confuses the parser.
                //   - PROGRAM-ID terminating period living in cols 73+ (fixed-
                //     format Identification Area = ignored by cobc). Re-emit
                //     the line so the terminator is in compiler-visible range.
                //
                // EXEC SQL / CICS / DLI / MQ stripping was removed — gnucobol
                // can't run those programs regardless because the stripped
                // blocks declare SQLCODE / SQLCA / DFHCOMMAREA that the rest
                // of the source references, producing cascading "not defined"
                // errors. The /api/run pre-check now short-circuits with a
                // clean "requires DB2/CICS/IMS preprocessor" message instead.
                const preprocessMods = { periodsAdded: 0 };
                const preprocessSource = (srcPath) => preprocessCobolSource(srcPath, cobolWork, preprocessMods);

                // GnuCOBOL flags that accept more real-world COBOL dialects:
                //   -std=mf            → Micro Focus dialect (accepts AUTHOR, DATE-WRITTEN, etc.)
                //   -frelax-syntax-checks → warnings instead of errors for obsolete constructs
                //   -Wno-obsolete      → suppress "obsolete feature" errors
                // Tried in order: mf dialect → default dialect → minimal fallback.
                //
                // Copybook include paths (-I): directories where cobc should
                // look for COPY targets. We add:
                //   1. the target's own directory (same-folder copybooks)
                //   2. every unique directory containing a .cpy file in the repo
                //   3. common conventional dirs at the repo root (cpy/, copybooks/)
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
                // Skip all compile work if the pre-check already decided COBOL
                // can't run locally (DB2/CICS/IMS).
                if (hasMultiple && !result.cobol) {
                    for (const info of sourceInfo) {
                        if (info.path === reportFile.source_path) continue; // skip target, compiled as exec below
                        const pid = info.programId;
                        const srcToUse = preprocessSource(info.path);
                        let ok = false;
                        for (const dialect of COBC_DIALECTS) {
                            if (ok) break;
                            for (const fmt of ['-free', '-fixed']) {
                                try {
                                    if (pid) {
                                        execSync(`cobc -m ${fmt} ${dialect} -o "${path.join(cobolWork, pid)}" "${srcToUse}"`, {
                                            cwd: cobolWork,
                                            timeout: 30000,
                                            stdio: ['pipe', 'pipe', 'pipe']
                                        });
                                    } else {
                                        execSync(`cobc -m ${fmt} ${dialect} "${srcToUse}"`, {
                                            cwd: cobolWork,
                                            timeout: 30000,
                                            stdio: ['pipe', 'pipe', 'pipe']
                                        });
                                    }
                                    ok = true;
                                    break;
                                } catch {}
                            }
                        }
                    }
                }

                // Always compile the requested file as the executable entry point.
                // Run through the preprocessor to patch missing header periods —
                // many IBM mainframe COBOL files are sloppy about those, and
                // GnuCOBOL won't compile without them regardless of dialect.
                const entryFile = preprocessSource(reportFile.source_path);
                let lastErr = '';
                for (const dialect of COBC_DIALECTS) {
                    if (compiled || result.cobol) break;
                    for (const fmt of ['-free', '-fixed']) {
                        try {
                            execSync(`cobc -x ${fmt} ${dialect} -o "${binPath}" "${entryFile}"`, {
                                cwd: cobolWork,
                                timeout: 30000,
                                stdio: ['pipe', 'pipe', 'pipe']
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

                    // Typo-hint: when cobc says `'FOO' is not defined`, check if
                    // the source has a similar identifier. Edit distance 1 is
                    // usually enough to catch human typos like PRINT-REX vs
                    // PRINT-REC (real bug in the COBOL Programming Course repo).
                    let typoHint = '';
                    const undefMatch = /'([A-Z0-9_-]+)'\s+is\s+not\s+defined/i.exec(lastErr);
                    if (undefMatch) {
                        try {
                            const bad = undefMatch[1];
                            const src = fs.readFileSync(reportFile.source_path, 'utf-8');
                            const idents = new Set();
                            // Pull every "01 FOO" / "05 FOO" / "FD FOO" name
                            const idRe = /^\s*(?:\d+\s+)?(?:FD|SD|\d{2})\s+([A-Z][A-Z0-9_-]*)/gim;
                            let im;
                            while ((im = idRe.exec(src)) !== null) idents.add(im[1].toUpperCase());
                            const hit = [...idents].find(i => i !== bad && editDistance(i, bad.toUpperCase()) <= 1);
                            if (hit) {
                                typoHint = `\n\nHint: \`${bad}\` is not defined, but \`${hit}\` is — likely a typo in the source file. Edit the COBOL and change \`${bad}\` → \`${hit}\`.`;
                                log('cobol-compile', 'typo-hint', { bad, suggestion: hit, file: reportFile.path });
                            }
                        } catch {}
                    }

                    // Surface the preprocessor periods fix-count if it was
                    // non-trivial, so the user sees we touched the source.
                    const modsNote = preprocessMods.periodsAdded
                        ? `\n\nPreprocessor mods applied: ${preprocessMods.periodsAdded} header-period fix(es).`
                        : '';
                    result.cobol = {
                        ok: false,
                        output: '',
                        error: 'COBOL compile failed (tried all dialect/format combinations):\n' + lastErr + typoHint + modsNote
                    };
                } else if (compiled) {
                    log('cobol-compile', 'ok', {
                        file: reportFile.path,
                        periodsAdded: preprocessMods.periodsAdded
                    });
                }
                if (!result.cobol && compiled) {
                    // Stage the same data files into the COBOL work dir that
                    // were staged into the Java work dir earlier — libcob
                    // resolves SELECT-ASSIGN relative to cwd.
                    stageDataFilesInto(cobolWork, dataAssignments);

                    // Lower timeout so the UI gets quick feedback when a program
                    // is stuck in an input loop. 5 seconds is still plenty for
                    // most one-shot COBOL business logic.
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

                    // Detect a timeout kill (signal SIGTERM or elapsed >= timeout).
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
                        // Internal hint for listOutputFiles — stripped from
                        // the response before sending.
                        _workDir: cobolWork
                    };
                }
            }
        } catch (err) {
            result.cobol = { ok: false, output: '', error: err.message };
        }
    } else {
        result.cobol = { ok: false, output: '', error: 'COBOL source file not found' };
    }

    // Strip ANSI escape sequences from program output before sending to browser
    if (result.cobol && result.cobol.output) result.cobol.output = stripAnsi(result.cobol.output);
    if (result.cobol && result.cobol.error)  result.cobol.error  = stripAnsi(result.cobol.error);
    if (result.java  && result.java.output)  result.java.output  = stripAnsi(result.java.output);
    if (result.java  && result.java.error)   result.java.error   = stripAnsi(result.java.error);

    // listOutputFiles → src/core/run/list-output-files.js. Surfaces files
    // the program wrote during the run (PRTLINE, REPORT, OUT*, etc.) that
    // stdout alone doesn't show.
    try {
        // Exclude the input data files we staged for each side (they were
        // copied in from the scan's data-file lookup) so the list shows
        // only what the PROGRAM wrote during this run.
        const stagedInputs = new Set(Object.keys(conversion.dataFileLookup || {}));
        // Expand variants that get staged (raw, .txt, .dat, upper, lower).
        const staged = new Set();
        for (const nm of stagedInputs) {
            const bases = [nm, nm.toLowerCase(), nm.toUpperCase()];
            for (const b of bases) { staged.add(b); staged.add(b + '.txt'); staged.add(b + '.dat'); }
        }
        if (result.java && reportFile.work_dir) {
            result.java.outputFiles = listOutputFiles(reportFile.work_dir, runStartMs, staged);
        }
        // COBOL work dir: captured only when we successfully ran COBOL.
        // Reuse `cobolWork` if it's in scope (compile path). For simplicity
        // we read it from result.cobol if we attached it, else skip.
        if (result.cobol && result.cobol._workDir) {
            result.cobol.outputFiles = listOutputFiles(result.cobol._workDir, runStartMs, staged);
            delete result.cobol._workDir;
        }
    } catch {}

    // Cache last run outputs per file so /api/fix-java can feed them to the
    // repair agent as context.
    conversion._lastRun = conversion._lastRun || {};
    conversion._lastRun[fileId] = {
        cobolOutput: (result.cobol && result.cobol.output) || '',
        cobolError:  (result.cobol && result.cobol.error)  || '',
        javaOutput:  (result.java  && result.java.output)  || '',
        javaError:   (result.java  && result.java.error)   || '',
        cobolExit:   result.cobol ? result.cobol.exitCode : null,
        javaExit:    result.java  ? result.java.exitCode  : null
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

// /api/post-review/:id/:fileId, /api/post-review/:id → src/routes/post-review.js
require('./src/routes/post-review').mount(app, { activeConversions });

// classifyArtifact + buildManualReviewMd → src/core/manual-review.js
const { buildManualReviewMd } = require('./src/core/manual-review');

// /api/jcl-analysis → src/routes/jcl.js (parseJcl imported near the top).
require('./src/routes/jcl').mount(app, { activeConversions, parseJcl });

// /api/download/:id → src/routes/download.js
// Must be mounted here (not near the top) because buildManualReviewMd is
// defined above and passed as a dep.
require('./src/routes/download').mount(app, { activeConversions, buildManualReviewMd });

// /api/fix-java → src/routes/fix-java.js
require('./src/routes/fix-java').mount(app, { activeConversions, azureAgent });

// API: AI-powered comparison of COBOL vs Java runtime output.
// The frontend calls this AFTER /api/run returns, to get a semantic verdict
// that catches cases regex can't (matched failure modes, equivalent business
// output with minor formatting drift, simulation on one side, etc.).
//
// Body: { cobolOutput, javaOutput, cobolExit, javaExit, cobolTimedOut,
//         javaTimedOut, fileName, cobolSource?, javaCode?,
//         conversionId?, relativePath? }
// If conversionId + relativePath are provided, the server looks up source from
// disk — caller doesn't have to re-send bytes the server already has.
// Returns the structured verdict from azureAgent.compareRunOutputs().
// /api/compare-runs, /api/comparison, /api/code-comparison → src/routes/compare.js
require('./src/routes/compare').mount(app, { activeConversions, azureAgent });

// /api/browser/:id, /api/files/:id → src/routes/status.js
// /api/file-content → src/routes/misc.js

// stripAnsi + runCompileGateOnReport are imported near the top of this file
// (when convert-local is mounted). parseOutput was moved wholesale to
// src/core/parse-scanner-output.js — its only caller was /api/convert,
// which now lives in src/routes/convert-local.js.

// ============================================
// AI Agent API Endpoints
// NOTE: /api/ai/status was removed (not called from frontend — use the
// richer /api/ai/provider endpoint below, which reports Azure + OpenAI).
// /api/ai/fix was removed (no frontend caller, and autoFixCobolCode was
// only invoked from that endpoint — both go away together).
// ============================================

// /api/ai/analyze → src/routes/ai-analyze.js.
// buildAnalysisContext is passed as a dep so the route module can stay free
// of references to server-local globals (activeConversions, toPascalCase).
// Analysis-context builder → src/util/analysis-context.js
const { buildAnalysisContext: _buildAnalysisContext } = require('./src/util/analysis-context');
const buildAnalysisContext = (conversionId, relativePath, cobolSource) =>
    _buildAnalysisContext(conversionId, relativePath, cobolSource, { activeConversions, toPascalCase });
require('./src/routes/ai-analyze').mount(app, { aiAgent, azureAgent, buildAnalysisContext });

// NOTE: the /api/azure/* endpoints (status, convert, scan, convert-directory,
// analyze) that previously lived here were removed — none were called from the
// frontend or docs, they duplicated the main /api/convert-azure + /api/scan-repo
// + /api/ai/analyze flows with inferior context (the convert one passed NO
// dependency/copybook context). Kept the diff small: call graph was dead code.
// /api/azure/status was merged into /api/ai/provider (which the frontend uses).

// /api/ai/provider, /api/dependencies → src/routes/misc.js
// Mount routes now that AI_PROVIDER / aiAgent / azureAgent are all in scope.
require('./src/routes/misc').mount(app, { AI_PROVIDER, aiAgent, azureAgent, activeConversions });
require('./src/routes/status').mount(app, { activeConversions });
require('./src/routes/health').mount(app, { activeConversions, AI_PROVIDER, aiAgent, azureAgent });
require('./src/routes/stats').mount(app, { activeConversions });


// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(' COBOL Converter UI starting...');
    console.log('='.repeat(50));

    // Initialize AI agents based on provider
    if (AI_PROVIDER === 'azure') {
        const azureInit = azureAgent.initializeAzure();
        if (!azureInit) {
            console.log('   Falling back to OpenAI...');
            aiAgent.initializeOpenAI();
        }
    } else {
        aiAgent.initializeOpenAI();
    }

    // Also try to initialize the other provider (for dual support)
    if (AI_PROVIDER === 'openai') {
        azureAgent.initializeAzure(); // Silent init for Azure as backup
    }

    console.log('='.repeat(50));
    console.log(` Server running at http://localhost:${PORT}`);
    console.log(` AI Provider: ${AI_PROVIDER.toUpperCase()}`);
    console.log('='.repeat(50) + '\n');
});
