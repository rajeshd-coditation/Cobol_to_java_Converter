/**
 * OpenAI-direct fallback for COBOL→Java conversion failure analysis.
 *
 * Role after the 2026-04-21 cleanup:
 *   - Used ONLY when Azure isn't configured (the primary path is `azureAgent.js`).
 *   - The `/api/ai/analyze` endpoint prefers `azureAgent.analyzeConversionFailure`
 *     when Azure is available, and routes here only as a fallback — so this
 *     file's `analyzeConversionFailure` is rarely hit in production.
 *   - `getQuickSuggestions` stays as the single-source regex-based first-pass
 *     hinter (curated common-error patterns); not worth duplicating into azureAgent.
 *
 * Exposed surface is intentionally small:
 *   - initializeOpenAI() — config; called at server boot.
 *   - analyzeConversionFailure(src, log, type, context?) — Azure-fallback analyst.
 *   - getQuickSuggestions(type, log) — regex hinter (always available).
 *   - isAvailable() — did initializeOpenAI find a key?
 *
 * If you're tempted to add a new OpenAI-direct feature here, first ask whether
 * it should live in azureAgent.js instead. Duplicated conversion-side logic is
 * how prompt drift happens — the no-fallback rule, copybook inlining, sibling
 * signatures, JCL context etc. all live in ONE place (azureAgent.js) for a
 * reason. Keep this file narrow.
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Initialize OpenAI client
let openai = null;

function initializeOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
        console.warn('⚠️  OpenAI API key not configured. AI features will be disabled.');
        console.warn('   To enable AI features, add your API key to .env file');
        return false;
    }

    openai = new OpenAI({ apiKey });
    console.log('✅ OpenAI AI Agent initialized successfully');
    return true;
}

/**
 * Analyze a failed COBOL conversion and provide suggestions
 * @param {string} cobolSource - The original COBOL source code
 * @param {string} errorLog - The error log from the conversion attempt
 * @param {string} errorType - Type of error (CONVERT_FAIL, COMPILE_FAIL, EXEC_FAIL)
 * @param {object} [context] - Optional repo-level context (calledPrograms,
 *        copybooks, programIdToJavaClass, copybookBodies). When provided the
 *        analyst can reference real repo state rather than give generic advice.
 * @returns {Promise<object>} Analysis result with suggestions
 */
async function analyzeConversionFailure(cobolSource, errorLog, errorType, context = {}) {
    if (!openai) {
        return {
            success: false,
            error: 'AI agent not initialized. Please configure your OpenAI API key in the .env file.'
        };
    }

    const systemPrompt = `You are an expert COBOL to Java migration specialist. You help developers understand why their COBOL programs fail to convert to Java using the opensourcecobol4j (cobj) compiler.

Your task is to:
1. Analyze the COBOL source code and error logs
2. Identify the root cause of the conversion failure
3. Provide clear, actionable suggestions to fix the issue
4. If possible, suggest modified COBOL code that would convert successfully

Common issues include:
- Missing COPYBOOK files (COPY statements referencing unavailable files)
- Unsupported COBOL dialects or proprietary extensions
- Missing IDENTIFICATION DIVISION or PROGRAM-ID
- Deprecated or non-standard syntax
- External dependencies (CICS, DB2, VSAM, MQ)
- Nested COPY statements
- Improper file organization clauses

Always be specific and provide code examples when possible.`;

    // Optional repo-context block — lets the analyst cite real copybooks / CALL
    // targets / sibling classes instead of generic "make sure X exists" advice.
    let contextBlock = '';
    const calls = Array.isArray(context.calledPrograms) ? context.calledPrograms : [];
    const copies = Array.isArray(context.copybooks) ? context.copybooks : [];
    const pidMap = context.programIdToJavaClass || {};
    const cpyBodies = context.copybookBodies || {};
    if (calls.length || copies.length || Object.keys(pidMap).length) {
        contextBlock = '\n\n**Repo Context:**\n';
        if (calls.length) {
            contextBlock += 'CALL targets:\n';
            for (const name of calls) {
                const javaClass = pidMap[name.toUpperCase()];
                contextBlock += javaClass
                    ? `- ${name} → ${javaClass} (in this conversion)\n`
                    : `- ${name} → external, not in repo\n`;
            }
        }
        if (copies.length) {
            contextBlock += 'COPY targets:\n';
            for (const name of copies) {
                const key = name.toUpperCase();
                contextBlock += cpyBodies[key]
                    ? `- ${name} (source available below)\n`
                    : `- ${name} (source NOT in repo)\n`;
            }
            for (const name of copies) {
                const body = cpyBodies[name.toUpperCase()];
                if (body) {
                    contextBlock += `\n\`\`\`cobol copybook: ${name}\n${body}\n\`\`\`\n`;
                }
            }
        }
    }

    const userPrompt = `A COBOL program failed to convert to Java. Please analyze and provide suggestions.

**Error Type:** ${errorType}

**Error Log:**
\`\`\`
${errorLog || 'No error log available'}
\`\`\`

**COBOL Source Code:**
\`\`\`cobol
${cobolSource}
\`\`\`${contextBlock}

Please provide:
1. **Root Cause Analysis**: What is causing this conversion to fail?
2. **Suggested Fixes**: Specific steps to resolve the issue
3. **Modified Code** (if applicable): Show the corrected COBOL code
4. **Alternative Approaches**: Other ways to handle this conversion`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 2000
        });

        const analysis = response.choices[0].message.content;

        return {
            success: true,
            analysis: analysis,
            model: response.model,
            usage: {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens
            }
        };
    } catch (error) {
        console.error('AI Analysis Error:', error.message);
        return {
            success: false,
            error: `AI analysis failed: ${error.message}`
        };
    }
}

// autoFixCobolCode removed — its only caller (/api/ai/fix endpoint) was
// never wired to the frontend. If a COBOL-source auto-fix is needed in the
// future, reintroduce it alongside the Java repair path (fixJavaCode in
// azureAgent.js) so both sides of the conversion share the same retry /
// truncation / context plumbing.

/**
 * Get quick suggestions for common error patterns
 * @param {string} errorType - Type of error
 * @param {string} errorLog - Error log text
 * @returns {object} Quick suggestions based on patterns
 */
function getQuickSuggestions(errorType, errorLog) {
    const suggestions = [];
    const errorText = (errorLog || '').toLowerCase();

    // Pattern matching for common issues
    if (errorText.includes('copy') || errorText.includes('copybook')) {
        suggestions.push({
            type: 'MISSING_COPYBOOK',
            title: 'Missing Copybook',
            description: 'The program references a COPY file that was not found. Either provide the copybook or remove/inline the COPY statement.',
            icon: '📁'
        });
    }

    if (errorText.includes('cics') || errorText.includes('exec cics')) {
        suggestions.push({
            type: 'CICS_DEPENDENCY',
            title: 'CICS Dependency',
            description: 'This program uses CICS calls which require a mainframe environment. Consider removing or stubbing CICS sections.',
            icon: '🖥️'
        });
    }

    if (errorText.includes('db2') || errorText.includes('exec sql')) {
        suggestions.push({
            type: 'DB2_DEPENDENCY',
            title: 'DB2/SQL Dependency',
            description: 'This program uses embedded SQL. Consider using JDBC in the Java output or removing SQL sections.',
            icon: '🗄️'
        });
    }

    if (errorType === 'COMPILE_FAIL') {
        suggestions.push({
            type: 'JAVA_COMPILE_ERROR',
            title: 'Java Compilation Error',
            description: 'The generated Java code has syntax errors. This may indicate unsupported COBOL features or complex data structures.',
            icon: '⚙️'
        });
    }

    if (errorType === 'EXEC_FAIL') {
        suggestions.push({
            type: 'RUNTIME_ERROR',
            title: 'Runtime Error',
            description: 'The Java program compiled but failed during execution. Check for missing runtime dependencies or data issues.',
            icon: '🔥'
        });
    }

    if (suggestions.length === 0) {
        suggestions.push({
            type: 'UNKNOWN',
            title: 'Conversion Issue',
            description: 'Use the AI analysis feature for a detailed examination of this failure.',
            icon: '🔍'
        });
    }

    return suggestions;
}

/**
 * Check if AI agent is available
 * @returns {boolean}
 */
function isAvailable() {
    return openai !== null;
}

module.exports = {
    initializeOpenAI,
    analyzeConversionFailure,
    getQuickSuggestions,
    isAvailable
};
