/**
 * Azure AI Foundry Agent Service for COBOL to Java Conversion
 * Supports both Azure OpenAI and Azure AI Foundry Agents API
 */

const fs = require('fs');
const path = require('path');

// Azure HTTP transport + init + availability accessors → src/ai/azure-client.js
// Owns azureConfig and exports the shared makeOpenAIRequest everything below
// uses.
const {
    initializeAzure,
    isAvailable,
    getConfig,
    makeOpenAIRequest
} = require('./src/ai/azure-client');

// NOTE: the Azure Assistants/Agent API path (convertWithAgent + thread
// helpers) was removed in an earlier cleanup. It had no retry / truncation
// detection, received no conversion context (copybook bodies, sibling
// signatures, JCL invocations — all the layers we added to the chat path),
// and its prompt rules lived in Azure Portal which meant every fidelity-
// rule change had to be reapplied in two places. Chat Completions works
// for both Azure OpenAI AND AI Foundry with the same key + deployment, so
// the dual-path complexity was earning nothing. If Assistants becomes
// useful again (persistent threads, tool-use), reintroduce it through a
// single shared path that also gets retry + context + truncation — or
// wait for Azure's Responses API which supersedes Assistants.

// autoFixJavaCode + detectTruncation → src/core/auto-fix-java.js
const { autoFixJavaCode, detectTruncation } = require("./src/core/auto-fix-java");

// convertCobolToJava → src/ai/convert-cobol.js
const { convertCobolToJava } = require("./src/ai/convert-cobol");

/**
 * Predict program output using Azure AI
 * Analyzes both COBOL source AND generated Java code for accurate output prediction
 */
async function predictProgramOutput(cobolSource, javaCode) {
    if (!isAvailable()) {
        return {
            success: false,
            error: 'Azure AI not initialized'
        };
    }

    try {
        console.log('    Predicting program output with AI (analyzing both COBOL & Java)...');

        const systemPrompt = `You are an expert COBOL/Java code execution simulator. You will analyze BOTH the original COBOL program AND its converted Java equivalent to produce accurate execution output.

YOUR TASK:
Mentally execute both programs and determine the EXACT output that would be printed to the screen/console.

EXECUTION METHODOLOGY:
1. First, analyze the COBOL program:
   - Identify all WORKING-STORAGE variables and their initial VALUES
   - Trace through PROCEDURE DIVISION statement by statement
   - Note all DISPLAY statements and what they would output

2. Then, cross-reference with the Java code:
   - Verify variable initializations match
   - Trace through main() method and all called methods
   - Note all System.out.println/print statements
   - Confirm the logic flow matches COBOL

3. Derive the final output:
   - Calculate all arithmetic (COMPUTE, ADD, MULTIPLY, etc.)
   - Evaluate all conditions (IF, EVALUATE) with actual values
   - Follow all loops (PERFORM VARYING, for loops) with correct iterations
   - For user input (ACCEPT/Scanner), assume: "Test" for text, "100" for numbers, "Y" for yes/no

OUTPUT RULES:
- Show ONLY the exact text that would appear on screen
- One line per DISPLAY/println statement
- Include the actual computed values, not variable names
- NO explanations, NO "Output:" prefix, NO comments
- If nothing is displayed, respond with: [No output]

EXAMPLE:
COBOL: DISPLAY "Total: " WS-TOTAL (where WS-TOTAL = 250)
Java: System.out.println("Total: " + wsTotal); (where wsTotal = 250)
Your output: Total: 250`;

        // Build user prompt with both COBOL and Java code
        let userPrompt = `Analyze and execute these programs to determine the exact console output:\n\n`;

        userPrompt += `=== ORIGINAL COBOL PROGRAM ===\n${cobolSource}\n\n`;

        if (javaCode && javaCode.length > 50) {
            userPrompt += `=== CONVERTED JAVA PROGRAM ===\n${javaCode}\n\n`;
        }

        userPrompt += `Cross-reference both programs and provide the EXACT execution output. Execute the code step by step, calculating all values, then show only what would be printed.`;

        const response = await makeOpenAIRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], {
            temperature: 0.2,  // Lower temperature for more deterministic output
            maxTokens: 1500
        });

        if (!response || !response.choices || !response.choices[0]) {
            return {
                success: false,
                error: 'Invalid response from Azure AI'
            };
        }

        let predictedOutput = response.choices[0].message?.content || '';
        predictedOutput = predictedOutput.trim();

        // Clean up common AI prefixes and formatting
        predictedOutput = predictedOutput.replace(/^(Output:|The output would be:|Program output:|Expected output:|Console output:)\s*/i, '');
        predictedOutput = predictedOutput.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '');
        predictedOutput = predictedOutput.replace(/^\[Output\]\s*/i, '');

        // Remove any remaining explanation text at the start
        const lines = predictedOutput.split('\n');
        const filteredLines = lines.filter(line => {
            const lowerLine = line.toLowerCase().trim();
            // Filter out common explanation prefixes
            return !lowerLine.startsWith('the program') &&
                !lowerLine.startsWith('this program') &&
                !lowerLine.startsWith('when executed') &&
                !lowerLine.startsWith('the output') &&
                !lowerLine.startsWith('executing');
        });
        predictedOutput = filteredLines.join('\n').trim();

        console.log('   [ok] AI predicted output (cross-referenced):', predictedOutput.substring(0, 100));

        return {
            success: true,
            predictedOutput,
            source: 'azure_ai_cross_reference',
            analyzedBothSources: !!(javaCode && javaCode.length > 50)
        };
    } catch (error) {
        console.error('Output prediction error:', error.message);
        return {
            success: false,
            error: `Prediction failed: ${error.message}`
        };
    }
}

/**
 * Analyze failed conversion using Azure AI
 * @param {string} cobolSource
 * @param {string} errorLog
 * @param {string} errorType
 * @param {object} [context] optional repo-level context so the analyst can
 *        reference real sibling files, copybook bodies, JCL — instead of
 *        giving generic advice based only on the source shown.
 * @param {string[]} [context.calledPrograms]
 * @param {string[]} [context.copybooks]
 * @param {Record<string,string>} [context.programIdToJavaClass]
 * @param {Record<string,string>} [context.copybookBodies] name → .cpy source
 */
async function analyzeConversionFailure(cobolSource, errorLog, errorType, context = {}) {
    if (!isAvailable()) {
        return {
            success: false,
            error: 'Azure AI not initialized. Configure AZURE_OPENAI_* in .env file.'
        };
    }

    // Build an optional context block. Without this, "COPY MISSING-BOOK"
    // failures get generic "add the copybook" advice — with it, the analyst
    // can say "the copybook is named FOO and exists at path X" or "it really
    // is missing from the repo, here are the copybooks that DO exist".
    let contextBlock = '';
    const calls = Array.isArray(context.calledPrograms) ? context.calledPrograms : [];
    const copies = Array.isArray(context.copybooks) ? context.copybooks : [];
    const pidMap = context.programIdToJavaClass || {};
    const cpyBodies = context.copybookBodies || {};
    if (calls.length || copies.length || Object.keys(pidMap).length) {
        contextBlock = '\n\n=== REPO CONTEXT ===\n';
        if (calls.length) {
            contextBlock += 'This COBOL program CALLs:\n';
            for (const name of calls) {
                const key = name.toUpperCase();
                const javaClass = pidMap[key];
                contextBlock += javaClass
                    ? `  - '${name}' → Java class ${javaClass} exists in this conversion\n`
                    : `  - '${name}' → NOT in this conversion (external module)\n`;
            }
        }
        if (copies.length) {
            contextBlock += 'COPY targets referenced:\n';
            for (const name of copies) {
                const key = name.toUpperCase();
                contextBlock += cpyBodies[key]
                    ? `  - ${name} (source available; see below)\n`
                    : `  - ${name} (source NOT in repo — likely cause of a COPY failure)\n`;
            }
            for (const name of copies) {
                const body = cpyBodies[name.toUpperCase()];
                if (body) {
                    contextBlock += `\n=== COPYBOOK ${name} ===\n${body}\n=== END COPYBOOK ${name} ===\n`;
                }
            }
        }
        contextBlock += '===============\n';
    }

    try {
        // Single path: Chat Completions. The Assistants/Agent branch that
        // lived here never received context improvements and duplicated
        // behavior that drifts from the chat path; removed with the rest
        // of the Agent API cleanup.
        const response = await makeOpenAIRequest([
            { role: 'system', content: 'You are an expert COBOL to Java migration specialist. Analyze conversion failures and provide actionable solutions. If REPO CONTEXT is provided, reference specific files / copybooks by name — don\'t give generic advice when the repo state is known.' },
            { role: 'user', content: `Analyze this failure:\nError Type: ${errorType}\nError: ${errorLog}\nCOBOL: ${cobolSource}${contextBlock}` }
        ], { temperature: 0.3, maxTokens: 2000 });

        const analysis = response.choices[0].message.content;
        return {
            success: true,
            analysis
        };
    } catch (error) {
        console.error('Azure Analysis Error:', error.message);
        return {
            success: false,
            error: `Azure analysis failed: ${error.message}`
        };
    }
}

// scanForCobolFiles + scanForAllMainframeFiles → src/scan/cobol-scanner.js
const { scanForCobolFiles, scanForAllMainframeFiles } = require('./src/scan/cobol-scanner');

/**
 * Convert all COBOL files in a directory
 */
async function convertDirectory(inputDir, outputDir, progressCallback) {
    if (!isAvailable()) {
        return { success: false, error: 'Azure AI not initialized' };
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const cobolFiles = scanForCobolFiles(inputDir);

    const results = {
        total: cobolFiles.length,
        converted: 0,
        failed: 0,
        skipped: 0,
        files: []
    };

    for (let i = 0; i < cobolFiles.length; i++) {
        const cobolPath = cobolFiles[i];
        const relativePath = path.relative(inputDir, cobolPath);
        const baseName = path.basename(cobolPath, path.extname(cobolPath));

        if (progressCallback) {
            progressCallback({ current: i + 1, total: cobolFiles.length, file: relativePath, status: 'processing' });
        }

        try {
            const cobolSource = fs.readFileSync(cobolPath, 'utf-8');

            if (cobolSource.trim().length < 50) {
                results.skipped++;
                results.files.push({ source: relativePath, status: 'skipped', reason: 'File too small' });
                continue;
            }

            const conversionResult = await convertCobolToJava(cobolSource);

            if (conversionResult.success) {
                const javaFileName = toPascalCase(baseName) + '.java';
                const javaPath = path.join(outputDir, javaFileName);

                fs.writeFileSync(javaPath, conversionResult.javaCode);

                results.converted++;
                results.files.push({ source: relativePath, output: javaFileName, status: 'success' });
            } else {
                results.failed++;
                results.files.push({ source: relativePath, status: 'failed', error: conversionResult.error });
            }

            // Delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
            results.failed++;
            results.files.push({ source: relativePath, status: 'error', error: error.message });
        }
    }

    return { success: true, results };
}

/**
 * Convert string to PascalCase
 */
// toPascalCase → src/util/pascal-case.js
const { toPascalCase } = require('./src/util/pascal-case');

// analyzeConversionAccuracy → src/core/accuracy-scorer.js
const { analyzeConversionAccuracy } = require("./src/core/accuracy-scorer");

/**
 * Check if Azure AI is available
 */
// isAvailable + getConfig → src/ai/azure-client.js (re-exported below).

/**
 * Ask the AI to compare the runtime output of the original COBOL vs the
 * generated Java and render a human-readable verdict. Used by the "Run and
 * compare" panel to replace brittle regex heuristics with a semantic check.
 *
 * @param {object} p
 * @param {string} p.cobolOutput - captured stdout/stderr from the COBOL run
 * @param {string} p.javaOutput  - captured stdout/stderr from the Java run
 * @param {number|null} [p.cobolExit]
 * @param {number|null} [p.javaExit]
 * @param {boolean} [p.cobolTimedOut]
 * @param {boolean} [p.javaTimedOut]
 * @param {string} [p.fileName]
 * @param {string} [p.cobolSource] - optional original COBOL source. When provided,
 *        the comparator can reason about which DISPLAY statement produced which
 *        line, catching "different numeric result" as expected transformation
 *        vs real divergence.
 * @param {string} [p.javaCode] - optional generated Java source. Same rationale
 *        as cobolSource — lets the comparator verify the Java actually implements
 *        what the COBOL intended, not just that both produced similar strings.
 * @returns {Promise<{verdict:'match'|'partial'|'diverge', severity:'ok'|'info'|'warning'|'error', title:string, reasons:string[]}>}
 */
async function compareRunOutputs(p) {
    if (!isAvailable()) {
        return {
            verdict: 'unknown', severity: 'info',
            title: 'AI unavailable',
            reasons: ['Azure AI is not configured — output comparison is skipped.']
        };
    }

    // Keep the payload bounded to avoid token bloat; outputs from stuck programs
    // can be 10MB. Take head+tail so we see both the start AND whether it ended.
    const snippet = (s) => {
        if (!s) return '(empty)';
        if (s.length <= 4000) return s;
        return s.slice(0, 2000) + `\n…[${s.length - 4000} chars elided]…\n` + s.slice(-2000);
    };

    const systemPrompt =
        'You are a mainframe-modernization reviewer. You receive the runtime' +
        ' output of a COBOL program and the runtime output of the Java conversion' +
        ' of that same program, run with identical input. Decide whether they' +
        ' represent EQUIVALENT program behavior or meaningfully DIVERGE.\n\n' +
        'CRITICAL: distinguish source/toolchain issues from semantic divergence.\n' +
        'If the COBOL side reports a COMPILE error (text like "compile failed",' +
        '"error:", "is not defined", "unexpected", "syntax error"), that is a' +
        ' source-code or toolchain issue — NOT a behavioral divergence between' +
        ' the two programs. Label it verdict="partial" severity="warning" with' +
        ' title "COBOL source will not compile" and explain the compile error' +
        ' briefly. The Java output in that case is not comparable.\n' +
        'Similarly if Java fails to compile while COBOL runs — source issue, not' +
        ' divergence.\n\n' +
        'Be pragmatic about the actual behavior comparison:\n' +
        '- Different amounts of padded whitespace, minor formatting, or extra' +
        '  debug lines on one side are NOT divergence if the business outcome' +
        '  matches.\n' +
        '- Both programs getting stuck in the same input-waiting loop (truncated' +
        '  output, killed by timeout) is a *matched* failure mode — NOT divergence.\n' +
        '- COBOL "file does not exist (status = 35)" paired with Java "using' +
        '  sample data for demonstration" is DIVERGENT: the Java is fabricating' +
        '  input the COBOL did not have. Verdict="diverge" severity="error"' +
        '  with a reason that the Java conversion must be regenerated to fail' +
        '  on missing input (print error + non-zero exit), not substitute data.\n' +
        '- COBOL status 35 paired with a Java FileNotFoundException /' +
        '  non-zero exit on the same file is a MATCHED failure mode — both' +
        '  programs correctly refused to run without the input. Label "match"' +
        '  (or "partial" if output formatting differs) with a hint to stage' +
        '  the data file before re-running.\n' +
        '- COBOL output "unavailable" + "requires DB2/CICS/IMS preprocessor"' +
        '  means COBOL could not compile or run in this local environment —' +
        '  NOT a behavioral difference with Java. If the Java side exits' +
        '  correctly on missing input (status = 35, FileNotFoundException,' +
        '  System.exit(1)), that is FAITHFUL behavior matching what COBOL' +
        '  would do on a real mainframe. Do NOT label this "divergence" and' +
        '  do NOT call Java "fabricating" — Java is doing exactly what the' +
        '  fidelity rule requires. Verdict="partial" severity="info" title' +
        '  "COBOL unrunnable locally — Java behavior acceptable" with a' +
        '  reason that a DB2/CICS/IMS-capable environment is needed for a' +
        '  true runtime comparison.\n' +
        '- Treat as DIVERGENT: different numeric results, different control flow' +
        '  where BOTH actually ran, one side simulating (mock/sample/stub) while' +
        '  the other is real business logic, one side loading an external module' +
        '  that the other does not, or the Java inventing behavior (HTTP, JSON,' +
        '  auth) absent from the COBOL.\n\n' +
        'Respond in JSON only. Shape:\n' +
        '{\n' +
        '  "verdict":  "match" | "partial" | "diverge",\n' +
        '  "severity": "ok" | "info" | "warning" | "error",\n' +
        '  "title":    "<5-10 word summary>",\n' +
        '  "reasons":  ["<concise reason>", "..."]\n' +
        '}\n' +
        'Keep reasons <= 3 and each one actionable.';

    // Source is sent in full when available so the comparator can cite specific
    // DISPLAY statements / computations. Outputs stay head+tail-snippet because
    // stuck programs can produce megabytes of repetitive text.
    const userPrompt =
        `File: ${p.fileName || 'unknown'}\n` +
        `COBOL exit code: ${p.cobolExit ?? 'unknown'} (timedOut=${!!p.cobolTimedOut})\n` +
        `Java  exit code: ${p.javaExit ?? 'unknown'} (timedOut=${!!p.javaTimedOut})\n` +
        (p.cobolSource ? `\n=== ORIGINAL COBOL SOURCE ===\n${p.cobolSource}\n` : '') +
        (p.javaCode    ? `\n=== GENERATED JAVA SOURCE ===\n${p.javaCode}\n`    : '') +
        (p.cobolError ? `\n=== COBOL TOOLCHAIN ERROR (compile/run side) ===\n${snippet(p.cobolError)}\n` : '') +
        (p.javaError  ? `\n=== JAVA TOOLCHAIN ERROR (compile/run side) ===\n${snippet(p.javaError)}\n`  : '') +
        `\n=== COBOL OUTPUT ===\n${snippet(p.cobolOutput)}\n\n` +
        `=== JAVA OUTPUT ===\n${snippet(p.javaOutput)}\n`;

    try {
        const response = await makeOpenAIRequest(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ],
            { temperature: 0.1, maxTokens: 500 }
        );
        let content = response?.choices?.[0]?.message?.content || '';
        // Strip code fences if present
        content = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        let parsed;
        try { parsed = JSON.parse(content); }
        catch {
            // Recover: try to find the first {...} block
            const m = content.match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
        }
        if (!parsed || typeof parsed !== 'object') {
            return {
                verdict: 'unknown', severity: 'info',
                title: 'AI response unparseable',
                reasons: [String(content).slice(0, 300) || 'Empty response']
            };
        }
        // Clamp to known shape / defaults
        const verdict = ['match', 'partial', 'diverge'].includes(parsed.verdict) ? parsed.verdict : 'unknown';
        const severity = ['ok', 'info', 'warning', 'error'].includes(parsed.severity)
            ? parsed.severity
            : (verdict === 'match' ? 'ok' : verdict === 'partial' ? 'info' : 'warning');
        return {
            verdict,
            severity,
            title: String(parsed.title || (verdict === 'match' ? 'Outputs match' : verdict === 'partial' ? 'Outputs mostly match' : 'Outputs diverge')).slice(0, 120),
            reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5).map(r => String(r).slice(0, 300)) : []
        };
    } catch (err) {
        return {
            verdict: 'unknown', severity: 'info',
            title: 'Comparison unavailable',
            reasons: [err.message || 'AI call failed']
        };
    }
}

/**
 * Repair a generated Java file using a separate AI pass. Given:
 *   - the current Java code (that likely has compile errors or wrong behavior)
 *   - the original COBOL source
 *   - compile errors + run output
 *   - known sibling dependencies (class names the caller can use)
 * …produce a better Java file that compiles and behaves closer to COBOL.
 *
 * Returns { success, javaCode, error, usage }
 */
async function fixJavaCode({ javaCode, cobolSource, compileErrors, runOutput, cobolOutput, dependencies }) {
    if (!isAvailable()) {
        return { success: false, error: 'Azure AI not configured' };
    }
    if (!javaCode) {
        return { success: false, error: 'No Java code to fix' };
    }

    // Head+tail snippet helper — used ONLY for runtime stdout capture below.
    // Source code, Java code, and compile errors are sent in FULL so the
    // repair agent has complete context (mid-file bugs are invisible to a
    // head-only snippet; a compile error on line 800 with the source sliced
    // at 4k chars = ~150 lines leaves the repair agent blind).
    const snippet = (s, limit = 3000) => {
        if (!s) return '';
        if (s.length <= limit) return s;
        return s.slice(0, limit * 2 / 3) + `\n…[${s.length - limit} chars elided]…\n` + s.slice(-limit / 3);
    };

    const systemPrompt =
        'You are a Java repair agent specialized in COBOL-to-Java conversions.\n' +
        'You receive an existing Java file that was produced by another AI agent\n' +
        'and probably has bugs (compile errors, type mismatches, missing methods,\n' +
        'invented behavior, or semantic drift from the original COBOL). Return a\n' +
        'repaired version that:\n' +
        '1. COMPILES cleanly with plain javac (no external dependencies).\n' +
        '2. Preserves the business logic expressed in the ORIGINAL COBOL.\n' +
        '3. Uses the listed sibling classes instead of simulating their calls.\n' +
        '4. Does NOT invent behavior (HTTP, JSON, REST, auth) absent from COBOL.\n' +
        '5. `throws` appears ONLY on method signatures. NEVER write `for (...) throws`,\n' +
        '   `while (...) throws`, `if (...) throws`, `switch (...) throws`, `else throws`,\n' +
        '   `do throws` — those are compile errors. A checked exception inside a loop\n' +
        '   either (a) bubbles up via `throws IOException` on the enclosing method, or\n' +
        '   (b) is caught with try/catch inside that loop/conditional.\n' +
        '5b. Properly handles IOException — methods that use File I/O must either\n' +
        '   declare `throws Exception` OR wrap the I/O in try-catch.\n' +
        '6. Every method called must be DEFINED in the same class or standard\n' +
        '   Java library.\n' +
        '7. Generic collections must be type-consistent.\n' +
        '8. REMOVE FABRICATED INPUT DATA. If the current Java has blocks like\n' +
        '   "Input file not found, using sample data for demonstration…" or\n' +
        '   hardcoded account/employee records that substitute for missing\n' +
        '   files, DELETE that fallback. The repaired Java must fail the same\n' +
        '   way the COBOL does when input is missing: print a clear error and\n' +
        '   exit non-zero. No silent sample-data substitution.\n' +
        '9. DO NOT THROW on malformed STDIN input. COBOL ACCEPT silently stores\n' +
        '   zeroes on non-numeric text, and returns blanks forever on EOF. If\n' +
        '   the current Java uses Integer.parseInt / new BigDecimal / similar\n' +
        '   on stdin and the runtime output shows NumberFormatException or\n' +
        '   NullPointerException, wrap the parse in try/catch default-zero\n' +
        '   and null-check the Scanner.nextLine() return (treat null as "").\n' +
        '10. PRESERVE PIC 9(N) zero-padding. COBOL DISPLAY of PIC 9(6) value 8\n' +
        '    prints "000008", not "8". If the current Java prints bare ints\n' +
        '    via System.out.print(x) or "%d", replace with String.format("%0Nd", x)\n' +
        '    where N matches the PIC width declared in the COBOL source.\n' +
        '\n' +
        'Respect the same conventions as the original agent:\n' +
        '- One public class per file, no package declaration\n' +
        '- No `final` on instance fields\n' +
        '- No Scanner; no interactive input — use hardcoded demo values\n' +
        '- Initialize ALL variables at declaration\n' +
        '- Include all necessary imports (java.io.*, java.util.*, java.math.*)\n' +
        '- main() wraps in try-catch with Exception handling\n' +
        '- Print "=== Program Started ===" / "=== Program Completed ===" banners\n' +
        '\n' +
        'Output ONLY the complete, corrected Java source. No explanations, no\n' +
        'markdown fences, no commentary — just the raw Java file.';

    const depBlock = (dependencies && Object.keys(dependencies).length > 0)
        ? 'Sibling Java classes available (you CAN call these via `new ClassName().run(...)`):\n'
          + Object.entries(dependencies).map(([pid, cls]) => `  - PROGRAM-ID ${pid} → class ${cls}`).join('\n')
        : 'No sibling Java classes are available for CALL targets — emit // TODO instead of simulating.';

    // Source material is sent FULL — matches the primary convertCobolToJava
    // policy so the repair agent sees every line. Runtime stdout (cobolOutput
    // / runOutput) stays head+tail-snipped because stuck-in-a-loop programs
    // produce megabytes of repetitive text; first+last few KB tell the story.
    const userPrompt =
        `=== ORIGINAL COBOL ===\n${cobolSource}\n\n` +
        `=== CURRENT JAVA (needs fixing) ===\n${javaCode}\n\n` +
        (compileErrors ? `=== COMPILE ERRORS ===\n${compileErrors}\n\n` : '') +
        (cobolOutput ? `=== WHAT COBOL OUTPUTS WHEN RUN ===\n${snippet(cobolOutput, 1500)}\n\n` : '') +
        (runOutput   ? `=== WHAT CURRENT JAVA OUTPUTS ===\n${snippet(runOutput, 1500)}\n\n`   : '') +
        `=== DEPENDENCIES ===\n${depBlock}\n\n` +
        `Produce the corrected Java file.`;

    try {
        const response = await makeOpenAIRequest(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ],
            { temperature: 0.15, maxTokens: 16000 }
        );
        let content = response?.choices?.[0]?.message?.content || '';
        content = content.replace(/^```(?:java)?\n?/i, '').replace(/\n?```$/i, '').trim();
        if (!content || content.length < 50 || !/class\s+\w+/.test(content)) {
            return { success: false, error: 'AI did not return valid Java source', usage: response?.usage };
        }
        // Apply existing auto-fixes for consistency
        const finalCode = autoFixJavaCode(content);
        return { success: true, javaCode: finalCode, usage: response?.usage };
    } catch (err) {
        return { success: false, error: err.message || 'AI call failed' };
    }
}

module.exports = {
    initializeAzure,
    convertCobolToJava,
    predictProgramOutput,
    analyzeConversionFailure,
    analyzeConversionAccuracy,
    scanForCobolFiles,
    scanForAllMainframeFiles,
    convertDirectory,
    compareRunOutputs,
    fixJavaCode,
    isAvailable,
    getConfig
};
