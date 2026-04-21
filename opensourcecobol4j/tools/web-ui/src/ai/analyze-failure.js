/**
 * AI-backed failure analyst for /api/ai/analyze.
 *
 * When a conversion fails (CONVERT_FAIL / COMPILE_FAIL / EXEC_FAIL) the UI
 * calls this with the COBOL source, the error log, and an optional
 * repo-context block (calledPrograms, copybooks, programIdToJavaClass,
 * copybookBodies). The analyst produces a plain-language diagnosis the
 * user can act on without reading the conversion prompt itself.
 *
 * Why repo-context? Without it the analyst degrades to generic "make sure
 * copybook FOO exists" advice. With it, it can say "copybook FOO is at
 * cpy/FOO.cpy — here's the actual field definition and which of your
 * programs COPY it", which is usable guidance. The same context shape
 * passes into the primary conversion prompt and the repair agent, so all
 * three see the repo the same way.
 *
 * Returns { success, analysis, error?, usage? }. The route wraps this
 * with regex-based quickSuggestions for extra surface area.
 */

const { isAvailable, makeOpenAIRequest } = require('./azure-client');

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
module.exports = { analyzeConversionFailure };
