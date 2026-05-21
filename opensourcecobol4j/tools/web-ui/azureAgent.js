/**
 * azureAgent — public facade that the web UI + CLI import as `./azureAgent`.
 *
 * Every real implementation lives under src/. This file exists only to
 * aggregate the module surface and preserve the stable
 * `azureAgent.<functionName>` call shape that server.js, routes, and the
 * old CLI entry depend on. Touching the contents here should be a rare
 * event — most changes land in src/ai/ / src/core/ / src/scan/.
 *
 * Layout of the backing modules:
 *   src/ai/azure-client.js      transport (init + makeOpenAIRequest + is/get)
 *   src/ai/convert-cobol.js     primary COBOL → Java prompt
 *   src/ai/fix-java.js          repair prompt for /api/fix-java
 *   src/ai/analyze-failure.js   failure analyst for /api/ai/analyze
 *   src/ai/compare-runs.js      COBOL-vs-Java runtime verdict
 *   src/scan/cobol-scanner.js   recursive file enumeration
 *   src/core/auto-fix-java.js   regex post-processor (runs on every
 *                               converter and repair output)
 *   src/core/accuracy-scorer.js semantic-penalty / 0–100 accuracy score
 *   src/util/pascal-case.js     COBOL basename → Java class name
 *
 * Removed in earlier cleanups and intentionally NOT reintroduced:
 *   - Assistants/Agent API transport (convertWithAgent + thread helpers).
 *     It had no retry / truncation detection, received no conversion
 *     context (copybook bodies, sibling signatures, JCL invocations),
 *     and kept its prompt rules in Azure Portal — so fidelity-rule
 *     changes drifted out of sync with the code path. Chat Completions
 *     works identically for Azure OpenAI + AI Foundry with the same key.
 *   - predictProgramOutput / convertDirectory. Neither had live callers.
 *     If a future use case revives them, rebuild through the same
 *     transport + context plumbing the active prompts already use.
 */

const { initializeAzure, isAvailable, getConfig } = require('./src/ai/azure-client');
const { convertCobolToJava } = require('./src/ai/convert-cobol');
const { fixJavaCode } = require('./src/ai/fix-java');
const { analyzeConversionFailure } = require('./src/ai/analyze-failure');
const { compareRunOutputs } = require('./src/ai/compare-runs');
const { extractBusinessRules, analyzeBusinessRuleCoverage } = require('./src/ai/business-rules');
const { scanForCobolFiles, scanForAllMainframeFiles } = require('./src/scan/cobol-scanner');
const { analyzeConversionAccuracy } = require('./src/core/accuracy-scorer');

module.exports = {
    initializeAzure,
    isAvailable,
    getConfig,
    convertCobolToJava,
    fixJavaCode,
    analyzeConversionFailure,
    compareRunOutputs,
    extractBusinessRules,
    analyzeBusinessRuleCoverage,
    scanForCobolFiles,
    scanForAllMainframeFiles,
    analyzeConversionAccuracy
};
