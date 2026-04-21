/**
 * POST /api/convert — LOCAL conversion path (bash scanner + `cobj` compiler).
 *
 * This is the original pre-AI path, still supported for users with a working
 * cobj toolchain. The Azure AI path (/api/convert-azure) is the default for
 * the web UI — that one builds a dependency graph, does parallel waves, HITL
 * review, etc. The local path just shells out to cobol_repo_scanner.sh and
 * reports the result.
 *
 * Pipeline:
 *   1. spawn the scanner script against the given repo URL/path
 *   2. stream stdout into conversion.logs so the UI can tail progress
 *   3. on close, parseScannerOutput reads report.json (preferred) or falls
 *      back to log-scraping
 *   4. runCompileGateOnReport — flips `SUCCESS` entries whose .java actually
 *      fails javac to `COMPILE_FAIL`, so the UI doesn't show green on code
 *      that won't compile. Parity with the Azure path's compile gate.
 *
 * Body: { repoUrl }  → { conversionId, outputDir }
 *
 * mount(app, deps) where deps = {
 *   activeConversions, SCANNER_SCRIPT, parseScannerOutput,
 *   runCompileGateOnReport, stripAnsi
 * }.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function mount(app, deps) {
    const {
        activeConversions,
        SCANNER_SCRIPT,
        parseScannerOutput,
        runCompileGateOnReport,
        stripAnsi
    } = deps;

    app.post('/api/convert', async (req, res) => {
        const { repoUrl } = req.body;

        if (!repoUrl || repoUrl.trim() === '') {
            return res.status(400).json({ error: 'Repository URL or path is required' });
        }

        const conversionId = Date.now().toString();
        const outputDir = path.join(os.tmpdir(), `cobol_output_${conversionId}`);
        fs.mkdirSync(outputDir, { recursive: true });

        activeConversions.set(conversionId, {
            status: 'running',
            logs: [],
            result: null,
            startedAt: Date.now()
        });

        const proc = spawn('bash', [SCANNER_SCRIPT, repoUrl.trim(), outputDir], {
            cwd: path.dirname(SCANNER_SCRIPT)
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            const conversion = activeConversions.get(conversionId);
            if (conversion) conversion.logs.push(text);
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', () => {
            const conversion = activeConversions.get(conversionId);
            if (conversion) {
                conversion.status = 'completed';
                conversion.completedAt = Date.now();
                conversion.result = parseScannerOutput(stdout, outputDir, { stripAnsi });
                // cobj usually produces compilable Java, but assume nothing —
                // the compile gate flips entries that javac actually rejects
                // to COMPILE_FAIL, with the real error attached.
                try {
                    runCompileGateOnReport(conversion.result);
                } catch (e) {
                    console.warn('Local-path compile-gate errored (non-fatal):', e.message);
                }
            }
            if (stderr) {
                // Preserved for debugging parity with the previous inline body.
                void stderr;
            }
        });

        res.json({ conversionId, outputDir });
    });
}

module.exports = { mount };
