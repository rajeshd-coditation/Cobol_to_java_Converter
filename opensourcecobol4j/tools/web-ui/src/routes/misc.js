/**
 * Small self-contained routes that don't belong to any larger feature:
 *
 *   GET  /api/samples       — bundled sample-repo list (for the "Load sample"
 *                             dropdown in the UI).
 *   GET  /api/file-content  — read a path that lives inside a known-safe
 *                             root (any active conversion's inputPath or
 *                             outputDir, plus the bundled sample roots).
 *                             Rejects paths that escape via `..`, symlinks,
 *                             or scheme tricks — see isPathAllowed() below.
 *   GET  /api/ai/provider   — reports which AI backend is active + availability.
 *   GET  /api/dependencies  — parse a COBOL source for COPY / CALL targets.
 *                             Used by the deprecated "dependencies" pane; kept
 *                             for backwards compatibility until the pane is
 *                             removed.
 *
 * mount(app, deps) where deps = { AI_PROVIDER, aiAgent, azureAgent,
 *                                 activeConversions }.
 */

const fs = require('fs');
const path = require('path');

// Paths readable by /api/file-content MUST start with one of these roots.
// inputPath / outputDir come from active conversions; sample roots are
// whatever /api/samples shipped with. We resolve through fs.realpathSync
// so symlinks can't let a path escape its declared root.
function buildAllowedRoots(activeConversions, samplePaths) {
    const roots = new Set();
    for (const p of samplePaths) {
        try { roots.add(fs.realpathSync(p)); } catch {}
    }
    for (const [, c] of activeConversions) {
        if (c && c.inputPath) {
            try { roots.add(fs.realpathSync(c.inputPath)); } catch {}
        }
        if (c && c.result && c.result.outputDir) {
            try { roots.add(fs.realpathSync(c.result.outputDir)); } catch {}
        }
    }
    return [...roots];
}

function isPathAllowed(candidate, allowedRoots) {
    // Realpath resolves `..` and symlinks to an absolute canonical path;
    // a straight string prefix check after realpath is sufficient and
    // avoids the usual path-traversal pitfalls.
    let resolved;
    try { resolved = fs.realpathSync(candidate); }
    catch { return false; }
    const sep = path.sep;
    return allowedRoots.some(root => resolved === root || resolved.startsWith(root + sep));
}

function mount(app, deps) {
    const { AI_PROVIDER, aiAgent, azureAgent, activeConversions } = deps;

    // Resolve sample paths once at mount time. /api/samples uses these
    // directly; /api/file-content treats them as permanent allowed roots
    // (sample browsing doesn't go through a conversion).
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const SAMPLES = [
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
    ];

    app.get('/api/samples', (req, res) => {
        res.json({ samples: SAMPLES.filter(s => fs.existsSync(s.path)) });
    });

    app.get('/api/file-content', (req, res) => {
        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: 'File path required' });
        }
        // Only absolute paths allowed. Relative paths have no meaning here
        // (frontend always sends absolute, server has no CWD contract with
        // the caller), and rejecting them up front is a cheap sanity check.
        if (!path.isAbsolute(filePath)) {
            return res.status(400).json({ error: 'Absolute path required' });
        }
        const allowedRoots = buildAllowedRoots(activeConversions, SAMPLES.map(s => s.path));
        if (!isPathAllowed(filePath, allowedRoots)) {
            // 403, not 404 — let the client distinguish "file missing" from
            // "server refuses to serve paths outside its known roots".
            return res.status(403).json({ error: 'Path outside allowed roots' });
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
