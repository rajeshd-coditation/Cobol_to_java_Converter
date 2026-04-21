// Load environment variables
require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const aiAgent = require('./aiAgent');
const azureAgent = require('./azureAgent');

const app = express();
// PORT defaults to 3000; override via env so integration tests can spin up
// the server on a free port without clobbering a live instance.
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Determine which AI provider to use
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// ──────────────────────────────────────────────────────────────────────
// File-backed logger. Writes to webui.log in this folder (gitignored) so
// server activity survives restarts and we can grep failures offline.
// Lines are JSON-per-line so it's easy to parse later. Console output
// still happens via the existing console.log calls.
// ──────────────────────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, 'webui.log');
function log(category, msg, extra) {
    const line = JSON.stringify({
        t: new Date().toISOString(),
        category,
        msg,
        ...(extra || {})
    }) + '\n';
    try { fs.appendFileSync(LOG_PATH, line); } catch {}
}
// Expose a log-tailing endpoint so the UI (or curl) can inspect it quickly.
app.get('/api/logs', (req, res) => {
    const n = Math.min(parseInt(req.query.n || '500', 10), 5000);
    try {
        const content = fs.readFileSync(LOG_PATH, 'utf-8');
        const lines = content.trimEnd().split('\n');
        res.type('text/plain').send(lines.slice(-n).join('\n'));
    } catch (e) {
        res.type('text/plain').send('No log file yet.');
    }
});
log('server', 'startup');

// ──────────────────────────────────────────────────────────────────────
// Crash handlers. Without these, an uncaught exception or unhandled
// promise rejection in a background worker (e.g. inside a conversion's
// processFile) silently kills the Node process — the structured log
// captures nothing and the UI sees ERR_CONNECTION_REFUSED. With these,
// the stack trace lands in webui.log and (for rejections) the process
// keeps running so in-flight work isn't lost.
// ──────────────────────────────────────────────────────────────────────
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

// Classic Levenshtein edit distance. Used to suggest likely COBOL typos
// (e.g. PRINT-REX vs PRINT-REC) when the compiler reports an undefined
// identifier. Bails out early if the lengths differ by more than 2 —
// we only care about distance <= 1, occasionally 2.
function editDistance(a, b) {
    a = String(a); b = String(b);
    if (Math.abs(a.length - b.length) > 2) return 99;
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

// Middleware
// 2MB body cap — default is 100KB, which can trip on POST /api/convert-azure
// when a user selects a few thousand files (the body is a selectedFiles path
// list, not file contents, but long paths × large selections can exceed 100KB
// and Express returns a silent 413 that looks like a network failure in the UI).
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Path to the scanner script
const SCANNER_SCRIPT = path.join(__dirname, '..', 'cobol_repo_scanner.sh');

// Helper function to convert to PascalCase for Java class names
function toPascalCase(str) {
    return str
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

// Normalize a Java source so its public class matches the file name.
// The file on disk is named after the COBOL basename (PascalCase); `java <cls>`
// requires the public class name to match. This handles:
//   - AI returning a completely different class name (e.g. CardAuthorization
//     instead of COPAUA0C) — detected from the `public class` declaration.
//   - AI returning the COBOL basename verbatim (not PascalCase) — upper/lower
//     case variants of the basename get rewritten.
// Used by both the initial conversion path AND the auto-repair path so a fixed
// Java file with a preserved-but-wrong class name still produces a runnable file.
function normalizeClassName(javaCode, javaClassName, baseName) {
    if (!javaCode) return javaCode;
    let out = javaCode;

    // Step 1: if the declared public class name differs from the target, rewrite
    // every reference (decl, ctor, new X(), type refs, static calls).
    const classNameMatch = out.match(/public\s+class\s+(\w+)\s*\{/);
    const aiGeneratedClassName = classNameMatch ? classNameMatch[1] : null;
    if (aiGeneratedClassName && aiGeneratedClassName !== javaClassName) {
        console.log(`   🔧 Fixing class name: ${aiGeneratedClassName} → ${javaClassName}`);
        const rename = (pattern) => {
            out = out.replace(pattern, (m, a, b) => `${a}${javaClassName}${b !== undefined ? b : ''}`);
        };
        rename(new RegExp(`(public\\s+class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'));
        rename(new RegExp(`(class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'));
        rename(new RegExp(`(public\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'));
        rename(new RegExp(`(new\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'));
        rename(new RegExp(`(^|[\\s,\\(])${aiGeneratedClassName}(\\s+\\w+\\s*[=;,\\)])`, 'gm'));
        rename(new RegExp(`(^|[\\s\\(])${aiGeneratedClassName}(\\.\\w+)`, 'gm'));
    }

    // Step 2: rewrite all case-variant references to the basename itself.
    // Catches things like `class CBL0001 {` or `new cbl0001()` that survived
    // step 1 because the AI used the raw COBOL name as the class.
    const variants = [baseName, baseName.toLowerCase(), baseName.toUpperCase()];
    for (const variant of variants) {
        out = out.replace(new RegExp(`(public\\s+class\\s+)${variant}(\\s*\\{)`, 'gi'), `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(class\\s+)${variant}(\\s*\\{)`, 'gi'),            `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(public\\s+)${variant}(\\s*\\()`, 'gi'),            `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(new\\s+)${variant}(\\s*\\()`, 'gi'),               `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(^|[\\s,\\(])${variant}(\\s+\\w+\\s*[=;,\\)])`, 'gim'), `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(^|[\\s\\(])${variant}(\\.\\w+)`, 'gim'),               `$1${javaClassName}$2`);
    }

    return out;
}

// Store active conversions
const activeConversions = new Map();
const CHECKPOINT_DIR = path.join(os.tmpdir(), 'cobol_converter_checkpoints');
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

// ─── Persistence: save/restore conversion state across restarts ──────────
function checkpointPath(id) { return path.join(CHECKPOINT_DIR, `${id}.json`); }

function saveCheckpoint(id) {
    const conv = activeConversions.get(id);
    if (!conv) return;
    if (conv.status === 'completed' && !conv.completedAt) conv.completedAt = Date.now();
    // Serialize everything EXCEPT Promises (pendingReview resolvers) and functions
    const safe = {
        status: conv.status,
        cancelled: conv.cancelled,
        logs: conv.logs,
        result: conv.result,
        useAzureAI: conv.useAzureAI,
        reviewMode: conv.reviewMode,
        reviewGlob: conv.reviewGlob,
        reviewHistory: conv.reviewHistory,
        tokens: conv.tokens,
        risks: conv.risks,
        postReview: conv.postReview,
        graph: conv.graph,
        fileStates: conv.fileStates,
        fileTimeline: conv.fileTimeline,    // per-file phase history (for the
                                            // slide-out panel — restored across
                                            // restarts so past conversions stay
                                            // inspectable).
        currentFiles: conv.currentFiles,
        inputPath: conv.inputPath,
        startedAt: conv.startedAt,
        completedAt: conv.completedAt
    };
    try {
        fs.writeFileSync(checkpointPath(id), JSON.stringify(safe));
    } catch {}
}

function loadCheckpoints() {
    try {
        const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf-8'));
                const id = f.replace('.json', '');
                // Only restore completed conversions (can't resume in-flight ones — promises are lost)
                if (data.status === 'completed') {
                    data.pendingReview = {};
                    activeConversions.set(id, data);
                }
            } catch {}
        }
        console.log(`   Restored ${activeConversions.size} completed conversion(s) from checkpoint`);
    } catch {}
}

loadCheckpoints();

// API: Start conversion
app.post('/api/convert', async (req, res) => {
    const { repoUrl } = req.body;

    if (!repoUrl || repoUrl.trim() === '') {
        return res.status(400).json({ error: 'Repository URL or path is required' });
    }

    const conversionId = Date.now().toString();
    const outputDir = path.join(os.tmpdir(), `cobol_output_${conversionId}`);

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Initialize conversion status
    activeConversions.set(conversionId, {
        status: 'running',
        logs: [],
        result: null,
        startedAt: Date.now()
    });

    // Run the scanner script
    const process = spawn('bash', [SCANNER_SCRIPT, repoUrl.trim(), outputDir], {
        cwd: path.dirname(SCANNER_SCRIPT)
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        const conversion = activeConversions.get(conversionId);
        if (conversion) {
            conversion.logs.push(text);
        }
    });

    process.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    process.on('close', (code) => {
        const conversion = activeConversions.get(conversionId);
        if (conversion) {
            conversion.status = 'completed';
            conversion.completedAt = Date.now();
            conversion.result = parseOutput(stdout, outputDir);
            // Compile-gate: cobj usually produces compilable Java, but assume
            // nothing — flip any `SUCCESS` entry whose .java actually fails
            // javac to COMPILE_FAIL with the real error, so the UI stops
            // showing green on broken files. Matches the Azure path's gate.
            try {
                runCompileGateOnReport(conversion.result);
            } catch (e) {
                console.warn('Local-path compile-gate errored (non-fatal):', e.message);
            }
        }
    });

    res.json({ conversionId, outputDir });
});

// API: Start conversion using Azure AI Agent
// Convert a simple glob (* and **) to a RegExp anchored to the full string.
// Only supports the subset we need: * = [^/]*  and  ** = .*
function globToRegex(glob) {
    if (!glob || typeof glob !== 'string') return null;
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 2; continue; }
        if (c === '*')                         { re += '[^/]*'; i++; continue; }
        if (c === '?')                         { re += '[^/]'; i++; continue; }
        if ('\\^$+.()|{}[]'.includes(c))       { re += '\\' + c; i++; continue; }
        re += c; i++;
    }
    try { return new RegExp('^' + re + '$', 'i'); } catch { return null; }
}

// API: Cancel an in-flight conversion. Sets a flag the worker checks at batch boundaries.
app.post('/api/cancel/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    if (conversion.status === 'completed') {
        return res.json({ ok: true, alreadyCompleted: true });
    }
    conversion.cancelled = true;
    // Resolve any pending HITL reviews so the worker doesn't deadlock waiting for them
    if (conversion.pendingReview) {
        for (const [fileId, item] of Object.entries(conversion.pendingReview)) {
            try { item.resolve({ action: 'reject', note: 'Cancelled' }); } catch {}
        }
    }
    res.json({ ok: true });
});

// API: List bundled sample repos (portable, server-side resolved).
app.get('/api/samples', (req, res) => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const samples = [
        {
            id: 'small',
            name: 'Small sample',
            description: '~7 COBOL files + copybooks (auth subsystem)',
            path: path.join(repoRoot, 'opensourcecobol4j', 'carddemo-app', 'app-authorization-ims-db2-mq')
        },
        {
            id: 'carddemo',
            name: 'Full CardDemo',
            description: '~40 COBOL files (full mainframe demo app)',
            path: path.join(repoRoot, 'opensourcecobol4j', 'carddemo-app')
        }
    ].filter(s => fs.existsSync(s.path));
    res.json({ samples });
});

// API: Pre-conversion scan — clone (if needed), enumerate files, return for selection.
// Caller then POSTs to /api/convert-azure with { repoUrl: <localPath>, selectedFiles: [...] }
app.post('/api/scan-repo', async (req, res) => {
    const { repoUrl } = req.body || {};
    if (!repoUrl || !repoUrl.trim()) {
        return res.status(400).json({ error: 'Repository URL or path is required' });
    }
    try {
        let inputPath = repoUrl.trim();
        let cloned = false;
        if (inputPath.startsWith('http') || inputPath.startsWith('git@')) {
            const cloneDir = path.join(os.tmpdir(), `repo_scan_${Date.now()}`);
            const { execSync } = require('child_process');
            execSync(`git clone --depth 1 "${inputPath}" "${cloneDir}"`, { timeout: 60000 });
            inputPath = cloneDir;
            cloned = true;
        }
        if (!fs.existsSync(inputPath)) {
            return res.status(404).json({ error: 'Path not found: ' + inputPath });
        }

        const allFiles = azureAgent.scanForAllMainframeFiles(inputPath);
        const toEntry = (absPath, type) => {
            const relPath = path.relative(inputPath, absPath);
            let sizeBytes = 0;
            try { sizeBytes = fs.statSync(absPath).size; } catch {}
            return { path: relPath, sourcePath: absPath, type, sizeBytes };
        };
        const files = [
            ...allFiles.cobolFiles.map(p => toEntry(p, 'cobol')),
            ...allFiles.copybookFiles.map(p => toEntry(p, 'copybook')),
            ...allFiles.jclFiles.map(p => toEntry(p, 'jcl')),
            ...allFiles.dataFiles.map(p => toEntry(p, 'data')),
            ...allFiles.otherFiles.map(p => toEntry(p, 'other'))
        ];
        const counts = {
            cobol: allFiles.cobolFiles.length,
            copybook: allFiles.copybookFiles.length,
            jcl: allFiles.jclFiles.length,
            data: allFiles.dataFiles.length,
            other: allFiles.otherFiles.length,
            total: files.length
        };
        res.json({
            ok: true,
            inputPath,
            cloned,
            counts,
            files
        });
    } catch (err) {
        res.status(500).json({ error: 'Scan failed: ' + err.message });
    }
});

app.post('/api/convert-azure', async (req, res) => {
    const { repoUrl, reviewMode, reviewGlob, selectedFiles } = req.body;

    if (!repoUrl || repoUrl.trim() === '') {
        return res.status(400).json({ error: 'Repository URL or path is required' });
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
        logs: ['🤖 Starting AI-powered conversion...\n'],
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
            // Determine input path
            let inputPath = repoUrl.trim();

            // If it's a git URL, clone it first
            if (inputPath.startsWith('http') || inputPath.startsWith('git@')) {
                conversion.logs.push('📥 Cloning repository...\n');
                const cloneDir = path.join(os.tmpdir(), `repo_${conversionId}`);
                const { execSync } = require('child_process');
                try {
                    execSync(`git clone --depth 1 "${inputPath}" "${cloneDir}"`, { timeout: 60000 });
                    inputPath = cloneDir;
                    conversion.logs.push('✅ Repository cloned successfully\n');
                } catch (cloneErr) {
                    conversion.logs.push(`❌ Failed to clone repository: ${cloneErr.message}\n`);
                    conversion.status = 'completed';
                    conversion.result = results;
                    return;
                }
            }

            if (!fs.existsSync(inputPath)) {
                conversion.logs.push(`❌ Path not found: ${inputPath}\n`);
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }

            // Scan for ALL mainframe files (COBOL, Copybooks, JCL, data, etc.)
            conversion.logs.push('🔍 Scanning for mainframe files...\n');
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
                conversion.logs.push(`🎯 User selection: converting ${cobolFiles.length} of ${beforeCount} COBOL files\n`);
            }

            // Calculate totals
            const totalMainframeFiles = cobolFiles.length +
                allFiles.copybookFiles.length +
                allFiles.jclFiles.length +
                allFiles.dataFiles.length +
                allFiles.otherFiles.length;

            results.totalFiles = cobolFiles.length;

            // Log file breakdown
            conversion.logs.push(`📁 Found ${totalMainframeFiles} mainframe-related files:\n`);
            conversion.logs.push(`   • COBOL programs: ${cobolFiles.length} (will be converted)\n`);
            if (allFiles.copybookFiles.length > 0) {
                conversion.logs.push(`   • Copybooks (.cpy): ${allFiles.copybookFiles.length} (skipped)\n`);
            }
            if (allFiles.jclFiles.length > 0) {
                conversion.logs.push(`   • JCL files: ${allFiles.jclFiles.length} (skipped)\n`);
            }
            if (allFiles.dataFiles.length > 0) {
                conversion.logs.push(`   • Data files: ${allFiles.dataFiles.length} (skipped)\n`);
            }
            if (allFiles.otherFiles.length > 0) {
                conversion.logs.push(`   • Other files: ${allFiles.otherFiles.length} (skipped)\n`);
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
                conversion.logs.push('⚠️ No COBOL files found in the repository\n');
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }

            // ─── Build dependency graph for live visualization ───────────────
            // Nodes: every COBOL program + copybook. Edges: COPY / CALL refs.
            const idOf = (p) => path.relative(inputPath, p);
            const graphNodes = [];
            const graphEdges = [];
            const fileStates = {};
            const nameIndex = {}; // upper-cased basename → node id

            for (const p of cobolFiles) {
                const id = idOf(p);
                graphNodes.push({
                    id, label: path.basename(p), type: 'program', path: p,
                    reason: 'COBOL program (.cbl) — will be converted to Java'
                });
                fileStates[id] = 'pending';
                nameIndex[path.basename(p, path.extname(p)).toUpperCase()] = id;
            }
            for (const p of allFiles.copybookFiles) {
                const id = idOf(p);
                graphNodes.push({
                    id, label: path.basename(p), type: 'copybook', path: p,
                    reason: 'Copybook (.cpy) — included as a Java model when referenced by a converted program'
                });
                fileStates[id] = 'skipped';
                nameIndex[path.basename(p, path.extname(p)).toUpperCase()] = id;
            }

            // First pass: read each COBOL file once, cache content, extract PROGRAM-ID.
            // CALL statements resolve by PROGRAM-ID (not filename) at runtime, so we
            // must index by both for the graph to reflect real dependencies.
            const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
            const fileContents = new Map(); // p -> source text
            for (const p of cobolFiles) {
                let content = '';
                try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }
                fileContents.set(p, content);
                const m = content.match(programIdRe);
                if (m) {
                    const pid = m[1].toUpperCase();
                    // Don't clobber an existing filename→id mapping with a different file's PROGRAM-ID
                    if (!nameIndex[pid]) nameIndex[pid] = idOf(p);
                }
            }

            const copyRe = /COPY\s+['"]?([A-Z0-9_-]+)['"]?/gi;
            const callRe = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
            // ─── Data-file dependency detection ──────────────────────────
            // Parse `SELECT … ASSIGN TO '<name>'` in each COBOL program and
            // match against scanned data files. These data dependencies become
            // first-class graph nodes (type 'data') with edges from the program
            // that reads/writes them. Used by:
            //   - the run endpoint (stages matched data files into the work dir
            //     so SELECTs actually find real files)
            //   - the AI conversion context (model knows which data files exist
            //     and can generate proper FileReader paths)
            //   - the UI graph (user sees "CBL0011 → ACCTREC.dat" dependency)
            const assignRe = /SELECT\s+[\w-]+\s+ASSIGN\s+TO\s+(?:['"]([^'"]+)['"]|([A-Z0-9_-]+))/gi;
            // Data files the scanner already identified in the repo
            const dataPool = allFiles.dataFiles.concat(allFiles.otherFiles).map(p => ({
                path: p,
                base: path.basename(p).toUpperCase(),
                stem: path.basename(p, path.extname(p)).toUpperCase()
            }));
            const dataNodeById = {}; // id → true (to avoid duplicate nodes)
            const dataFileLookup = {}; // UPPERCASE expected name → matched absolute path

            for (const p of cobolFiles) {
                const content = fileContents.get(p);
                if (!content) continue;
                const sourceId = idOf(p);
                const seen = new Set();
                let m;
                while ((m = copyRe.exec(content)) !== null) {
                    const target = nameIndex[m[1].toUpperCase()];
                    if (target && target !== sourceId && !seen.has('c|' + target)) {
                        graphEdges.push({ source: sourceId, target, kind: 'copy' });
                        seen.add('c|' + target);
                    }
                }
                while ((m = callRe.exec(content)) !== null) {
                    const target = nameIndex[m[1].toUpperCase()];
                    if (target && target !== sourceId && !seen.has('l|' + target)) {
                        graphEdges.push({ source: sourceId, target, kind: 'call' });
                        seen.add('l|' + target);
                    }
                }
                // SELECT … ASSIGN TO — data file references
                while ((m = assignRe.exec(content)) !== null) {
                    const raw = (m[1] || m[2] || '').trim();
                    if (!raw || /^(PRINTER|CONSOLE|RANDOM|DISK|TAPE|STDIN|STDOUT|DISPLAY)$/i.test(raw)) continue;
                    const expected = raw.toUpperCase();
                    // Match against scanned data files (exact base, stem, or with .txt/.dat suffix)
                    const hit = dataPool.find(e =>
                        e.base === expected
                        || e.stem === expected
                        || e.base === expected + '.TXT'
                        || e.base === expected + '.DAT'
                    );
                    if (!hit) continue;
                    const dataId = idOf(hit.path);
                    dataFileLookup[expected] = hit.path;
                    // Lazily create the data node (not already in graphNodes)
                    if (!dataNodeById[dataId]) {
                        graphNodes.push({
                            id: dataId,
                            label: path.basename(hit.path),
                            type: 'data',
                            path: hit.path,
                            reason: `Data file referenced via SELECT … ASSIGN TO '${raw}'`
                        });
                        fileStates[dataId] = 'skipped';
                        dataNodeById[dataId] = true;
                    }
                    const edgeKey = 'd|' + sourceId + '->' + dataId;
                    if (!seen.has(edgeKey)) {
                        graphEdges.push({ source: sourceId, target: dataId, kind: 'data', via: raw });
                        seen.add(edgeKey);
                    }
                }
            }

            // ─── JCL-derived data-file mapping ───────────────────────────
            // Real enterprise COBOL doesn't encode filesystem paths in
            // SELECT/ASSIGN. It uses DD names, and the JCL job maps each DD
            // to a real dataset (e.g. //ACCTREC DD DSN=&SYSUID..DATA). Parse
            // every JCL file in the repo and add the DD→file mappings to
            // the data-file lookup, so SELECT ACCT-REC ASSIGN TO ACCTREC
            // correctly resolves to Labs/data/data (renamed ACCTREC at run).
            // Per-program JCL invocation context. Keyed by UPPERCASE PROGRAM-ID;
            // each entry lists every JCL step that invokes this program and the
            // DDs it stages. Fed into the AI conversion prompt so a COBOL
            // `SELECT … ASSIGN TO FOO` becomes a Java file path of `FOO`
            // (matching the JCL DD name) with a comment pointing at the real
            // DSN — not a guessed filename. Without this the AI has to invent
            // paths and produces unstageable file references.
            const jclContextByProgram = {};
            const addJclInvocation = (pgm, jclFile, stepName, dds) => {
                const key = pgm.toUpperCase();
                (jclContextByProgram[key] = jclContextByProgram[key] || []).push({
                    jclFile: path.relative(inputPath, jclFile),
                    stepName,
                    dds: dds.map(d => ({
                        name: d.name,
                        dsn:  d.dsn || null,
                        disp: d.disp || null,
                        sysout: !!d.sysout
                    }))
                });
            };

            for (const jclPath of allFiles.jclFiles) {
                try {
                    const jcl = fs.readFileSync(jclPath, 'utf-8');
                    const parsed = parseJcl(jcl);
                    if (!parsed) continue;
                    for (const step of parsed.steps || []) {
                        // Record which program this step invokes and the DDs
                        // staged for it — used by the AI conversion context.
                        if (step.exec && step.exec.pgm) {
                            addJclInvocation(step.exec.pgm, jclPath, step.name, step.dds || []);
                        }

                        for (const dd of step.dds || []) {
                            if (!dd.name || !dd.dsn) continue;
                            // DSN often uses mainframe conventions like &SYSUID..DATA.
                            // For the course repo, `..DATA` resolves to `Labs/data/data`.
                            // We normalize: strip leading symbol, split on dot, take the
                            // last qualifier and look for a repo file matching it.
                            const qual = dd.dsn
                                .replace(/^[&]?[A-Z0-9]+\./i, '')   // drop leading &SYSUID.
                                .split('.')
                                .filter(Boolean)
                                .pop();
                            if (!qual) continue;
                            const candidates = dataPool.filter(e =>
                                e.base.startsWith(qual.toUpperCase())
                                || e.stem === qual.toUpperCase()
                            );
                            if (candidates.length > 0) {
                                const upperDD = dd.name.toUpperCase();
                                if (!dataFileLookup[upperDD]) {
                                    dataFileLookup[upperDD] = candidates[0].path;
                                }
                            }
                        }
                    }
                } catch {}
            }

            conversion.dataFileLookup = dataFileLookup; // used by /api/run
            conversion.jclContext     = jclContextByProgram; // used by processFile
            conversion.graph = { nodes: graphNodes, edges: graphEdges };
            conversion.fileStates = fileStates;
            conversion.currentFiles = [];
            conversion.inputPath = inputPath;
            // ─────────────────────────────────────────────────────────────────


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

                    // Skip if file is too large for a single conversion pass.
                    // The primary convert prompt sends the FULL COBOL source, so
                    // a 200KB file ≈ 65k input tokens. Past ~80k chars we're at
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

                    // ─── Build conversion context so the AI can emit REAL Java calls
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

                    // ─── HITL pause point ─────────────────────────────────
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

                        // ─── Compile + run helper ─────────────────────────────
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

                        // ─── Quality gates: compile-fail OR fabricated-fallback ─
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
                            console.log(`   🔧 Auto-repair pass for ${relativePath} (${repairApplied})`);
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
                                    console.warn(`   ⚠️  Repair pass failed: ${repair && repair.error}`);
                                    pushTimeline(relativePath, 'repair_failed', 'Repair call did not return usable Java', {
                                        error: (repair && repair.error) || 'unknown'
                                    });
                                }
                            } catch (repairErr) {
                                console.warn(`   ⚠️  Repair pass errored: ${repairErr.message}`);
                                pushTimeline(relativePath, 'repair_errored', 'Repair call errored', { error: repairErr.message });
                            }
                        }
                        pushTimeline(relativePath, 'done', compilationError ? 'COMPILE_FAIL' : 'SUCCESS', {
                            totalMs: Date.now() - _t0
                        });

                        // ─── Sibling signature cache ────────────────────────
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

            // ─── Dependency stratification ─────────────────────────────────
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

            conversion.logs.push(`📐 Dependency stratification: ${levels.length} level(s)\n`);
            levels.forEach((lvl, i) => {
                const labels = lvl.map(r => path.basename(r)).join(', ');
                conversion.logs.push(`   Level ${i + 1}: ${lvl.length} file(s) — ${labels}\n`);
            });
            conversion.logs.push(`\n🚀 Processing ${cobolFiles.length} files (deps first, parallel within level)...\n\n`);

            let completedCount = 0;
            for (let lvlIdx = 0; lvlIdx < levels.length; lvlIdx++) {
                if (conversion.cancelled) {
                    conversion.logs.push(`\n🛑 Conversion cancelled by user at level ${lvlIdx + 1}\n`);
                    break;
                }
                const levelRel = levels[lvlIdx];
                const levelAbs = levelRel.map(r => absOfId.get(r));
                conversion.logs.push(`📦 Level ${lvlIdx + 1}/${levels.length}: ${levelAbs.length} file(s)\n`);

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
                            conversion.logs.push(`   ✅ ${fileResult.relativePath}\n`);
                        } else if (fileResult.status === 'skipped_noid' || fileResult.status === 'skipped_small') {
                            conversion.fileStates[relPath] = 'skipped';
                            results.skippedNoId++;
                            results.skippedFiles.push(`${fileResult.relativePath} - No PROGRAM-ID`);
                            conversion.logs.push(`   ⏭️ ${fileResult.relativePath} (skipped)\n`);
                        } else if (fileResult.status === 'error') {
                            conversion.fileStates[relPath] = 'failed';
                            results.skippedError++;
                            results.errorFiles.push(`${fileResult.relativePath} - ${fileResult.error}`);
                            conversion.logs.push(`   ❌ ${fileResult.relativePath}: ${fileResult.error?.substring(0, 50) || 'Error'}\n`);
                        }

                        if (fileResult.reportEntry) {
                            results.report.files.push(fileResult.reportEntry);
                        }
                    }

                    if (i + BATCH_SIZE < levelAbs.length) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }
                }

                conversion.logs.push(`   📊 Progress: ${completedCount}/${cobolFiles.length} files (${Math.round(completedCount / cobolFiles.length * 100)}%)\n\n`);

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
            conversion.logs.push(`📊 Conversion Summary (Azure AI)\n`);
            conversion.logs.push(`${'='.repeat(50)}\n`);
            conversion.logs.push(`Total files scanned: ${results.totalFiles}\n`);
            conversion.logs.push(`✅ Successfully converted: ${results.converted}\n`);
            conversion.logs.push(`📈 Average Conversion Accuracy: ${averageAccuracy}%\n`);
            conversion.logs.push(`Skipped (no PROGRAM-ID): ${results.skippedNoId}\n`);
            if (results.skippedError > 0) {
                conversion.logs.push(`❌ Errors: ${results.skippedError}\n`);
            }
            conversion.logs.push(`\n🤖 Powered by Azure AI Agent\n`);

        } catch (err) {
            conversion.logs.push(`\n❌ Conversion error: ${err.message}\n`);
        }

        // ─── Aggregate conversion risks for the UI ─────────────────────
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

// API: Get conversion status
app.get('/api/status/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);

    if (!conversion) {
        return res.status(404).json({ error: 'Conversion not found' });
    }

    res.json(conversion);
});

// API: HITL — fetch the pending review payload for a single file.
app.get('/api/review/:id/:fileId(*)', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const item = conversion.pendingReview && conversion.pendingReview[req.params.fileId];
    if (!item) return res.status(404).json({ error: 'No pending review for this file' });
    res.json({
        fileId: req.params.fileId,
        cobolSource: item.cobolSource,
        javaCode: item.javaCode,
        queuedAt: item.queuedAt
    });
});

// API: HITL — submit a review decision (approve / reject / edit).
app.post('/api/review/:id/:fileId(*)', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const item = conversion.pendingReview && conversion.pendingReview[req.params.fileId];
    if (!item) return res.status(404).json({ error: 'No pending review for this file' });

    const { action, editedJava, note } = req.body || {};
    if (!['approve', 'reject', 'edit'].includes(action)) {
        return res.status(400).json({ error: 'action must be approve | reject | edit' });
    }
    item.resolve({ action, editedJava, note });
    (conversion.reviewHistory ||= []).push({
        fileId: req.params.fileId, action, at: Date.now(), note: note || null
    });
    saveCheckpoint(req.params.id);
    res.json({ ok: true });
});

// API: HITL — toggle review mode at runtime.
// Turning OFF auto-approves any in-flight pending reviews so the worker proceeds.
// Turning ON means only *subsequent* files will pause — already-converted files are unaffected.
app.post('/api/review-mode/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const { reviewMode, reviewGlob } = req.body || {};
    const wasOn = !!conversion.reviewMode;
    const nowOn = !!reviewMode;
    conversion.reviewMode = nowOn;
    if (typeof reviewGlob === 'string' || reviewGlob === null) {
        conversion.reviewGlob = reviewGlob || null;
        conversion.reviewGlobRe = globToRegex(conversion.reviewGlob);
    }

    // If turning OFF, drain the pending queue by auto-approving everything.
    let drained = 0;
    if (wasOn && !nowOn && conversion.pendingReview) {
        for (const [fileId, item] of Object.entries(conversion.pendingReview)) {
            if (!item || typeof item.resolve !== 'function') continue;
            item.resolve({ action: 'approve', note: 'Auto-approved (review mode turned off)' });
            (conversion.reviewHistory ||= []).push({
                fileId, action: 'approve', at: Date.now(),
                note: 'Auto-approved (review mode turned off)', auto: true
            });
            drained++;
        }
    }
    saveCheckpoint(req.params.id);
    res.json({ ok: true, reviewMode: nowOn, drained });
});

// API: HITL — list everything currently waiting on a human.
app.get('/api/reviews/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const pending = Object.entries(conversion.pendingReview || {}).map(([fileId, item]) => ({
        fileId,
        queuedAt: item.queuedAt
    }));
    res.json({
        pending,
        history: conversion.reviewHistory || [],
        reviewMode: !!conversion.reviewMode,
        reviewGlob: conversion.reviewGlob || null
    });
});

// API: HITL — bulk approve / reject everything currently pending.
app.post('/api/reviews/:id/bulk', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const action = (req.body && req.body.action) || '';
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action must be approve | reject' });
    }
    const note = action === 'reject' ? 'Bulk rejected' : null;
    const fileIds = Object.keys(conversion.pendingReview || {});
    let count = 0;
    for (const fileId of fileIds) {
        const item = conversion.pendingReview[fileId];
        if (!item) continue;
        item.resolve({ action, note });
        (conversion.reviewHistory ||= []).push({
            fileId, action, at: Date.now(), note, bulk: true
        });
        count++;
    }
    res.json({ ok: true, count });
});

// API: HITL — review history (audit trail).
app.get('/api/reviews/:id/history', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    res.json({ history: conversion.reviewHistory || [] });
});

// API: Live dependency graph + per-file state for the graph view.
// Lightweight — returns nodes/edges once, then just states on subsequent polls.
app.get('/api/graph/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) {
        return res.status(404).json({ error: 'Conversion not found' });
    }
    if (!conversion.graph) {
        // Scan hasn't built the graph yet
        return res.json({ ready: false, status: conversion.status });
    }
    const includeGraph = req.query.full === '1';
    // Optional: include one file's timeline (avoids shipping 30+ timelines
    // on every poll — we only send the currently-inspected file's).
    let timeline = null;
    if (req.query.file && conversion.fileTimeline) {
        timeline = conversion.fileTimeline[req.query.file] || [];
    }
    res.json({
        ready: true,
        status: conversion.status,
        graph: includeGraph ? conversion.graph : undefined,
        fileStates: conversion.fileStates,
        currentFiles: conversion.currentFiles || [],
        tokens: conversion.tokens || null,
        risks: conversion.risks || null,
        timeline
    });
});

// API: Dedicated per-file timeline. Separate from /api/graph to keep poll
// payloads small — the UI fetches this only when the user opens a node's
// slide-out panel.
app.get('/api/file-timeline/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const rel = req.query.file;
    if (!rel) return res.status(400).json({ error: 'file (relative path) required' });
    res.json({
        file: rel,
        timeline: (conversion.fileTimeline && conversion.fileTimeline[rel]) || [],
        state: (conversion.fileStates && conversion.fileStates[rel]) || null
    });
});

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

    // ─── Data-file dependency staging ──────────────────────────────────
    // The graph-building step already found which `SELECT … ASSIGN TO`
    // targets resolve to real files in the repo (stored in
    // `conversion.dataFileLookup`). We use those mappings to stage the
    // files into both work dirs before either program runs — Java in the
    // pre-run setup, COBOL in the temp work dir right before exec.
    // Fallback to live re-parsing if the lookup wasn't built (older
    // conversions, cancelled runs).
    const dataAssignments = []; // { expected, matchedPath, variants }
    try {
        const buildVariants = (expected) =>
            [expected, expected + '.txt', expected + '.dat', expected.toUpperCase(), expected.toLowerCase()];
        const srcText = fs.existsSync(reportFile.source_path) ? fs.readFileSync(reportFile.source_path, 'utf-8') : '';
        const assignRe = /SELECT\s+[\w-]+\s+ASSIGN\s+TO\s+(?:['"]([^'"]+)['"]|([A-Z0-9_-]+))/gi;
        const expected = new Set();
        let am;
        while ((am = assignRe.exec(srcText)) !== null) {
            const n = (am[1] || am[2] || '').trim();
            if (!n || /^(PRINTER|CONSOLE|RANDOM|DISK|TAPE|STDIN|STDOUT|DISPLAY)$/i.test(n)) continue;
            expected.add(n);
        }
        const lookup = conversion.dataFileLookup || {};
        for (const exp of expected) {
            const cached = lookup[exp.toUpperCase()];
            if (cached && fs.existsSync(cached)) {
                dataAssignments.push({ expected: exp, matchedPath: cached, variants: buildVariants(exp) });
                continue;
            }
            // Fallback: search the full report for a match
            const pool = (conversion.result.report.files || [])
                .filter(f => f.source_path && (f.java_status === 'SKIPPED_DATA' || f.java_status === 'SKIPPED_OTHER') && fs.existsSync(f.source_path))
                .map(f => f.source_path);
            const hit = pool.find(p => {
                const base = path.basename(p).toUpperCase();
                const stem = path.basename(p, path.extname(p)).toUpperCase();
                const E = exp.toUpperCase();
                return base === E || stem === E || base === E + '.TXT' || base === E + '.DAT';
            });
            if (hit) dataAssignments.push({ expected: exp, matchedPath: hit, variants: buildVariants(exp) });
        }
    } catch { /* non-fatal */ }
    // Stage data into the Java work dir up front
    if (reportFile.work_dir && fs.existsSync(reportFile.work_dir)) {
        for (const d of dataAssignments) {
            for (const v of d.variants) {
                const dest = path.join(reportFile.work_dir, v);
                if (!fs.existsSync(dest)) {
                    try { fs.copyFileSync(d.matchedPath, dest); } catch {}
                }
            }
        }
    }

    // ─── Run Java ──────────────────────────────────────────────────────
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

    // ─── Run COBOL (best-effort, requires cobc/GnuCOBOL) ───────────────
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
                // Track what was modified in the preprocess pass, so we can
                // surface it to the UI. Currently we fix/strip:
                //   - missing periods on PROGRAM-ID/AUTHOR/… header paragraphs
                //   - EXEC SQL … END-EXEC blocks (needs DB2 preprocessor — we
                //     don't have one; comment them out so cobc can still
                //     compile the non-SQL body)
                //   - EXEC CICS / EXEC DLI / EXEC MQ blocks (same rationale)
                const preprocessMods = { periodsAdded: 0, execBlocksStripped: 0 };
                const preprocessSource = (srcPath) => {
                    try {
                        const orig = fs.readFileSync(srcPath, 'utf-8');
                        const lines = orig.split(/\r?\n/);

                        // Step 1: normalize header paragraphs. GnuCOBOL trips
                        // on both (a) missing trailing period and (b) embedded
                        // periods inside author/installation names like
                        // "AUTHOR.   Otto B. Relational." where "Otto B." has
                        // an inner period and confuses the parser. Fix: for
                        // IDENTIFICATION-DIVISION commentary paragraphs
                        // (AUTHOR / INSTALLATION / DATE-WRITTEN / etc.), keep
                        // just the paragraph header with a period and drop
                        // whatever value followed. PROGRAM-ID is preserved
                        // (it carries the actual program name).
                        const COMMENTARY_HEADERS = /^(\s*)(AUTHOR|DATE-WRITTEN|DATE-COMPILED|INSTALLATION|SECURITY|REMARKS)\s*\.(.*)$/i;
                        for (let i = 0; i < lines.length; i++) {
                            const l = lines[i];
                            const m = l.match(COMMENTARY_HEADERS);
                            if (m) {
                                const indent = m[1];
                                const kw = m[2].toUpperCase();
                                const rest = m[3];
                                // If there's anything after the period on this line OR
                                // the continuation extends across following lines (common
                                // for AUTHOR), collapse the value to empty.
                                if (rest.trim().length > 0) {
                                    lines[i] = indent + kw + '.';
                                    preprocessMods.periodsAdded++;
                                }
                                continue;
                            }
                            // PROGRAM-ID period-repair: Fixed-format COBOL
                            // ignores cols 73+ (Identification Area). A
                            // trailing `.` at col 75 — common in mainframe
                            // sources — is invisible to cobc. So:
                            //   1. consider only the first 72 cols when
                            //      deciding if the statement terminator is
                            //      present, and
                            //   2. normalize the line to `PROGRAM-ID. NAME.`
                            //      so the terminator lands well within area B.
                            const progRe = /^(\s*)PROGRAM-ID\s*\.\s*([A-Za-z0-9_-]+)/i;
                            const pm = l.match(progRe);
                            if (pm) {
                                const contentInAreaB = l.slice(0, 72);
                                // Does the statement-terminating period live in
                                // the compiler-visible range? Ignore trailing
                                // whitespace and the 73+ "comment" slice.
                                if (!/\.\s*$/.test(contentInAreaB.trimEnd())) {
                                    lines[i] = pm[1] + 'PROGRAM-ID. ' + pm[2] + '.';
                                    preprocessMods.periodsAdded++;
                                }
                            }
                        }

                        // Step 2: strip EXEC SQL/CICS/DLI/MQ …  END-EXEC blocks.
                        // GnuCOBOL has no preprocessor for these, so without
                        // stripping they cause syntax errors and the whole
                        // program fails to compile — preventing ANY runtime
                        // comparison. We replace each block with a COBOL
                        // comment ('*' in col 7) noting the removal, so:
                        //   (a) cobc can compile the rest of the program
                        //   (b) the user can see in the patched file that we
                        //       touched it (and understand why COBOL output
                        //       differs from what DB2/CICS would produce).
                        let inExec = false;
                        let execKind = '';
                        for (let i = 0; i < lines.length; i++) {
                            const l = lines[i];
                            if (!inExec) {
                                const m = l.match(/^(\s*(?:\d+\s+)?)\s*EXEC\s+(SQL|CICS|DLI|MQ)\b/i);
                                if (m) {
                                    inExec = true;
                                    execKind = m[2].toUpperCase();
                                    lines[i] = '      * ' + `[stripped by c2j: ${execKind} directive — gnucobol has no preprocessor for this in local compile]`;
                                    // Single-line block?
                                    if (/\bEND-EXEC\b/i.test(l)) {
                                        inExec = false;
                                        preprocessMods.execBlocksStripped++;
                                    }
                                    continue;
                                }
                            } else {
                                if (/\bEND-EXEC\b/i.test(l)) {
                                    lines[i] = '      * ' + `[stripped: end of ${execKind} block]`;
                                    inExec = false;
                                    preprocessMods.execBlocksStripped++;
                                } else {
                                    lines[i] = '      * ' + `[stripped: inside ${execKind} block] ` + l.trim().slice(0, 120);
                                }
                            }
                        }

                        const patched = lines.join('\n');
                        if (patched === orig) return srcPath;
                        const outName = path.join(cobolWork, 'patched_' + path.basename(srcPath));
                        fs.writeFileSync(outName, patched, 'utf-8');
                        return outName;
                    } catch { return srcPath; }
                };

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
                if (hasMultiple) {
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

                    // Surface what the preprocessor touched so the user knows
                    // why the COBOL may still fail (or why its behavior is
                    // reduced vs. the real mainframe output).
                    const modsNote = (preprocessMods.periodsAdded || preprocessMods.execBlocksStripped)
                        ? `\n\nPreprocessor mods applied: ${preprocessMods.periodsAdded} header-period fix(es), ${preprocessMods.execBlocksStripped} EXEC SQL/CICS/DLI block(s) stripped (local gnucobol has no preprocessor for those).`
                        : '';
                    // If we stripped SQL/CICS/DLI blocks AND the remaining
                    // compile error references variables those blocks normally
                    // declare (SQLCODE, SQLCA, DFHCOMMAREA, PCB-*), surface a
                    // clear "cannot run locally" message instead of dumping
                    // raw compiler spew the user can't act on. GnuCOBOL has
                    // no DB2/CICS/IMS preprocessor — the program is simply
                    // unrunnable locally and the user should compare against
                    // the Java output + AI verdict.
                    const stripCascade = preprocessMods.execBlocksStripped > 0
                        && /\b(SQLCODE|SQLCA|SQLSTATE|SQLERRM|DFHCOMMAREA|DFHAID|PCB-[A-Z0-9_-]+)\b.*not defined/i.test(lastErr);
                    let friendlyNote = '';
                    if (stripCascade) {
                        // ASCII-only separator — em-dashes sometimes render as
                        // mojibake (replacement char) through certain toolchain
                        // code-page paths. Equals + dashes reproduce the visual
                        // break safely across every terminal/browser/font.
                        friendlyNote = '\n\n' + '='.repeat(60) + '\n'
                            + 'This program uses DB2 SQL / CICS / IMS constructs that require a\n'
                            + 'mainframe preprocessor (DB2 precompiler / CICS translator / DLI).\n'
                            + 'GnuCOBOL does not have those preprocessors, so the program cannot\n'
                            + 'be compiled or run locally for a direct COBOL-vs-Java comparison.\n\n'
                            + '-> Use the Java output (which simulates these constructs with TODO\n'
                            + '   markers) and the AI verdict above for semantic comparison.\n'
                            + '='.repeat(60);
                    }
                    result.cobol = {
                        ok: false,
                        output: '',
                        error: (stripCascade
                            ? 'COBOL cannot run locally: requires DB2/CICS/IMS preprocessor.'
                            : 'COBOL compile failed (tried all dialect/format combinations):\n' + lastErr)
                            + typoHint + modsNote + friendlyNote
                    };
                } else if (compiled) {
                    log('cobol-compile', 'ok', {
                        file: reportFile.path,
                        periodsAdded: preprocessMods.periodsAdded,
                        execBlocksStripped: preprocessMods.execBlocksStripped
                    });
                }
                if (!result.cobol && compiled) {
                    // Stage the same data files into the COBOL work dir that we
                    // staged into the Java work dir earlier. libcob looks for
                    // SELECT-ASSIGN targets relative to cwd, so each expected
                    // name is copied in multiple variants (raw, .txt, .dat,
                    // upper, lower).
                    for (const d of dataAssignments) {
                        for (const v of d.variants) {
                            const dest = path.join(cobolWork, v);
                            try { fs.copyFileSync(d.matchedPath, dest); } catch {}
                        }
                    }

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
                            : null
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

// API: Post-conversion sign-off — record human approval/rejection on a converted file.
app.post('/api/post-review/:id/:fileId(*)', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    const { action, note } = req.body || {};
    if (!['approve', 'reject', 'note'].includes(action)) {
        return res.status(400).json({ error: 'action must be approve | reject | note' });
    }
    conversion.postReview = conversion.postReview || {};
    conversion.postReview[req.params.fileId] = {
        action, note: note || null, at: Date.now()
    };
    res.json({ ok: true });
});

app.get('/api/post-review/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    res.json({ postReview: conversion.postReview || {} });
});

// ──────────────────────────────────────────────────────────────────────
// File classification for MANUAL_REVIEW.md
//
// For every non-COBOL artifact shipped in the repo we need to tell the user
// one of three things: (a) port it to the target stack, (b) carry it forward
// as-is, (c) discard / ignore. The map below pairs extensions with a category
// + short recommendation. Unknown types fall through to a "review manually"
// catch-all.
// ──────────────────────────────────────────────────────────────────────
function classifyArtifact(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath).toLowerCase();

    // Mainframe orchestration / data
    if (/\.(jcl|proc)$/i.test(ext)) return {
        category: 'Mainframe orchestration (JCL)',
        action: 'PORT',
        recommendation: 'JCL is not COBOL — parse each step (EXEC PGM=…) and map it to Spring Batch, Airflow, Kubernetes CronJob, or a shell script. DD statements → input/output paths. See the JCL analyzer in the UI for per-file step breakdown.'
    };
    if (/\.(cpy|copy)$/i.test(ext)) return {
        category: 'COBOL copybook',
        action: 'EMBEDDED',
        recommendation: 'Copybooks are shared data definitions. They get embedded into the Java model classes for programs that COPY them — no standalone Java file. If a copybook is not referenced by any converted program, verify the reference was resolvable.'
    };
    if (/\.(dat|csv|txt)$/i.test(ext)) return {
        category: 'Data file',
        action: 'KEEP',
        recommendation: 'Ship alongside the Java as runtime input. Update file paths in Java (BufferedReader/Writer) to point at wherever these will live in production — typically `src/main/resources/` for test data, or a configured external path for real data.'
    };
    if (/\.(bms|mps)$/i.test(ext)) return {
        category: 'BMS screen map (CICS)',
        action: 'PORT',
        recommendation: 'BMS defines terminal screens. Port to a web UI (React / Thymeleaf / JSF) or a Swing/JavaFX form. The converted Java uses console output as a placeholder — replace with a real UI layer.'
    };

    // Other languages / tech — likely part of the repo but orthogonal to COBOL
    if (/\.(py|python)$/i.test(ext)) return {
        category: 'Python source',
        action: 'REVIEW',
        recommendation: 'Python is a separate concern from the COBOL conversion. Either port to Java (if it\'s support tooling) or keep as an out-of-process service called from Java via REST / subprocess.'
    };
    if (/\.(html?|htm)$/i.test(ext)) return {
        category: 'HTML',
        action: 'KEEP',
        recommendation: 'Keep as-is for the web layer. If it\'s static markup, move into `src/main/resources/static/`. If it\'s a template (JSP/Thymeleaf/Mustache), align with your Java framework\'s template directory.'
    };
    if (/\.(css|scss|sass|less)$/i.test(ext)) return {
        category: 'Stylesheet',
        action: 'KEEP',
        recommendation: 'Keep as-is in `src/main/resources/static/` or your frontend build system.'
    };
    if (/\.(js|mjs|ts|tsx|jsx)$/i.test(ext)) return {
        category: 'JavaScript / TypeScript',
        action: 'KEEP',
        recommendation: 'Keep as-is — separate from COBOL. If this is front-end code, move into your frontend build (Vite/Webpack); if it\'s Node tooling, keep as a separate service.'
    };
    if (/\.(sh|bash|zsh)$/i.test(ext)) return {
        category: 'Shell script',
        action: 'REVIEW',
        recommendation: 'If the script invokes COBOL binaries, update to invoke `java -jar` with equivalent arguments. If it\'s general tooling, keep as-is or rewrite in Java if cross-platform is a concern.'
    };
    if (/\.(sql|ddl|db2)$/i.test(ext)) return {
        category: 'SQL / DDL',
        action: 'KEEP',
        recommendation: 'Keep as-is and run via JDBC or a migration tool (Flyway / Liquibase). DB2 DDL may need minor tweaks to land on PostgreSQL/Oracle/MySQL.'
    };
    if (/\.(xml|xsd|wsdl)$/i.test(ext)) return {
        category: 'XML artifact',
        action: 'KEEP',
        recommendation: 'Keep as-is. Parse in Java via JAXB, DOM, or Jackson XML as appropriate.'
    };
    if (/\.(yaml|yml|toml|ini|properties|conf)$/i.test(ext)) return {
        category: 'Config',
        action: 'KEEP',
        recommendation: 'Keep as-is. Load in Java via Spring @ConfigurationProperties or a config library.'
    };
    if (/\.(json)$/i.test(ext)) return {
        category: 'JSON',
        action: 'KEEP',
        recommendation: 'Keep as-is. Parse in Java via Jackson or Gson.'
    };
    if (/\.(md|rst|adoc|txt)$/i.test(ext)) return {
        category: 'Documentation',
        action: 'KEEP',
        recommendation: 'Keep in repo — valuable context for maintainers.'
    };
    if (/\.(png|jpe?g|gif|svg|ico|webp|pdf)$/i.test(ext)) return {
        category: 'Binary asset',
        action: 'KEEP',
        recommendation: 'Keep in repo — serve as static content if needed.'
    };
    if (/\.(class|jar|war|ear)$/i.test(ext)) return {
        category: 'Pre-compiled Java',
        action: 'REVIEW',
        recommendation: 'Existing Java binaries — confirm these don\'t conflict with the newly generated Java classes.'
    };
    if (/\.(c|cc|cpp|h|hpp|go|rs|rb|php|kt|scala|swift)$/i.test(ext)) return {
        category: 'Other source language',
        action: 'REVIEW',
        recommendation: 'Not COBOL and not the target language. Decide whether to port to Java or keep as a separate service/module.'
    };
    if (base === 'makefile' || base.endsWith('.mk')) return {
        category: 'Makefile',
        action: 'REVIEW',
        recommendation: 'Replace with Maven/Gradle build for the Java output. If the Makefile builds native COBOL, those steps become obsolete once migration is complete.'
    };
    if (base.endsWith('.gitignore') || base === 'license' || base === 'license.md' || base === 'copying') {
        return {
            category: 'VCS / license',
            action: 'KEEP',
            recommendation: 'Keep in repo.'
        };
    }

    // Unknown — default to "look at this"
    return {
        category: 'Unknown / other',
        action: 'REVIEW',
        recommendation: 'File type not auto-recognized. Manually inspect and decide: port logic to Java, keep as-is, or discard.'
    };
}

/**
 * Build a comprehensive MANUAL_REVIEW.md that the user can open after
 * unzipping the download. Lists EVERY non-converted file with a category,
 * a recommended action, and specific guidance.
 */
function buildManualReviewMd(files, conversionId) {
    const lines = [];
    lines.push(`# Manual review checklist`);
    lines.push('');
    lines.push(`Conversion ID: \`${conversionId}\``);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`This checklist covers every artifact in the source repository that was`);
    lines.push(`**not** converted to Java. The COBOL conversion handles business logic`);
    lines.push(`only — everything else (JCL jobs, data files, web assets, shell scripts,`);
    lines.push(`SQL, documentation, other languages, etc.) needs a decision from you.`);
    lines.push('');
    lines.push(`## Actions at a glance`);
    lines.push('');
    lines.push(`- **PORT** — rewrite / re-implement in the target stack`);
    lines.push(`- **EMBEDDED** — already handled by the conversion output`);
    lines.push(`- **KEEP** — ship as-is alongside the Java`);
    lines.push(`- **REVIEW** — needs a human decision before moving forward`);
    lines.push('');

    // Partition non-converted artifacts by category
    const nonJava = files.filter(f => f.java_status !== 'SUCCESS');
    const grouped = new Map();   // category → [{ file, classification }]
    const countByAction = { PORT: 0, EMBEDDED: 0, KEEP: 0, REVIEW: 0 };

    for (const f of nonJava) {
        const cls = classifyArtifact(f.source_path || f.path || '');
        countByAction[cls.action] = (countByAction[cls.action] || 0) + 1;
        if (!grouped.has(cls.category)) grouped.set(cls.category, { cls, items: [] });
        grouped.get(cls.category).items.push(f);
    }

    // Summary table
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`| Action | Count |`);
    lines.push(`|--------|-------|`);
    for (const [action, count] of Object.entries(countByAction)) {
        if (count > 0) lines.push(`| ${action} | ${count} |`);
    }
    lines.push('');

    if (grouped.size === 0) {
        lines.push(`_Nothing to review — every file in the repo was successfully converted._`);
        return lines.join('\n');
    }

    // Per-category sections, ordered so PORT/REVIEW show first (highest effort)
    const categoryOrder = [...grouped.entries()].sort(([, a], [, b]) => {
        const weight = { PORT: 0, REVIEW: 1, EMBEDDED: 2, KEEP: 3 };
        return (weight[a.cls.action] ?? 9) - (weight[b.cls.action] ?? 9);
    });

    for (const [category, { cls, items }] of categoryOrder) {
        lines.push(`## ${category} — ${cls.action} (${items.length} file${items.length === 1 ? '' : 's'})`);
        lines.push('');
        lines.push(cls.recommendation);
        lines.push('');
        lines.push(`**Files:**`);
        lines.push('');
        for (const f of items.slice(0, 200)) {
            const status = f.java_status ? ` — \`${f.java_status}\`` : '';
            lines.push(`- \`${f.path}\`${status}`);
        }
        if (items.length > 200) lines.push(`- _…and ${items.length - 200} more_`);
        lines.push('');
    }

    lines.push(`---`);
    lines.push(`_End of checklist._`);
    return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// JCL analysis — JCL is not COBOL and isn't converted, but if the repo
// ships JCL it carries crucial orchestration info (what program runs,
// against which datasets, in what order). We parse it here and surface
// the findings so the user sees more than just "SKIPPED_JCL".
// ──────────────────────────────────────────────────────────────────────

/**
 * Parse a single JCL file into a structured analysis.
 * Extracts:
 *   - jobName: from //JOBNAME JOB ...
 *   - steps: [{ name, exec: { pgm | proc }, dds: [{ name, dsn, disp }] }]
 *   - programs: unique set of PGM= values (for matching to converted Java)
 *   - datasets: unique list of DSN= values
 * Intentionally forgiving — mainframe JCL has many dialects and line-
 * continuation quirks. We catch what we can and move on.
 */
function parseJcl(content) {
    if (!content) return null;
    const lines = content.split(/\r?\n/);
    const out = { jobName: null, steps: [], programs: new Set(), datasets: new Set(), procs: new Set() };
    let currentStep = null;

    const jobRe  = /^\/\/([A-Z0-9#@$]+)\s+JOB\b/i;
    const stepRe = /^\/\/([A-Z0-9#@$]+)\s+EXEC\s+(.*)/i;
    const ddRe   = /^\/\/([A-Z0-9#@$]+)\s+DD\s+(.*)/i;

    for (let raw of lines) {
        if (!raw) continue;
        // Comments / instream data markers
        if (raw.startsWith('//*') || raw.startsWith('/*')) continue;
        if (!raw.startsWith('//')) continue;

        let m;
        if ((m = jobRe.exec(raw))) {
            out.jobName = m[1];
            continue;
        }
        if ((m = stepRe.exec(raw))) {
            if (currentStep) out.steps.push(currentStep);
            currentStep = { name: m[1], exec: {}, dds: [] };
            const args = m[2];
            const pgmM  = /PGM\s*=\s*([A-Z0-9#@$]+)/i.exec(args);
            const procM = /PROC\s*=\s*([A-Z0-9#@$]+)/i.exec(args);
            if (pgmM)  { currentStep.exec.pgm  = pgmM[1];  out.programs.add(pgmM[1].toUpperCase()); }
            else if (procM) { currentStep.exec.proc = procM[1]; out.procs.add(procM[1].toUpperCase()); }
            else {
                // Bare EXEC PROCNAME (no keyword)
                const bare = args.match(/^\s*([A-Z0-9#@$]+)/i);
                if (bare) { currentStep.exec.proc = bare[1]; out.procs.add(bare[1].toUpperCase()); }
            }
            continue;
        }
        if ((m = ddRe.exec(raw))) {
            if (!currentStep) continue;
            const ddName = m[1];
            const args = m[2];
            const dsnM  = /DSN\s*=\s*([^,\s]+)/i.exec(args);
            const dispM = /DISP\s*=\s*([A-Z0-9(),\s]+)/i.exec(args);
            const sysoutM = /SYSOUT\s*=\s*\*/i.exec(args);
            const ddEntry = {
                name: ddName,
                dsn:   dsnM ? dsnM[1] : null,
                disp:  dispM ? dispM[1].trim() : null,
                sysout: !!sysoutM
            };
            currentStep.dds.push(ddEntry);
            if (ddEntry.dsn) out.datasets.add(ddEntry.dsn);
            continue;
        }
    }
    if (currentStep) out.steps.push(currentStep);
    out.programs = [...out.programs];
    out.datasets = [...out.datasets];
    out.procs    = [...out.procs];
    return out;
}

/**
 * API: Analyze a JCL file in the context of a conversion.
 * Returns: { parsed, coverage: [ { program, converted, javaClass? } ], recommendation }
 */
app.get('/api/jcl-analysis', (req, res) => {
    const { conversionId, path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf-8'); }
    catch (e) { return res.status(404).json({ error: 'JCL source not found' }); }

    const parsed = parseJcl(source);
    const result = { parsed, coverage: [], recommendation: null, source };

    // Cross-reference JCL PGM= targets with converted Java classes if we know
    // which conversion the user is viewing.
    if (conversionId && activeConversions.has(conversionId) && parsed) {
        const conversion = activeConversions.get(conversionId);
        const reportFiles = (conversion.result && conversion.result.report && conversion.result.report.report && conversion.result.report.report.files)
                          || (conversion.result && conversion.result.report && conversion.result.report.files)
                          || [];
        // Build a PROGRAM-ID / basename → java_path map
        const pidMap = {};
        const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
        for (const f of reportFiles) {
            if (!f.source_path) continue;
            const base = path.basename(f.source_path, path.extname(f.source_path)).toUpperCase();
            if (!pidMap[base]) pidMap[base] = { javaPath: f.java_path || null, status: f.java_status };
            try {
                const src = fs.readFileSync(f.source_path, 'utf-8');
                const m = src.match(programIdRe);
                if (m) {
                    const pid = m[1].toUpperCase();
                    if (!pidMap[pid]) pidMap[pid] = { javaPath: f.java_path || null, status: f.java_status };
                }
            } catch {}
        }
        for (const pgm of parsed.programs) {
            const hit = pidMap[pgm];
            result.coverage.push({
                program: pgm,
                converted: !!(hit && hit.status === 'SUCCESS'),
                javaClass: hit && hit.javaPath ? path.basename(hit.javaPath, '.java') : null,
                status: hit ? hit.status : 'NOT_IN_CONVERSION'
            });
        }
    }

    // Recommendation heuristic: pick a modern orchestration target based on job shape
    if (parsed) {
        const stepCount = parsed.steps.length;
        const hasSort = parsed.steps.some(s => /SORT/i.test(s.exec.pgm || ''));
        const hasDB2  = parsed.steps.some(s => /DSNMTV01|DSN/i.test(s.exec.pgm || ''));
        if (hasDB2 || stepCount >= 3) {
            result.recommendation = 'Spring Batch job (multi-step with chunk processing). Each JCL step becomes a Spring Batch Step; DD datasets map to ItemReaders/ItemWriters. Schedule via Quartz or Spring Scheduler.';
        } else if (hasSort) {
            result.recommendation = 'Spring Batch or Apache Beam pipeline — the SORT step is a natural fit for a GroupBy/Sort operator.';
        } else {
            result.recommendation = 'Shell script, Airflow DAG, or Kubernetes CronJob. Each EXEC step becomes a task; DD datasets map to input/output paths.';
        }
    }

    res.json(result);
});

// ──────────────────────────────────────────────────────────────────────
// Download — zip of the generated Java + a MANIFEST + (if present)
// report.json and JCL analysis summary. Streams to the browser.
// ──────────────────────────────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    if (!conversion.result || !conversion.result.report) {
        return res.status(400).json({ error: 'Conversion not complete — nothing to download yet.' });
    }

    const report = conversion.result.report;
    const files = report.files || [];
    const outputDir = conversion.result.outputDir || null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `cobol-to-java-${req.params.id}-${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', err => { if (err.code !== 'ENOENT') console.warn('zip warning', err); });
    archive.on('error', err => { console.error('zip error', err); try { res.end(); } catch {} });
    archive.pipe(res);

    // 1. All generated Java files (from the report's java_path entries).
    //    Preserve their relative path inside the zip under `java/`.
    let javaCount = 0;
    for (const f of files) {
        if (!f.java_path || !fs.existsSync(f.java_path)) continue;
        archive.file(f.java_path, { name: `java/${path.basename(f.java_path)}` });
        javaCount++;
    }

    // 2. A human-readable MANIFEST.md — short summary of converted files
    const manifest = [];
    manifest.push(`# Conversion manifest`);
    manifest.push('');
    manifest.push(`Conversion ID: ${req.params.id}`);
    manifest.push(`Generated: ${new Date().toISOString()}`);
    manifest.push(`Total files in report: ${files.length}`);
    manifest.push(`Generated Java files: ${javaCount}`);
    manifest.push('');
    manifest.push(`## Converted files`);
    manifest.push('');
    manifest.push(`| COBOL path | Status | Accuracy | Java class |`);
    manifest.push(`|------------|--------|----------|------------|`);
    const converted = files.filter(f => f.java_status === 'SUCCESS');
    for (const f of converted) {
        const acc = f.conversionAccuracy != null ? `${f.conversionAccuracy}%` : '—';
        const javaClass = f.java_path ? path.basename(f.java_path, '.java') : '—';
        manifest.push(`| \`${f.path}\` | ${f.java_status || '—'} | ${acc} | ${javaClass} |`);
    }
    manifest.push('');
    const flagged = files.filter(f =>
        f.accuracyBreakdown
        && Array.isArray(f.accuracyBreakdown.semanticPenalties)
        && f.accuracyBreakdown.semanticPenalties.length > 0
    );
    if (flagged.length > 0) {
        manifest.push(`## Converted files needing manual review`);
        manifest.push('');
        for (const f of flagged) {
            manifest.push(`### \`${f.path}\` — ${f.conversionAccuracy}% confidence`);
            for (const p of f.accuracyBreakdown.semanticPenalties) {
                manifest.push(`- **${p}**`);
            }
            manifest.push('');
        }
    }
    archive.append(manifest.join('\n'), { name: 'MANIFEST.md' });

    // 3. MANUAL_REVIEW.md — everything that was NOT converted to Java.
    // Covers JCL, copybooks, data files, and ANY other artifact in the repo.
    // Gives per-file recommendations so users know what to port, keep, drop,
    // or review separately before the modernization is complete.
    archive.append(buildManualReviewMd(files, req.params.id), { name: 'MANUAL_REVIEW.md' });

    // 3. The raw report.json for tooling
    archive.append(JSON.stringify(report, null, 2), { name: 'report.json' });

    // 5. README for unzip users — points at MANIFEST + MANUAL_REVIEW
    const readme = [
        `# COBOL → Java conversion output`,
        ``,
        `This archive contains the Java code generated from a COBOL-to-Java`,
        `conversion run, plus guidance on the remaining (non-COBOL) artifacts.`,
        ``,
        `Contents:`,
        ``,
        `- \`java/\` — generated Java sources (one file per converted program)`,
        `- \`MANIFEST.md\` — converted files: status, accuracy scores, penalties`,
        `- \`MANUAL_REVIEW.md\` — **non-converted** files: JCL, data, HTML, SQL,`,
        `  other languages, etc. Each gets an action label (PORT / KEEP / REVIEW)`,
        `  with a per-category recommendation for what to do next.`,
        `- \`report.json\` — full structured report for tooling`,
        ``,
        `## Next steps`,
        ``,
        `1. Read \`MANIFEST.md\` for converted-file status.`,
        `2. Read \`MANUAL_REVIEW.md\` — this is where the remaining modernization`,
        `   work is listed (orchestration, UI, scripts, SQL, etc.). Modernization`,
        `   is not complete until every item in there has a decision.`,
        `3. To compile: drop \`java/*.java\` into your build (e.g. Maven/Gradle`,
        `   \`src/main/java\`) and \`javac\` — all generated classes share the`,
        `   default package.`,
        ``
    ].join('\n');
    archive.append(readme, { name: 'README.md' });

    archive.finalize();
});

// API: AI-powered Java repair. Gathers the full context (original COBOL,
// current Java, compile errors, run outputs, dependency graph) and asks an
// AI agent to produce a fixed Java file. Writes the result back to the
// java_path so the next run picks up the repaired version.
//
// Body: { conversionId, relativePath }  (relativePath identifies which COBOL file)
// Returns: { success, newJavaCode?, error?, applied }
app.post('/api/fix-java', async (req, res) => {
    const { conversionId, relativePath } = req.body || {};
    if (!conversionId || !relativePath) {
        return res.status(400).json({ success: false, error: 'conversionId and relativePath required' });
    }
    const conversion = activeConversions.get(conversionId);
    if (!conversion || !conversion.result || !conversion.result.report) {
        return res.status(404).json({ success: false, error: 'Conversion not found or not complete' });
    }
    const norm = String(relativePath).replace(/\\/g, '/');
    const entry = (conversion.result.report.files || []).find(f => (f.path || '').replace(/\\/g, '/') === norm);
    if (!entry) return res.status(404).json({ success: false, error: 'File not in report' });
    if (!entry.java_path || !fs.existsSync(entry.java_path)) {
        return res.status(400).json({ success: false, error: 'No Java file exists for this entry' });
    }

    // Streaming mode: when the client asks for text/event-stream, push step
    // events as the repair progresses so the UI can show live feedback
    // instead of a silent 10–30s spinner. Falls back to a single JSON payload
    // for old clients / curl.
    const wantsStream = /text\/event-stream/i.test(req.headers.accept || '');
    let emit; // (type, payload) => void
    if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders && res.flushHeaders();
        emit = (type, payload) => {
            try {
                res.write(`event: ${type}\n`);
                res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
            } catch {}
        };
    } else {
        emit = () => {}; // no-op for non-streaming clients
    }

    try {
        const t0 = Date.now();
        emit('step', { step: 'read_source', label: 'Reading COBOL + current Java from disk' });
        const cobolSource = fs.readFileSync(entry.source_path, 'utf-8');
        const javaCode = fs.readFileSync(entry.java_path, 'utf-8');
        emit('step', { step: 'source_read', label: 'Source read', ms: Date.now() - t0, cobolBytes: cobolSource.length, javaBytes: javaCode.length });

        // Probe: attempt to compile current Java to capture real errors.
        emit('step', { step: 'probe_compile', label: 'Compiling current Java to capture errors' });
        const tProbe = Date.now();
        const { execSync } = require('child_process');
        let compileErrors = '';
        try {
            execSync(`javac "${entry.java_path}"`, {
                cwd: entry.work_dir || path.dirname(entry.java_path),
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            compileErrors = (e.stderr ? e.stderr.toString() : e.message) || '';
        }
        emit('step', {
            step: 'probe_done',
            label: compileErrors ? 'Compile errors captured' : 'Current Java compiles — repair will focus on semantic/accuracy',
            ms: Date.now() - tProbe,
            errorBytes: compileErrors.length,
            errorPreview: compileErrors.split('\n').slice(0, 3).join(' | ').slice(0, 300)
        });

        // Latest run outputs are cached on the conversion object if available.
        const runCache = (conversion._lastRun && conversion._lastRun[entry.path]) || {};

        // Build dependency map (PROGRAM-ID → Java class name) for siblings.
        const programIdToJavaClass = {};
        const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
        for (const f of (conversion.result.report.files || [])) {
            if (!f.java_path || f === entry || !f.source_path) continue;
            const base = path.basename(f.source_path, path.extname(f.source_path)).toUpperCase();
            const javaClass = path.basename(f.java_path, '.java');
            programIdToJavaClass[base] = javaClass;
            try {
                const src = fs.readFileSync(f.source_path, 'utf-8');
                const m = src.match(programIdRe);
                if (m) programIdToJavaClass[m[1].toUpperCase()] = javaClass;
            } catch {}
        }

        emit('step', {
            step: 'context_built',
            label: 'Context ready — calling AI repair agent',
            dependencies: Object.keys(programIdToJavaClass).length,
            hasRunOutput: !!(runCache.cobolOutput || runCache.javaOutput)
        });
        const tAI = Date.now();
        const fix = await azureAgent.fixJavaCode({
            javaCode,
            cobolSource,
            compileErrors,
            runOutput: runCache.javaOutput || '',
            cobolOutput: runCache.cobolOutput || '',
            dependencies: programIdToJavaClass
        });
        emit('step', {
            step: 'ai_done',
            label: fix.success ? 'AI returned repaired Java' : 'AI repair failed',
            ms: Date.now() - tAI,
            tokens: fix.usage ? (fix.usage.total_tokens || fix.usage.totalTokens || null) : null,
            javaBytes: fix.javaCode ? fix.javaCode.length : 0,
            error: fix.success ? null : fix.error
        });

        if (!fix.success) {
            const payload = { success: false, error: fix.error || 'Fix failed' };
            if (wantsStream) {
                emit('final', payload);
                return res.end();
            }
            return res.status(500).json(payload);
        }

        // Back up the original before overwriting, so the user can undo.
        emit('step', { step: 'apply', label: 'Writing repaired Java to disk + creating backup' });
        const backupPath = entry.java_path.replace(/\.java$/i, '.java.before-fix');
        if (!fs.existsSync(backupPath)) {
            try { fs.copyFileSync(entry.java_path, backupPath); } catch {}
        }
        fs.writeFileSync(entry.java_path, fix.javaCode, 'utf-8');

        // Update accuracy breakdown to record that a repair was applied.
        if (entry.accuracyBreakdown) {
            entry.accuracyBreakdown.semanticPenalties = [
                ...(entry.accuracyBreakdown.semanticPenalties || []),
                'Auto-repaired by Fix Java agent'
            ];
        }

        // Re-run accuracy scorer on the new code so the score reflects the fix.
        try {
            const acc = azureAgent.analyzeConversionAccuracy(cobolSource, fix.javaCode);
            if (acc && typeof acc.accuracy === 'number') {
                entry.conversionAccuracy = acc.accuracy;
                entry.accuracyDetails = acc.details || [];
                entry.accuracyBreakdown = {
                    cobolMetrics: acc.cobolMetrics,
                    javaMetrics: acc.javaMetrics,
                    semanticPenalties: acc.semanticPenalties || []
                };
            }
        } catch {}

        // Recompile the fixed Java so we can tell the user whether the repair
        // actually compiles — previously this endpoint returned success as soon
        // as the AI produced something, leaving the user to discover compile
        // errors on the next Run panel click.
        emit('step', { step: 'recompile', label: 'Recompiling the repaired Java' });
        const tRe = Date.now();
        let compileStatus = 'unknown';
        let compileError = null;
        try {
            const workDir = path.dirname(entry.java_path);
            const { execSync } = require('child_process');
            try {
                execSync(`javac "${entry.java_path}"`, {
                    cwd: workDir,
                    timeout: 30000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                compileStatus = 'ok';
                // Flip the entry's status back to SUCCESS if it was COMPILE_FAIL —
                // repair actually fixed the compile problem.
                if (entry.java_status === 'COMPILE_FAIL') {
                    entry.java_status = 'SUCCESS';
                    entry.error = undefined;
                }
            } catch (compileErr) {
                compileStatus = 'fail';
                compileError = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                entry.java_status = 'COMPILE_FAIL';
                entry.error = compileError;
            }
        } catch (recompileOuterErr) {
            // If the recompile wrapper itself blew up (missing javac, etc.),
            // don't fail the fix — surface it to the client instead.
            compileStatus = 'unknown';
            compileError = recompileOuterErr.message;
        }
        emit('step', {
            step: 'recompile_done',
            label: 'Recompile complete: ' + compileStatus,
            ms: Date.now() - tRe,
            compileStatus,
            errorPreview: compileError ? String(compileError).split('\n').slice(0, 3).join(' | ').slice(0, 300) : null
        });

        const payload = {
            success: true,
            applied: true,
            newJavaCode: fix.javaCode,
            backupPath: path.basename(backupPath),
            newAccuracy: entry.conversionAccuracy,
            compileStatus,           // 'ok' | 'fail' | 'unknown'
            compileError,            // populated when compileStatus === 'fail'
            newJavaStatus: entry.java_status,
            usage: fix.usage || null
        };
        if (wantsStream) {
            emit('final', payload);
            return res.end();
        }
        res.json(payload);
    } catch (err) {
        const payload = { success: false, error: err.message };
        if (wantsStream) {
            emit('final', payload);
            return res.end();
        }
        res.status(500).json(payload);
    }
});

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
app.post('/api/compare-runs', async (req, res) => {
    try {
        const b = req.body || {};
        // Server-side source lookup: if the caller identifies a known conversion
        // + file, read source off disk so the comparator always has it — avoids
        // clients having to POST tens of KB they already fetched earlier.
        let cobolSource = typeof b.cobolSource === 'string' ? b.cobolSource : '';
        let javaCode    = typeof b.javaCode    === 'string' ? b.javaCode    : '';
        if ((!cobolSource || !javaCode) && b.conversionId && b.relativePath) {
            const conv = activeConversions.get(b.conversionId);
            const entry = conv && conv.result && conv.result.report &&
                (conv.result.report.files || []).find(f => f.path === b.relativePath);
            if (entry) {
                if (!cobolSource && entry.source_path) {
                    try { cobolSource = fs.readFileSync(entry.source_path, 'utf-8'); } catch {}
                }
                if (!javaCode && entry.java_path) {
                    try { javaCode = fs.readFileSync(entry.java_path, 'utf-8'); } catch {}
                }
            }
        }
        const verdict = await azureAgent.compareRunOutputs({
            cobolOutput: String(b.cobolOutput || ''),
            javaOutput:  String(b.javaOutput  || ''),
            cobolError:  String(b.cobolError  || ''),
            javaError:   String(b.javaError   || ''),
            cobolExit:   b.cobolExit,
            javaExit:    b.javaExit,
            cobolTimedOut: !!b.cobolTimedOut,
            javaTimedOut:  !!b.javaTimedOut,
            fileName:    b.fileName || '',
            cobolSource: cobolSource || undefined,
            javaCode:    javaCode    || undefined
        });
        res.json(verdict);
    } catch (err) {
        res.status(500).json({
            verdict: 'unknown', severity: 'info',
            title: 'Comparison failed',
            reasons: [err.message || String(err)]
        });
    }
});

// API: Results browser — list of cobol files + their generated java mapping.
app.get('/api/browser/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
    if (!conversion.result || !conversion.result.report) {
        return res.json({ ready: false, status: conversion.status });
    }
    const reportFiles = conversion.result.report.files || [];
    const files = reportFiles.map(f => ({
        cobolPath: f.path,
        cobolSourcePath: f.source_path,
        javaPath: f.java_path || null,
        workDir: f.work_dir || null,
        status: f.java_status,
        accuracy: f.conversionAccuracy != null ? f.conversionAccuracy : null,
        // Semantic penalty list — what caused the accuracy drop (e.g. "File I/O
        // simulated", "CICS simplified"). Used to render a tooltip on the badge.
        penalties: (f.accuracyBreakdown && f.accuracyBreakdown.semanticPenalties) || [],
        error: f.error || null
    }));
    res.json({
        ready: true,
        status: conversion.status,
        files,
        outputDir: conversion.result.outputDir,
        postReview: conversion.postReview || {}
    });
});

// API: Get converted files list
app.get('/api/files/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);

    if (!conversion || !conversion.result) {
        return res.status(404).json({ error: 'Conversion not found or not complete' });
    }

    // List Java files in output directory
    const javaDir = path.join(conversion.result.outputDir, 'java');
    let javaFiles = [];

    try {
        if (fs.existsSync(javaDir)) {
            javaFiles = fs.readdirSync(javaDir)
                .filter(f => f.endsWith('.java'))
                .map(f => ({
                    name: f,
                    path: path.join(javaDir, f)
                }));
        }
    } catch (err) {
        console.error('Error reading java directory:', err);
    }

    res.json({ files: javaFiles, ...conversion.result });
});

// API: Get file content
app.get('/api/file-content', (req, res) => {
    const filePath = req.query.path;

    if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(404).json({ error: 'File not found' });
    }
});

// API: Get comparison data (COBOL vs Java outputs)
app.get('/api/comparison', (req, res) => {
    const workDir = req.query.workDir;

    if (!workDir || workDir === 'N/A') {
        return res.status(400).json({ error: 'Work directory not available' });
    }

    const result = {
        nativeOutput: null,
        javaOutput: null,
        diff: null,
        nativeExists: false,
        javaExists: false
    };

    // Read native output
    const nativePath = path.join(workDir, 'native_output.txt');
    try {
        if (fs.existsSync(nativePath)) {
            result.nativeOutput = fs.readFileSync(nativePath, 'utf-8');
            result.nativeExists = true;
        }
    } catch (err) {
        console.error('Error reading native output:', err);
    }

    // Read java output
    const javaPath = path.join(workDir, 'java_output.txt');
    try {
        if (fs.existsSync(javaPath)) {
            result.javaOutput = fs.readFileSync(javaPath, 'utf-8');
            result.javaExists = true;
        }
    } catch (err) {
        console.error('Error reading java output:', err);
    }

    // Read diff if exists
    const diffPath = path.join(workDir, 'diff.txt');
    try {
        if (fs.existsSync(diffPath)) {
            result.diff = fs.readFileSync(diffPath, 'utf-8');
        }
    } catch (err) {
        console.error('Error reading diff:', err);
    }

    res.json(result);
});

// API: Get code comparison (COBOL source vs Java code)
app.get('/api/code-comparison', (req, res) => {
    const { workDir, conversionId, relativePath } = req.query;

    const result = {
        javaCode: null,
        javaExists: false,
        javaStatus: null,   // e.g. SUCCESS, CONVERT_FAIL, SKIPPED_COPYBOOK, ...
        reason: null,       // human-readable reason tailored to status
        error: null,        // raw error message if any (AI error, compile error, etc.)
        suggestion: null    // actionable next step for the user
    };

    // If we have a relative path, look up per-file diagnostics from the report
    // so the modal can explain exactly why a file didn't produce Java.
    // If the caller didn't pass conversionId (e.g. page was reloaded and the
    // frontend lost its global), search across all active conversions for the
    // most-recent match.
    if (relativePath) {
        const norm = String(relativePath).replace(/\\/g, '/');
        const candidateConvs = [];
        if (conversionId && activeConversions.has(conversionId)) {
            candidateConvs.push(activeConversions.get(conversionId));
        } else {
            // Search newest → oldest so we find the latest conversion of this file.
            const entries = [...activeConversions.entries()]
                .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
            for (const [, c] of entries) candidateConvs.push(c);
        }
        let entry = null;
        for (const conversion of candidateConvs) {
            const report = conversion && conversion.result && conversion.result.report;
            if (!report || !Array.isArray(report.files)) continue;
            entry = report.files.find(f => (f.path || '').replace(/\\/g, '/') === norm);
            if (entry) break;
        }
        {
            if (entry) {
                result.javaStatus = entry.java_status || null;
                result.error = entry.error || null;
                result.accuracy = entry.conversionAccuracy != null ? entry.conversionAccuracy : null;
                result.accuracyBreakdown = entry.accuracyBreakdown || null;
                // Prefer the entry's own work_dir / java_path if we didn't get one from the client
                if (!result._resolvedWorkDir && entry.work_dir) result._resolvedWorkDir = entry.work_dir;
                if (entry.java_path && fs.existsSync(entry.java_path)) {
                    try {
                        result.javaCode = fs.readFileSync(entry.java_path, 'utf-8');
                        result.javaExists = true;
                    } catch {}
                }
                // Build a human-readable reason + suggestion per status
                const reasonMap = {
                    SUCCESS: { reason: 'Converted successfully.', suggestion: null },
                    SKIPPED_COPYBOOK: {
                        reason: 'This file is a COBOL copybook (shared data definition), not a standalone program.',
                        suggestion: 'Copybooks are embedded into Java model classes when referenced by a converted program. No standalone Java file is produced.'
                    },
                    SKIPPED_NO_ID: {
                        reason: 'No IDENTIFICATION DIVISION / PROGRAM-ID was found in this source.',
                        suggestion: 'Confirm the file is a COBOL program (not JCL, copybook, or data). Fixed-format COBOL must have PROGRAM-ID within columns 8–72.'
                    },
                    SKIPPED_JCL: { reason: 'This is a JCL job, not COBOL source.', suggestion: 'JCL is not translated — schedule/trigger equivalents must be built separately in your Java runtime.' },
                    SKIPPED_DATA: { reason: 'This is a data file, not COBOL source.', suggestion: null },
                    SKIPPED_OTHER: { reason: 'Skipped — file type is not supported for conversion.', suggestion: null },
                    REJECTED_BY_REVIEW: { reason: 'Rejected during human review.', suggestion: 'Open the reviewer notes (history tab) to see why, then re-run or edit.' },
                    CONVERT_FAIL: {
                        reason: 'AI conversion step failed.',
                        suggestion: 'Common causes: external CICS/DB2/VSAM calls the AI could not model, unusual COBOL dialect features, or transient model errors. See the error below and try re-running this single file.'
                    },
                    FAIL: {
                        reason: 'Conversion pipeline error (outside the AI step).',
                        suggestion: 'Usually a filesystem/compile issue — see the error below.'
                    }
                };
                const mapped = reasonMap[result.javaStatus];
                if (mapped) { result.reason = mapped.reason; result.suggestion = mapped.suggestion; }
            }
        }
    }

    // Fallback: legacy callers pass only workDir. Try to find any .java file in it.
    const wd = workDir || result._resolvedWorkDir;
    if (!result.javaCode && wd && wd !== 'N/A') {
        try {
            if (fs.existsSync(wd)) {
                const files = fs.readdirSync(wd);
                const javaFile = files.find(f => f.endsWith('.java'));
                if (javaFile) {
                    result.javaCode = fs.readFileSync(path.join(wd, javaFile), 'utf-8');
                    result.javaExists = true;
                }
            }
        } catch (err) {
            console.error('Error reading java code:', err);
        }
    }

    delete result._resolvedWorkDir;
    res.json(result);
});

// Strip ANSI codes
function stripAnsi(string) {
    // Strip all ANSI escape sequences: colors, cursor movement, screen clear, etc.
    return string.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
                 .replace(/\u001b\][^\u0007]*\u0007/g, '')   // OSC sequences
                 .replace(/\u001b[()][A-Z0-9]/g, '')          // charset selection
                 .replace(/\r/g, '');                          // carriage returns
}

// Run javac on every SUCCESS entry in a conversion's result. If javac fails,
// flip the entry to COMPILE_FAIL with the real error so the UI surfaces it
// instead of showing a green checkmark on a broken file. Used by the local
// (cobj) conversion path, where Java is generated by a native compiler but not
// independently verified. Azure path has its own in-line gate in processFile.
function runCompileGateOnReport(result) {
    if (!result || !result.report || !Array.isArray(result.report.files)) return;
    const { execSync } = require('child_process');
    for (const entry of result.report.files) {
        if (entry.java_status !== 'SUCCESS' || !entry.java_path) continue;
        if (!fs.existsSync(entry.java_path)) continue;
        try {
            execSync(`javac "${entry.java_path}"`, {
                cwd: path.dirname(entry.java_path),
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (compileErr) {
            const err = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
            entry.java_status = 'COMPILE_FAIL';
            entry.error = err;
            // Surface in the summary totals too so KPIs are accurate.
            if (result.report.summary) {
                result.report.summary.fail_compile = (result.report.summary.fail_compile || 0) + 1;
                if (result.report.summary.success_java_only > 0) {
                    result.report.summary.success_java_only--;
                }
            }
        }
    }
}

// Parse scanner output
function parseOutput(output, outputDir) {
    // Try to read report.json
    const reportPath = path.join(outputDir, 'report.json');
    let report = null;

    try {
        if (fs.existsSync(reportPath)) {
            const reportData = fs.readFileSync(reportPath, 'utf-8');
            report = JSON.parse(reportData);
        }
    } catch (e) {
        console.error('Error reading report.json:', e);
    }

    // Default result structure
    const result = {
        outputDir,
        totalFiles: 0,
        converted: 0,
        skippedCopybook: 0,
        skippedNoId: 0,
        skippedError: 0,
        convertedFiles: [],
        skippedFiles: [],
        errorFiles: [],
        report: report // Include full report for advanced UI
    };

    if (report && report.summary) {
        // Use data from JSON report
        result.totalFiles = report.summary.total;
        result.converted = (report.summary.matches || 0) + (report.summary.mismatches || 0) + (report.summary.success_java_only || 0); // Executed files
        // Sum all failure types for total errors
        result.skippedError = (report.summary.fail_conversion || 0) + (report.summary.fail_compile || 0) + (report.summary.fail_execution || 0);

        // Count skips manualy from file list
        let copybooks = 0;
        let noIds = 0;

        report.files.forEach(file => {
            // Status mapping
            if (file.java_status === 'SUCCESS' || file.java_status === 'COMPARE_FAIL' || file.compare === 'MATCH' || file.compare === 'MISMATCH') {
                // It was converted and ran (or at least converted)
                let statusIcon = '✅';
                if (file.compare === 'MISMATCH') statusIcon = '⚠️';
                if (file.compare === 'FAIL') statusIcon = '❌';

                result.convertedFiles.push(`${file.path} [${file.compare}]`);
            } else if (file.java_status === 'SKIPPED_COPYBOOK') {
                copybooks++;
                result.skippedFiles.push(`${file.path} - Copybook`);
            } else if (file.java_status === 'SKIPPED_NO_ID') {
                noIds++;
                result.skippedFiles.push(`${file.path} - No ID DIVISION`);
            } else {
                // Failures
                result.errorFiles.push(`${file.path} - ${file.java_status}`);
            }
        });

        result.skippedCopybook = copybooks;
        result.skippedNoId = noIds;

    } else {
        // Fallback to log parsing (legacy)
        const cleanOutput = stripAnsi(output);
        const lines = cleanOutput.split('\n');

        for (const line of lines) {
            // Parse summary numbers
            if (line.includes('Total files scanned:')) {
                const match = line.match(/Total files scanned:\s*(\d+)/);
                if (match) result.totalFiles = parseInt(match[1]);
            }
            if (line.includes('Successfully converted:')) {
                const match = line.match(/Successfully converted:\s*(\d+)/);
                if (match) result.converted = parseInt(match[1]);
            }
            if (line.includes('Skipped (copybooks):')) {
                const match = line.match(/Skipped \(copybooks\):\s*(\d+)/);
                if (match) result.skippedCopybook = parseInt(match[1]);
            }
            if (line.includes('Skipped (no ID DIV):')) {
                const match = line.match(/Skipped \(no ID DIV\):\s*(\d+)/);
                if (match) result.skippedNoId = parseInt(match[1]);
            }
            if (line.includes('Skipped (errors):')) {
                const match = line.match(/Skipped \(errors\):\s*(\d+)/);
                if (match) result.skippedError = parseInt(match[1]);
            }

            // Parse individual file results
            if (line.includes('[OK]') && line.includes('Converted:')) {
                const match = line.match(/Converted:\s*(.+)$/);
                if (match) result.convertedFiles.push(match[1].trim());
            }
            if (line.includes('[SKIP]')) {
                const match = line.match(/\[SKIP\]\s*(.+)$/);
                if (match) result.skippedFiles.push(match[1].trim());
            }
            if (line.includes('[ERROR]') && !line.includes('Failed to clone repository')) {
                const match = line.match(/\[ERROR\]\s*(.+)\s-\sConversion failed/);
                if (match) {
                    result.errorFiles.push(`${match[1].trim()} - Conversion Error`);
                }
            }
        }
    }

    return result;
}


// ============================================
// AI Agent API Endpoints
// NOTE: /api/ai/status was removed (not called from frontend — use the
// richer /api/ai/provider endpoint below, which reports Azure + OpenAI).
// /api/ai/fix was removed (no frontend caller, and autoFixCobolCode was
// only invoked from that endpoint — both go away together).
// ============================================

// API: Analyze a failed conversion. Accepts optional conversionId + relativePath
// so we can look up the file's real CALL / COPY context from the conversion
// state, and pass that to the analyst — otherwise analysis degrades to generic
// "make sure X exists" advice that doesn't reference the actual repo.
app.post('/api/ai/analyze', async (req, res) => {
    const { sourcePath, workDir, errorType, conversionId, relativePath } = req.body;

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    // Accept the request if EITHER analyzer is available. The actual call
    // routes to Azure first (preferred) and falls back to direct OpenAI.
    if (!aiAgent.isAvailable() && !azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'No AI analyzer available. Configure AZURE_OPENAI_* (preferred) or OPENAI_API_KEY in .env.',
            quickSuggestions: aiAgent.getQuickSuggestions(errorType, '')
        });
    }

    try {
        // Read COBOL source
        let cobolSource = '';
        try {
            cobolSource = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            return res.status(404).json({ error: 'COBOL source file not found' });
        }

        // Read error log if available
        let errorLog = '';
        if (workDir) {
            const cobjLog = path.join(workDir, 'cobj.log');
            const javacLog = path.join(workDir, 'javac.log');
            const javaStderr = path.join(workDir, 'java_stderr.log');

            if (fs.existsSync(cobjLog)) {
                errorLog += '=== COBJ Conversion Log ===\n' + fs.readFileSync(cobjLog, 'utf-8') + '\n';
            }
            if (fs.existsSync(javacLog)) {
                errorLog += '=== Java Compilation Log ===\n' + fs.readFileSync(javacLog, 'utf-8') + '\n';
            }
            if (fs.existsSync(javaStderr)) {
                errorLog += '=== Java Runtime Errors ===\n' + fs.readFileSync(javaStderr, 'utf-8') + '\n';
            }
        }

        // Get quick suggestions first
        const quickSuggestions = aiAgent.getQuickSuggestions(errorType, errorLog);

        // Build repo-context if we can — the analyst can then cite specific
        // copybooks / CALL targets by name instead of giving generic advice.
        const context = buildAnalysisContext(conversionId, relativePath, cobolSource);

        // Prefer the Azure path when available (has truncation detection, retry,
        // and parity with the conversion-time prompts). Fall back to aiAgent
        // (direct OpenAI) only if Azure isn't configured, so the two
        // implementations don't silently drift.
        const useAzure = azureAgent.isAvailable();
        const result = useAzure
            ? await azureAgent.analyzeConversionFailure(cobolSource, errorLog, errorType, context)
            : await aiAgent.analyzeConversionFailure(cobolSource, errorLog, errorType, context);

        res.json({
            ...result,
            quickSuggestions,
            analyzer: useAzure ? 'azure' : 'openai'
        });

    } catch (error) {
        console.error('AI analyze error:', error);
        res.status(500).json({ error: 'AI analysis failed: ' + error.message });
    }
});

// Assemble the optional { calledPrograms, copybooks, programIdToJavaClass,
// copybookBodies } context block for analyzeConversionFailure. Pulled from the
// conversion's graph state if available — falls back to parsing the source in
// isolation so analysis still works for ad-hoc single-file calls.
function buildAnalysisContext(conversionId, relativePath, cobolSource) {
    const callRe = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
    const copyRe = /COPY\s+['"]?([A-Z0-9_-]+)['"]?/gi;
    const calledPrograms = [];
    const copybooks = [];
    const seenCalls = new Set();
    const seenCopy = new Set();
    let m;
    while ((m = callRe.exec(cobolSource)) !== null) {
        const n = m[1].toUpperCase();
        if (!seenCalls.has(n)) { seenCalls.add(n); calledPrograms.push(n); }
    }
    while ((m = copyRe.exec(cobolSource)) !== null) {
        const n = m[1].toUpperCase();
        if (!seenCopy.has(n)) { seenCopy.add(n); copybooks.push(n); }
    }

    const context = { calledPrograms, copybooks, programIdToJavaClass: {}, copybookBodies: {} };

    // If we can locate the conversion, enrich with real mappings.
    const conv = conversionId ? activeConversions.get(conversionId) : null;
    if (conv) {
        const gNodes = (conv.graph && conv.graph.nodes) || [];
        for (const n of gNodes) {
            if (n.type === 'program') {
                const base = path.basename(n.path || n.id, path.extname(n.path || n.id));
                context.programIdToJavaClass[base.toUpperCase()] = toPascalCase(base);
            }
            if (n.type === 'copybook' && n.path) {
                const stem = path.basename(n.path, path.extname(n.path)).toUpperCase();
                if (seenCopy.has(stem)) {
                    try { context.copybookBodies[stem] = fs.readFileSync(n.path, 'utf-8'); }
                    catch {}
                }
            }
        }
    }
    return context;
}

// NOTE: the /api/azure/* endpoints (status, convert, scan, convert-directory,
// analyze) that previously lived here were removed — none were called from the
// frontend or docs, they duplicated the main /api/convert-azure + /api/scan-repo
// + /api/ai/analyze flows with inferior context (the convert one passed NO
// dependency/copybook context). Kept the diff small: call graph was dead code.
// /api/azure/status was merged into /api/ai/provider (which the frontend uses).

// API: Get current AI provider info
app.get('/api/ai/provider', (req, res) => {
    res.json({
        provider: AI_PROVIDER,
        openai: {
            available: aiAgent.isAvailable()
        },
        azure: {
            available: azureAgent.isAvailable(),
            config: azureAgent.getConfig()
        }
    });
});

// API: Extract file dependencies (COPY and CALL statements)
app.get('/api/dependencies', (req, res) => {
    const filePath = req.query.path;

    if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const dependencies = {
            copybooks: [],
            programCalls: [],
            hasRelationships: false
        };

        // Extract COPY statements (e.g., COPY 'FILENAME', COPY FILENAME, COPY FILENAME.)
        const copyRegex = /COPY\s+['"]?([A-Z0-9_-]+)['"]?\s*\.?/gi;
        let match;
        while ((match = copyRegex.exec(content)) !== null) {
            const copybookName = match[1].toUpperCase();
            if (!dependencies.copybooks.includes(copybookName)) {
                dependencies.copybooks.push(copybookName);
            }
        }

        // Extract CALL statements (e.g., CALL 'PROGRAMNAME', CALL "PROGRAMNAME")
        const callRegex = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
        while ((match = callRegex.exec(content)) !== null) {
            const programName = match[1].toUpperCase();
            if (!dependencies.programCalls.includes(programName)) {
                dependencies.programCalls.push(programName);
            }
        }

        dependencies.hasRelationships = dependencies.copybooks.length > 0 || dependencies.programCalls.length > 0;

        res.json(dependencies);
    } catch (err) {
        res.status(404).json({ error: 'File not found or could not be read' });
    }
});


// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 COBOL Converter UI starting...');
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
    console.log(`🌐 Server running at http://localhost:${PORT}`);
    console.log(`📁 AI Provider: ${AI_PROVIDER.toUpperCase()}`);
    console.log('='.repeat(50) + '\n');
});
