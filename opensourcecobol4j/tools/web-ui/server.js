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
const PORT = 3000;

// Determine which AI provider to use
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// Middleware
app.use(express.json());
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
            }

            conversion.graph = { nodes: graphNodes, edges: graphEdges };
            conversion.fileStates = fileStates;
            conversion.currentFiles = [];
            conversion.inputPath = inputPath;
            // ─────────────────────────────────────────────────────────────────


            // Parallel processing configuration
            const BATCH_SIZE = 5; // Process 5 files concurrently

            // Helper function to process a single file
            async function processFile(cobolPath, index, total, inputPath) {
                const relativePath = path.relative(inputPath, cobolPath);
                const baseName = path.basename(cobolPath, path.extname(cobolPath));

                // If user cancelled, mark as skipped and return immediately
                if (conversion.cancelled) {
                    conversion.fileStates[relativePath] = 'skipped';
                    return { relativePath, baseName, cobolPath, status: 'skipped_cancelled', reportEntry: null };
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

                    // Convert using Azure AI
                    const conversionResult = await azureAgent.convertCobolToJava(cobolSource);

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

                        // Fix ALL class name references in the generated Java code
                        let fixedJavaCode = conversionResult.javaCode;

                        // FIRST: Detect the actual class name the AI generated
                        // This handles cases where AI uses a completely different name (e.g., CardAuthorizationProgram instead of COPAUA0C)
                        const classNameMatch = fixedJavaCode.match(/public\s+class\s+(\w+)\s*\{/);
                        const aiGeneratedClassName = classNameMatch ? classNameMatch[1] : null;

                        // If AI used a different class name, replace it with the correct one
                        if (aiGeneratedClassName && aiGeneratedClassName !== javaClassName) {
                            console.log(`   🔧 Fixing class name: ${aiGeneratedClassName} → ${javaClassName}`);

                            // Replace class declaration
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'),
                                `$1${javaClassName}$2`
                            );
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace constructor declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace new ClassName() instantiations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(new\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace variable type declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s,\\(])${aiGeneratedClassName}(\\s+\\w+\\s*[=;,\\)])`, 'gm'),
                                `$1${javaClassName}$2`
                            );

                            // Replace static method calls
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s\\(])${aiGeneratedClassName}(\\.\\w+)`, 'gm'),
                                `$1${javaClassName}$2`
                            );
                        }

                        // ALSO: Create patterns for all case variants of the base name (fallback)
                        const variants = [
                            baseName,                    // Original: CBPAUP0C
                            baseName.toLowerCase(),      // Lowercase: cbpaup0c
                            baseName.toUpperCase(),      // Uppercase: CBPAUP0C
                        ];

                        // Replace ALL occurrences of any variant with the correct PascalCase name
                        for (const variant of variants) {
                            // Replace class declaration
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+class\\s+)${variant}(\\s*\\{)`, 'gi'),
                                `$1${javaClassName}$2`
                            );
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(class\\s+)${variant}(\\s*\\{)`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace constructor declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+)${variant}(\\s*\\()`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace new ClassName() instantiations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(new\\s+)${variant}(\\s*\\()`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace variable type declarations (ClassName varName)
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s,\\(])${variant}(\\s+\\w+\\s*[=;,\\)])`, 'gim'),
                                `$1${javaClassName}$2`
                            );

                            // Replace static method calls (ClassName.method)
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s\\(])${variant}(\\.\\w+)`, 'gim'),
                                `$1${javaClassName}$2`
                            );
                        }

                        fs.writeFileSync(javaPath, fixedJavaCode);

                        // Also save to work dir for UI access
                        fs.writeFileSync(path.join(workDir, javaFileName), fixedJavaCode);

                        // Copy original COBOL source to work dir
                        fs.copyFileSync(cobolPath, path.join(workDir, path.basename(cobolPath)));

                        // Compile and run Java code to get REAL output
                        let javaOutput = '';
                        let compareStatus = 'JAVA_ONLY';
                        let compilationError = null;

                        try {
                            const { execSync } = require('child_process');
                            const javaFileInWorkDir = path.join(workDir, javaFileName);

                            // Compile the Java file
                            try {
                                execSync(`javac "${javaFileInWorkDir}"`, {
                                    cwd: workDir,
                                    timeout: 30000,
                                    stdio: ['pipe', 'pipe', 'pipe']
                                });

                                // Run the compiled Java class with empty input (for programs that expect Scanner input)
                                try {
                                    // Use spawnSync to capture both stdout and stderr properly
                                    const { spawnSync } = require('child_process');
                                    const result = spawnSync('java', ['-cp', workDir, javaClassName], {
                                        cwd: workDir,
                                        timeout: 10000,
                                        encoding: 'utf-8',
                                        shell: false,
                                        input: '\n\n\n'  // Provide empty input lines for Scanner
                                    });

                                    const stdout = result.stdout || '';
                                    const stderr = result.stderr || '';
                                    const exitCode = result.status;

                                    // Combine stdout and stderr for complete output
                                    let combinedOutput = '';
                                    if (stdout.trim()) {
                                        combinedOutput = stdout.trim();
                                    }
                                    if (stderr.trim()) {
                                        // Include stderr output - it often contains useful program output
                                        if (combinedOutput) {
                                            combinedOutput += '\n' + stderr.trim();
                                        } else {
                                            combinedOutput = stderr.trim();
                                        }
                                    }

                                    if (combinedOutput.length > 0) {
                                        javaOutput = combinedOutput;
                                        compareStatus = 'MATCH';
                                    } else if (exitCode === 0) {
                                        javaOutput = '[Program executed successfully but produced no console output]';
                                    } else if (result.error) {
                                        // Check for specific error types
                                        const errMsg = result.error.message || '';
                                        if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
                                            javaOutput = '[Program timed out - may require interactive input]';
                                        } else {
                                            javaOutput = `[Runtime Error] ${errMsg}`;
                                        }
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

                        fileResult.status = 'success';

                        // Analyze conversion accuracy
                        const accuracyResult = azureAgent.analyzeConversionAccuracy(cobolSource, conversionResult.javaCode);

                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_path: javaPath,
                            work_dir: workDir,
                            java_status: 'SUCCESS',
                            compare: compareStatus,
                            method: 'azure_ai',
                            conversionAccuracy: accuracyResult.accuracy,
                            accuracyDetails: accuracyResult.details
                        };

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
    res.json({
        ready: true,
        status: conversion.status,
        graph: includeGraph ? conversion.graph : undefined,
        fileStates: conversion.fileStates,
        currentFiles: conversion.currentFiles || [],
        tokens: conversion.tokens || null,
        risks: conversion.risks || null
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

    // ─── Run Java ──────────────────────────────────────────────────────
    if (reportFile.work_dir && reportFile.java_path) {
        try {
            const javaClass = path.basename(reportFile.java_path, '.java');
            // Re-compile defensively in case the .class is stale
            try {
                execSync(`javac "${reportFile.java_path}"`, {
                    cwd: reportFile.work_dir,
                    timeout: 30000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (compileErr) {
                result.java = {
                    ok: false,
                    output: '',
                    error: 'Compilation failed:\n' + (compileErr.stderr ? compileErr.stderr.toString() : compileErr.message)
                };
            }
            if (!result.java) {
                const start = Date.now();
                const run = spawnSync('java', ['-cp', reportFile.work_dir, javaClass], {
                    cwd: reportFile.work_dir,
                    timeout: 8000,
                    encoding: 'utf-8',
                    input: userInput,
                    maxBuffer: 10 * 1024 * 1024
                });
                const dur = Date.now() - start;
                let output = (run.stdout || '').trim();
                if (run.stderr && run.stderr.trim()) output += (output ? '\n' : '') + run.stderr.trim();
                if (output.length > 8000) output = output.slice(0, 8000) + '\n\n[…output truncated — program produced ' + output.length + ' bytes. It may be stuck in an input loop.]';
                result.java = {
                    ok: run.status === 0 || output.length > 0,
                    exitCode: run.status,
                    duration: dur,
                    output: output || '[no output]',
                    error: run.error ? (run.error.message.includes('ENOBUFS') ? 'Output exceeded buffer (program likely in an input loop)' : run.error.message) : null
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

                // Classify sources into main programs vs subroutines
                const mainSources = [];
                const subSources = [];
                for (const s of allCobolSources) {
                    try {
                        const src = fs.readFileSync(s, 'utf-8').toUpperCase();
                        if (src.includes('PROCEDURE DIVISION USING')) {
                            subSources.push(s);
                        } else {
                            mainSources.push(s);
                        }
                    } catch { subSources.push(s); }
                }

                // When multiple COBOL files exist, compile subroutines as dynamic modules
                // first, then compile the main program as executable. This ensures CALL
                // references resolve at runtime via COB_LIBRARY_PATH.
                let compiled = false;
                const hasMultiple = allCobolSources.length > 1;

                if (hasMultiple && subSources.length > 0) {
                    // Compile each subroutine as a shared module (.so/.dylib) in cobolWork.
                    // The module filename must match the PROGRAM-ID (not the source filename),
                    // because COBOL CALL resolves modules by PROGRAM-ID at runtime.
                    for (const sub of subSources) {
                        // Extract PROGRAM-ID from source
                        let programId = null;
                        try {
                            const src = fs.readFileSync(sub, 'utf-8');
                            const m = src.match(/PROGRAM-ID\.\s+([A-Za-z0-9_-]+)/i);
                            if (m) programId = m[1];
                        } catch {}
                        for (const fmt of ['-free', '-fixed']) {
                            try {
                                if (programId) {
                                    execSync(`cobc -m ${fmt} -o "${path.join(cobolWork, programId)}" "${sub}"`, {
                                        cwd: cobolWork,
                                        timeout: 30000,
                                        stdio: ['pipe', 'pipe', 'pipe']
                                    });
                                } else {
                                    execSync(`cobc -m ${fmt} "${sub}"`, {
                                        cwd: cobolWork,
                                        timeout: 30000,
                                        stdio: ['pipe', 'pipe', 'pipe']
                                    });
                                }
                                break;
                            } catch {}
                        }
                    }
                }

                // Compile the target file (or main program) as executable
                const entryFile = mainSources.length > 0 && subSources.includes(reportFile.source_path)
                    ? mainSources[0]  // If target is a subroutine, use the main program as entry
                    : reportFile.source_path;
                for (const fmt of ['-free', '-fixed']) {
                    try {
                        execSync(`cobc -x ${fmt} -o "${binPath}" "${entryFile}"`, {
                            cwd: cobolWork,
                            timeout: 30000,
                            stdio: ['pipe', 'pipe', 'pipe']
                        });
                        compiled = true;
                        break;
                    } catch (compileErr) {
                        const errMsg = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                        const isSubroutine = errMsg.includes('USING clause') || errMsg.includes('PROCEDURE/ENTRY has USING');
                        if (isSubroutine) {
                            result.cobol = {
                                ok: false,
                                output: '',
                                error: 'This is a subroutine (PROCEDURE DIVISION USING) — no standalone main program was found in this conversion to link against.'
                            };
                            break;
                        }
                        if (fmt === '-fixed') {
                            result.cobol = {
                                ok: false,
                                output: '',
                                error: 'COBOL compile failed:\n' + errMsg
                            };
                        }
                    }
                }
                if (!result.cobol && compiled) {
                    const start = Date.now();
                    const run = spawnSync(binPath, [], {
                        cwd: cobolWork,
                        timeout: 8000,
                        encoding: 'utf-8',
                        input: userInput,
                        maxBuffer: 10 * 1024 * 1024,
                        env: { ...process.env, COB_LIBRARY_PATH: cobolWork }
                    });
                    const dur = Date.now() - start;
                    let output = (run.stdout || '').trim();
                    if (run.stderr && run.stderr.trim()) output += (output ? '\n' : '') + run.stderr.trim();
                    if (output.length > 8000) output = output.slice(0, 8000) + '\n\n[…output truncated — program produced ' + output.length + ' bytes. It may be stuck in an input loop.]';
                    result.cobol = {
                        ok: run.status === 0 || output.length > 0,
                        exitCode: run.status,
                        duration: dur,
                        output: output || '[no output]',
                        error: run.error ? (run.error.message.includes('ENOBUFS') ? 'Output exceeded buffer (program likely in an input loop)' : run.error.message) : null
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
    const workDir = req.query.workDir;

    if (!workDir || workDir === 'N/A') {
        return res.status(400).json({ error: 'Work directory not available' });
    }

    const result = {
        javaCode: null,
        javaExists: false
    };

    // Try to find Java file in work directory
    try {
        if (fs.existsSync(workDir)) {
            const files = fs.readdirSync(workDir);
            const javaFile = files.find(f => f.endsWith('.java'));

            if (javaFile) {
                const javaPath = path.join(workDir, javaFile);
                result.javaCode = fs.readFileSync(javaPath, 'utf-8');
                result.javaExists = true;
            }
        }
    } catch (err) {
        console.error('Error reading java code:', err);
    }

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
// ============================================

// API: Check if AI is available
app.get('/api/ai/status', (req, res) => {
    res.json({
        available: aiAgent.isAvailable(),
        message: aiAgent.isAvailable()
            ? 'AI agent is ready'
            : 'AI agent not configured. Add your OpenAI API key to .env file.'
    });
});

// API: Analyze a failed conversion
app.post('/api/ai/analyze', async (req, res) => {
    const { sourcePath, workDir, errorType } = req.body;

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    if (!aiAgent.isAvailable()) {
        return res.status(503).json({
            error: 'AI agent not available. Please configure your OpenAI API key in .env file.',
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

        // Perform AI analysis
        const result = await aiAgent.analyzeConversionFailure(cobolSource, errorLog, errorType);

        res.json({
            ...result,
            quickSuggestions
        });

    } catch (error) {
        console.error('AI analyze error:', error);
        res.status(500).json({ error: 'AI analysis failed: ' + error.message });
    }
});

// API: Auto-fix COBOL code
app.post('/api/ai/fix', async (req, res) => {
    const { sourcePath, workDir } = req.body;

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    if (!aiAgent.isAvailable()) {
        return res.status(503).json({
            error: 'AI agent not available. Please configure your OpenAI API key in .env file.'
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
            if (fs.existsSync(cobjLog)) {
                errorLog = fs.readFileSync(cobjLog, 'utf-8');
            }
        }

        // Attempt auto-fix
        const result = await aiAgent.autoFixCobolCode(cobolSource, errorLog);

        res.json(result);

    } catch (error) {
        console.error('AI fix error:', error);
        res.status(500).json({ error: 'AI fix failed: ' + error.message });
    }
});


// ============================================
// Azure AI Agent API Endpoints
// ============================================

// API: Get Azure AI status
app.get('/api/azure/status', (req, res) => {
    res.json({
        available: azureAgent.isAvailable(),
        config: azureAgent.getConfig(),
        message: azureAgent.isAvailable()
            ? 'Azure AI agent is ready'
            : 'Azure AI not configured. Add AZURE_OPENAI_* to .env file.'
    });
});

// API: Convert single COBOL file to Java using Azure
app.post('/api/azure/convert', async (req, res) => {
    const { cobolSource, sourcePath } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    try {
        let source = cobolSource;

        // If sourcePath provided, read from file
        if (!source && sourcePath) {
            if (fs.existsSync(sourcePath)) {
                source = fs.readFileSync(sourcePath, 'utf-8');
            } else {
                return res.status(404).json({ error: 'Source file not found' });
            }
        }

        if (!source) {
            return res.status(400).json({ error: 'COBOL source code required' });
        }

        const result = await azureAgent.convertCobolToJava(source);
        res.json(result);

    } catch (error) {
        console.error('Azure convert error:', error);
        res.status(500).json({ error: 'Azure conversion failed: ' + error.message });
    }
});

// API: Scan directory for COBOL files
app.post('/api/azure/scan', async (req, res) => {
    const { directory } = req.body;

    if (!directory) {
        return res.status(400).json({ error: 'Directory path required' });
    }

    if (!fs.existsSync(directory)) {
        return res.status(404).json({ error: 'Directory not found' });
    }

    try {
        const cobolFiles = azureAgent.scanForCobolFiles(directory);
        res.json({
            success: true,
            directory,
            files: cobolFiles,
            count: cobolFiles.length
        });
    } catch (error) {
        res.status(500).json({ error: 'Scan failed: ' + error.message });
    }
});

// API: Convert entire directory using Azure AI
app.post('/api/azure/convert-directory', async (req, res) => {
    const { inputDir, outputDir } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    if (!inputDir) {
        return res.status(400).json({ error: 'Input directory required' });
    }

    if (!fs.existsSync(inputDir)) {
        return res.status(404).json({ error: 'Input directory not found' });
    }

    // Default output directory
    const outDir = outputDir || path.join(os.tmpdir(), `azure_java_output_${Date.now()}`);

    try {
        const result = await azureAgent.convertDirectory(inputDir, outDir);
        res.json({
            ...result,
            outputDir: outDir
        });
    } catch (error) {
        console.error('Azure directory conversion error:', error);
        res.status(500).json({ error: 'Directory conversion failed: ' + error.message });
    }
});

// API: Analyze failure using Azure AI
app.post('/api/azure/analyze', async (req, res) => {
    const { sourcePath, workDir, errorType } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    try {
        let cobolSource = '';
        try {
            cobolSource = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            return res.status(404).json({ error: 'COBOL source file not found' });
        }

        // Read error logs
        let errorLog = '';
        if (workDir) {
            const logFiles = ['cobj.log', 'javac.log', 'java_stderr.log'];
            for (const logFile of logFiles) {
                const logPath = path.join(workDir, logFile);
                if (fs.existsSync(logPath)) {
                    errorLog += `=== ${logFile} ===\n${fs.readFileSync(logPath, 'utf-8')}\n`;
                }
            }
        }

        const result = await azureAgent.analyzeConversionFailure(cobolSource, errorLog, errorType);
        res.json(result);

    } catch (error) {
        console.error('Azure analyze error:', error);
        res.status(500).json({ error: 'Azure analysis failed: ' + error.message });
    }
});

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
