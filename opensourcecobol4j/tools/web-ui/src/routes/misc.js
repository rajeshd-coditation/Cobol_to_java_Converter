/**
 * Small self-contained routes that don't belong to any larger feature:
 *
 *   GET  /api/samples       — bundled sample-repo list (for the "Load sample"
 *                             dropdown in the UI).
 *   GET  /api/file-content  — read any absolute path (used by the modal /
 *                             browser to load COBOL / Java source from disk).
 *                             TODO(§23.3 security): path-scope this to known
 *                             conversion outputDirs + inputPaths.
 *   GET  /api/ai/provider   — reports which AI backend is active + availability.
 *   GET  /api/dependencies  — parse a COBOL source for COPY / CALL targets.
 *                             Used by the deprecated "dependencies" pane; kept
 *                             for backwards compatibility until the pane is
 *                             removed.
 *
 * mount(app, deps) where deps = { AI_PROVIDER, aiAgent, azureAgent }.
 */

const fs = require('fs');
const path = require('path');

function mount(app, deps) {
    const { AI_PROVIDER, aiAgent, azureAgent } = deps;

    // GET /api/samples
    app.get('/api/samples', (req, res) => {
        const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
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

    // GET /api/file-content
    app.get('/api/file-content', (req, res) => {
        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: 'File path required' });
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            res.json({ content });
        } catch {
            res.status(404).json({ error: 'File not found' });
        }
    });

    // GET /api/ai/provider
    app.get('/api/ai/provider', (req, res) => {
        res.json({
            provider: AI_PROVIDER,
            openai: { available: aiAgent.isAvailable() },
            azure:  { available: azureAgent.isAvailable(), config: azureAgent.getConfig() }
        });
    });

    // GET /api/dependencies — extract COPY / CALL targets from a COBOL source.
    app.get('/api/dependencies', (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'File path required' });
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const dependencies = { copybooks: [], programCalls: [], hasRelationships: false };
            const copyRegex = /COPY\s+['"]?([A-Z0-9_-]+)['"]?\s*\.?/gi;
            let match;
            while ((match = copyRegex.exec(content)) !== null) {
                const name = match[1].toUpperCase();
                if (!dependencies.copybooks.includes(name)) dependencies.copybooks.push(name);
            }
            const callRegex = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
            while ((match = callRegex.exec(content)) !== null) {
                const name = match[1].toUpperCase();
                if (!dependencies.programCalls.includes(name)) dependencies.programCalls.push(name);
            }
            dependencies.hasRelationships = dependencies.copybooks.length > 0 || dependencies.programCalls.length > 0;
            res.json(dependencies);
        } catch {
            res.status(404).json({ error: 'File not found or could not be read' });
        }
    });
}

module.exports = { mount };
