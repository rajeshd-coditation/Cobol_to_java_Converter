/**
 * Directory scanners for the conversion pipeline.
 *
 *   scanForCobolFiles(dir) → abs paths of .cbl/.cob/.cobol files
 *   scanForAllMainframeFiles(dir) → { cobolFiles, copybookFiles,
 *                                     jclFiles, dataFiles, otherFiles }
 *
 * Both walk recursively, skipping the obvious noise directories
 * (node_modules, .git, dist, build, target, .github, .vscode, .devcontainer).
 * Missing dirs or permission errors are logged and skipped rather than
 * fatal — conversions tolerate an unreadable subtree.
 *
 * Extension matching is case-sensitive against an allow-list for COBOL /
 * copybook / JCL / data files — cheaper and more predictable than
 * content sniffing, and mainframe repos are consistent about casing.
 * Anything that doesn't match a known category drops into `otherFiles`
 * so the MANUAL_REVIEW.md builder still sees it.
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS_COBOL = new Set(['node_modules', '.git', 'dist', 'build', 'target']);
const SKIP_DIRS_ALL = new Set([
    'node_modules', '.git', '.devcontainer', 'dist', 'build', 'target', '.github', '.vscode'
]);

const COBOL_EXTS    = ['.cbl', '.cob', '.cobol', '.CBL', '.COB', '.COBOL'];
const COPYBOOK_EXTS = ['.cpy', '.CPY', '.copy', '.COPY'];
const JCL_EXTS      = ['.jcl', '.JCL', '.proc', '.PROC'];
const DATA_EXTS     = ['.dat', '.DAT', '.txt', '.TXT', '.csv', '.CSV'];

function scanForCobolFiles(dirPath) {
    const cobolFiles = [];

    function scanDir(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS_COBOL.has(entry.name)) scanDir(fullPath);
                } else if (entry.isFile() && COBOL_EXTS.includes(path.extname(entry.name))) {
                    cobolFiles.push(fullPath);
                }
            }
        } catch (err) {
            console.error(`Error scanning ${currentPath}:`, err.message);
        }
    }

    scanDir(dirPath);
    return cobolFiles;
}

function scanForAllMainframeFiles(dirPath) {
    const result = {
        cobolFiles: [],
        copybookFiles: [],
        jclFiles: [],
        dataFiles: [],
        otherFiles: []
    };

    function scanDir(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS_ALL.has(entry.name)) scanDir(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (COBOL_EXTS.includes(ext))         result.cobolFiles.push(fullPath);
                    else if (COPYBOOK_EXTS.includes(ext)) result.copybookFiles.push(fullPath);
                    else if (JCL_EXTS.includes(ext))      result.jclFiles.push(fullPath);
                    else if (DATA_EXTS.includes(ext))     result.dataFiles.push(fullPath);
                    else                                  result.otherFiles.push(fullPath);
                }
            }
        } catch (err) {
            console.error(`Error scanning ${currentPath}:`, err.message);
        }
    }

    scanDir(dirPath);
    return result;
}

module.exports = { scanForCobolFiles, scanForAllMainframeFiles };
