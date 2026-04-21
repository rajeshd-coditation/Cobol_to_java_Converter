/**
 * POST /api/ai/analyze — AI-backed failure analysis for one COBOL file.
 *
 * Body: { sourcePath, workDir?, errorType, conversionId?, relativePath? }
 *
 * When conversionId + relativePath are provided, the server builds a repo-context
 * block (called programs, sibling Java classes, copybook bodies) and passes it
 * to the analyst — this is what lets the LLM cite real copybooks and CALL
 * targets by name instead of giving generic "make sure X exists" advice.
 *
 * Routing: Azure first (preferred — has truncation detection, retry, and parity
 * with the conversion-time prompts), falling back to direct OpenAI only when
 * Azure isn't configured. Keeping both paths on the SAME analyzer function
 * signature prevents the implementations from drifting.
 *
 * Also always returns regex-based quickSuggestions as a first-pass hint layer
 * on top of whatever the analyst said.
 *
 * mount(app, deps) where deps = { aiAgent, azureAgent, buildAnalysisContext }.
 */

const fs = require('fs');
const path = require('path');

function mount(app, deps) {
    const { aiAgent, azureAgent, buildAnalysisContext } = deps;

    app.post('/api/ai/analyze', async (req, res) => {
        const { sourcePath, workDir, errorType, conversionId, relativePath } = req.body;

        if (!sourcePath) {
            return res.status(400).json({ error: 'Source path required' });
        }

        // Accept the request if EITHER analyzer is available.
        if (!aiAgent.isAvailable() && !azureAgent.isAvailable()) {
            return res.status(503).json({
                error: 'No AI analyzer available. Configure AZURE_OPENAI_* (preferred) or OPENAI_API_KEY in .env.',
                quickSuggestions: aiAgent.getQuickSuggestions(errorType, '')
            });
        }

        try {
            let cobolSource = '';
            try {
                cobolSource = fs.readFileSync(sourcePath, 'utf-8');
            } catch {
                return res.status(404).json({ error: 'COBOL source file not found' });
            }

            // Concatenate whatever logs the work-dir has so the analyst can
            // see compile / runtime errors alongside the source.
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

            const quickSuggestions = aiAgent.getQuickSuggestions(errorType, errorLog);
            const context = buildAnalysisContext(conversionId, relativePath, cobolSource);

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
}

module.exports = { mount };
