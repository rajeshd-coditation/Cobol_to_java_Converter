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
// Curated known-typo mappings — checked before the edit-distance fuzzy
// match to produce higher-confidence "Known typo" hints.
const { lookupCobolTypo } = require('./src/core/cobol-typo-dictionary');

// Middleware
// 2MB body cap — default is 100KB, which can trip on POST /api/convert-azure
// when a user selects a few thousand files (the body is a selectedFiles path
// list, not file contents, but long paths x large selections can exceed 100KB
// and Express returns a silent 413 that looks like a network failure in the UI).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Bookmark URL — serve index.html for /c/<conversionId> so users can
// deep-link into a previous run. The frontend inspects window.location
// on boot and drives the results view into that conversion (loading
// from memory or rehydrating via the existing checkpoint path in
// loadCheckpoints). No server-side state transition needed.
app.get('/c/:id', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Per-IP rate limiters for the AI-burning endpoints (§18.4). Applied as
// route-specific middleware just before each handler mounts — avoids
// rate-limiting GETs / static assets / non-AI routes.
//
// Budgets tuned to a single developer's local workflow (plenty of slack)
// while blocking obvious automated abuse. For a public-facing deploy,
// tighten these OR put a real API gateway in front (this guard is
// single-process and won't survive a restart).
const { createRateLimiter } = require('./src/util/rate-limit');
const convertLimiter = createRateLimiter({
    windowMs: 60_000, max: 10,  // 10 conversions/min per IP
    message: 'Too many conversion requests. Conversions are token-heavy; please wait a minute.',
    headerPrefix: 'RateLimit-Convert'
});
const aiLimiter = createRateLimiter({
    windowMs: 60_000, max: 30,  // 30 AI calls/min per IP (fix-java + compare-runs + ai/analyze)
    message: 'Too many AI requests. Please wait and try again.',
    headerPrefix: 'RateLimit-AI'
});
// Attach BEFORE the route handlers bind, using app.use with a path prefix
// so the limiter runs on match regardless of HTTP verb.
app.use('/api/convert-azure', convertLimiter);
app.use('/api/convert', convertLimiter);
app.use('/api/fix-java', aiLimiter);
app.use('/api/compare-runs', aiLimiter);
app.use('/api/ai/analyze', aiLimiter);

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
const {
    splitAtProcedureDivision,
    stitchJava,
    isSplitEnabled: isDivisionalSplitEnabled
} = require('./src/core/divisional-split');
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

// /api/convert-azure worker → src/routes/convert-azure.js
// The handler owns a ~30-step AI conversion pipeline (scan, graph, waves,
// HITL, compile-gate, auto-repair, accuracy scoring, checkpoints). The
// closure moved whole — dependencies pass in via createHandler(deps).
const { createHandler: createConvertAzureHandler } = require('./src/routes/convert-azure');
const convertAzureHandler = createConvertAzureHandler({
    activeConversions,
    azureAgent,
    buildConversionGraph,
    globToRegex,
    isDivisionalSplitEnabled,
    isLikelyTruncated,
    normalizeClassName,
    parseJcl,
    saveCheckpoint,
    splitAtProcedureDivision,
    stitchJava,
    toPascalCase,
    validateRepoUrl,
    log
});
app.post('/api/convert-azure', convertAzureHandler);
// /api/resume/:id → src/routes/resume.js (reuses convertAzureHandler
// with a resumeState payload built from the interrupted checkpoint)
require('./src/routes/resume').mount(app, {
    activeConversions,
    convertAzureHandler,
    saveCheckpoint
});

// /api/status/:id → src/routes/status.js

// HITL review endpoints → src/routes/review.js
require('./src/routes/review').mount(app, { activeConversions, saveCheckpoint, globToRegex });

// /api/graph/:id, /api/file-timeline/:id → src/routes/graph.js
require('./src/routes/graph').mount(app, { activeConversions });

// /api/run/:id/:fileId → src/routes/run.js (compile-and-run both COBOL and
// Java side by side, diff outputs). resolveDataAssignments / stageDataFilesInto
// live in src/core/run/data-file-staging.js; preprocessCobolSource in
// src/core/run/cobol-preprocess.js. Typo hint uses the curated dictionary
// + edit-distance fuzzy match.
require('./src/routes/run').mount(app, {
    activeConversions,
    resolveDataAssignments,
    stageDataFilesInto,
    preprocessCobolSource,
    listOutputFiles,
    stripAnsi,
    lookupCobolTypo,
    editDistance,
    log
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
require('./src/routes/download').mount(app, { activeConversions, buildManualReviewMd, parseJcl });

// /api/fix-java → src/routes/fix-java.js
require('./src/routes/fix-java').mount(app, { activeConversions, azureAgent });
// /api/fix-diff/:id/:fileId + /api/unfix-java/:id/:fileId → paired recovery
// endpoints, let the UI show the repair diff and roll back bad fixes.
require('./src/routes/unfix-java').mount(app, { activeConversions, azureAgent });

// COBOL-side typo fix: /api/fix-cobol/:id/:fileId applies a suggested
// rewrite; /api/fix-cobol-diff + /api/unfix-cobol pair with it.
require('./src/routes/fix-cobol').mount(app, { activeConversions });

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
require('./src/routes/prd').mount(app, { activeConversions });
require('./src/routes/status').mount(app, { activeConversions });
require('./src/routes/health').mount(app, { activeConversions, AI_PROVIDER, aiAgent, azureAgent });
require('./src/routes/stats').mount(app, { activeConversions });


// Start server — use http.createServer explicitly so we can attach a
// WebSocket upgrade handler for the interactive-run route (ws/run/...).
const http = require('http');
const httpServer = http.createServer(app);
require('./src/routes/run-ws').mount(httpServer, { activeConversions });

httpServer.listen(PORT, () => {
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
