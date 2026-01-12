/**
 * AI Agent Service for COBOL to Java Conversion
 * Uses OpenAI GPT-4 to analyze failed conversions and suggest fixes
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
 * @returns {Promise<object>} Analysis result with suggestions
 */
async function analyzeConversionFailure(cobolSource, errorLog, errorType) {
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

    const userPrompt = `A COBOL program failed to convert to Java. Please analyze and provide suggestions.

**Error Type:** ${errorType}

**Error Log:**
\`\`\`
${errorLog || 'No error log available'}
\`\`\`

**COBOL Source Code:**
\`\`\`cobol
${cobolSource.substring(0, 8000)}${cobolSource.length > 8000 ? '\n... (truncated)' : ''}
\`\`\`

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

/**
 * Attempt to auto-fix a COBOL file for successful conversion
 * @param {string} cobolSource - The original COBOL source code
 * @param {string} errorLog - The error log from the conversion attempt
 * @returns {Promise<object>} Fixed code or error
 */
async function autoFixCobolCode(cobolSource, errorLog) {
    if (!openai) {
        return {
            success: false,
            error: 'AI agent not initialized. Please configure your OpenAI API key in the .env file.'
        };
    }

    const systemPrompt = `You are a COBOL code transformer. Your job is to modify COBOL source code to make it compatible with the opensourcecobol4j (cobj) compiler.

Rules:
1. Return ONLY the modified COBOL code, no explanations
2. Preserve the original program logic
3. Remove or stub out unsupported features (CICS, DB2, VSAM)
4. Fix syntax issues that prevent compilation
5. Add missing required divisions if absent
6. Comment out COPY statements for missing copybooks with a note
7. Keep the code as close to the original as possible

If the code cannot be fixed, return the original code with comments explaining issues.`;

    const userPrompt = `Fix this COBOL code to make it compatible with opensourcecobol4j:

**Error:**
\`\`\`
${errorLog || 'Conversion failed'}
\`\`\`

**Original COBOL:**
\`\`\`cobol
${cobolSource}
\`\`\`

Return only the fixed COBOL code:`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2,
            max_tokens: 4000
        });

        let fixedCode = response.choices[0].message.content;

        // Clean up markdown code blocks if present
        fixedCode = fixedCode.replace(/^```cobol\n?/i, '').replace(/\n?```$/i, '');
        fixedCode = fixedCode.replace(/^```\n?/, '').replace(/\n?```$/, '');

        return {
            success: true,
            fixedCode: fixedCode.trim(),
            model: response.model,
            usage: {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens
            }
        };
    } catch (error) {
        console.error('AI Auto-fix Error:', error.message);
        return {
            success: false,
            error: `AI auto-fix failed: ${error.message}`
        };
    }
}

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
    autoFixCobolCode,
    getQuickSuggestions,
    isAvailable
};
