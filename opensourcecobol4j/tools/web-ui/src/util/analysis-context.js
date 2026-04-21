/**
 * Build the repo-context payload consumed by analyzeConversionFailure.
 *
 * Parses CALL + COPY targets out of the COBOL source, then — if a matching
 * conversion exists — enriches with the real PROGRAM-ID → Java class mapping
 * and inlines copybook bodies so the failure analyst can cite repo state
 * instead of giving generic advice.
 *
 * Signature: `(conversionId, relativePath, cobolSource, deps) → context`
 * where `deps = { activeConversions, toPascalCase }`. Passed in to keep this
 * module free of server-level globals.
 */

const fs = require('fs');
const path = require('path');

function buildAnalysisContext(conversionId, relativePath, cobolSource, deps) {
    const { activeConversions, toPascalCase } = deps;
    const callRe = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
    const copyRe = /COPY\s+['"]?([A-Z0-9_-]+)['"]?/gi;
    const calledPrograms = [];
    const copybooks = [];
    const seenCalls = new Set();
    const seenCopy = new Set();
    let m;
    while ((m = callRe.exec(cobolSource)) !== null) {
        const n = m[1].toUpperCase();
        if (!seenCalls.has(n)) { seenCalls.add(n); calledPrograms.push(n); }
    }
    while ((m = copyRe.exec(cobolSource)) !== null) {
        const n = m[1].toUpperCase();
        if (!seenCopy.has(n)) { seenCopy.add(n); copybooks.push(n); }
    }

    const context = { calledPrograms, copybooks, programIdToJavaClass: {}, copybookBodies: {} };

    // If we can locate the conversion, enrich with real mappings.
    const conv = conversionId ? activeConversions.get(conversionId) : null;
    if (conv) {
        const gNodes = (conv.graph && conv.graph.nodes) || [];
        for (const n of gNodes) {
            if (n.type === 'program') {
                const base = path.basename(n.path || n.id, path.extname(n.path || n.id));
                context.programIdToJavaClass[base.toUpperCase()] = toPascalCase(base);
            }
            if (n.type === 'copybook' && n.path) {
                const stem = path.basename(n.path, path.extname(n.path)).toUpperCase();
                if (seenCopy.has(stem)) {
                    try { context.copybookBodies[stem] = fs.readFileSync(n.path, 'utf-8'); }
                    catch {}
                }
            }
        }
    }
    return context;
}

module.exports = { buildAnalysisContext };
