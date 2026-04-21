/**
 * POST /api/scan-repo — pre-conversion file enumeration.
 *
 * Body: { repoUrl }  (URL → cloned shallow into /tmp; otherwise treated as a
 *                     local path)
 *
 * Walks the tree via azureAgent.scanForAllMainframeFiles and returns the file
 * list (cobol, copybook, jcl, data, other) plus counts, so the UI can present
 * a selection step. The caller then POSTs /api/convert-azure with a filtered
 * selectedFiles array.
 *
 * mount(app, deps) where deps = { azureAgent }.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { validateRepoUrl } = require('../util/validate-repo-url');

function mount(app, deps) {
    const { azureAgent } = deps;

    app.post('/api/scan-repo', async (req, res) => {
        const { repoUrl } = req.body || {};
        const check = validateRepoUrl(repoUrl);
        if (!check.ok) {
            return res.status(400).json({ error: check.error });
        }
        try {
            let inputPath = check.value;
            let cloned = false;
            if (check.kind === 'url') {
                const cloneDir = path.join(os.tmpdir(), `repo_scan_${Date.now()}`);
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
            res.json({ ok: true, inputPath, cloned, counts, files });
        } catch (err) {
            res.status(500).json({ error: 'Scan failed: ' + err.message });
        }
    });
}

module.exports = { mount };
