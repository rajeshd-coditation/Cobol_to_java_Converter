/**
 * buildConversionGraph — assemble the dependency graph the Azure conversion
 * worker needs before it starts processing files.
 *
 * Called once per /api/convert-azure run, right after scanForAllMainframeFiles.
 * Produces the full node/edge graph plus three lookup tables the worker
 * threads through its per-file prompts:
 *
 *   graph.nodes / edges  — what the UI visualizes. Nodes: every COBOL
 *                          program, every copybook, every SELECT-matched
 *                          data file. Edges: COPY (copybook), CALL
 *                          (sibling program), data (SELECT ASSIGN match).
 *   fileStates           — id → 'pending' | 'active' | 'skipped' etc.
 *                          Seeded here; mutated by the worker.
 *   fileContents         — Map<absPath, source text>. Populated here so the
 *                          worker doesn't re-read the same source to detect
 *                          PROGRAM-ID, COPY targets, CALL targets.
 *   nameIndex            — UPPER(basename|PROGRAM-ID) → relpath id. CALL at
 *                          runtime resolves by PROGRAM-ID (not filename), so
 *                          indexing by both lets the graph reflect reality.
 *   dataFileLookup       — UPPER(DD/ASSIGN name) → absolute data file path.
 *                          Consumed by /api/run for staging, and by the AI
 *                          conversion prompt so the model emits real paths
 *                          instead of inventing filenames.
 *   jclContextByProgram  — UPPER(PROGRAM-ID) → [{ jclFile, stepName, dds }].
 *                          Lets the AI convert `SELECT FOO ASSIGN TO FOO`
 *                          into a Java file path pointing at the DD's real
 *                          DSN — instead of guessing "foo.txt".
 *
 * Why JCL-derived DD mapping in addition to the source parse? Real
 * enterprise COBOL doesn't hardcode filesystem paths in SELECT/ASSIGN —
 * it uses DD names that the JCL job maps to datasets (e.g.
 * `//ACCTREC DD DSN=&SYSUID..DATA`). Parsing the JCL and recording the
 * DD → dataset → repo-file chain is what lets `SELECT ACCTREC ASSIGN TO
 * ACCTREC` resolve correctly at run time without forcing the user to
 * hand-map the mainframe conventions.
 *
 * Pure function otherwise: no IO side effects beyond fs.readFileSync to
 * read sources, no mutation of the caller's arguments beyond the returned
 * objects.
 */

const fs = require('fs');
const path = require('path');

const PROGRAM_ID_RE = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
const COPY_RE = /COPY\s+['"]?([A-Z0-9_-]+)['"]?/gi;
const CALL_RE = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
const ASSIGN_RE = /SELECT\s+[\w-]+\s+ASSIGN\s+TO\s+(?:['"]([^'"]+)['"]|([A-Z0-9_-]+))/gi;
const SYNTHETIC_ASSIGN = /^(PRINTER|CONSOLE|RANDOM|DISK|TAPE|STDIN|STDOUT|DISPLAY)$/i;

function buildConversionGraph({ inputPath, cobolFiles, allFiles, parseJcl }) {
    const idOf = (p) => path.relative(inputPath, p);
    const graphNodes = [];
    const graphEdges = [];
    const fileStates = {};
    const nameIndex = {};

    // Nodes: programs + copybooks (data nodes added lazily when a SELECT matches).
    for (const p of cobolFiles) {
        const id = idOf(p);
        graphNodes.push({
            id, label: path.basename(p), type: 'program', path: p,
            reason: 'COBOL program (.cbl) — will be converted to Java'
        });
        fileStates[id] = 'pending';
        nameIndex[path.basename(p, path.extname(p)).toUpperCase()] = id;
    }
    for (const p of allFiles.copybookFiles) {
        const id = idOf(p);
        graphNodes.push({
            id, label: path.basename(p), type: 'copybook', path: p,
            reason: 'Copybook (.cpy) — included as a Java model when referenced by a converted program'
        });
        fileStates[id] = 'skipped';
        nameIndex[path.basename(p, path.extname(p)).toUpperCase()] = id;
    }

    // First pass: read sources once, cache, extract PROGRAM-ID.
    // CALL resolves by PROGRAM-ID at runtime, so index by that too.
    const fileContents = new Map();
    for (const p of cobolFiles) {
        let content = '';
        try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }
        fileContents.set(p, content);
        const m = content.match(PROGRAM_ID_RE);
        if (m) {
            const pid = m[1].toUpperCase();
            // Don't clobber an existing filename→id mapping with a different file's PROGRAM-ID.
            if (!nameIndex[pid]) nameIndex[pid] = idOf(p);
        }
    }

    // Data files the scanner found; we match SELECT-ASSIGN against these.
    const dataPool = allFiles.dataFiles.concat(allFiles.otherFiles).map(p => ({
        path: p,
        base: path.basename(p).toUpperCase(),
        stem: path.basename(p, path.extname(p)).toUpperCase()
    }));
    const dataNodeById = {};
    const dataFileLookup = {};

    for (const p of cobolFiles) {
        const content = fileContents.get(p);
        if (!content) continue;
        const sourceId = idOf(p);
        const seen = new Set();
        let m;

        COPY_RE.lastIndex = 0;
        while ((m = COPY_RE.exec(content)) !== null) {
            const target = nameIndex[m[1].toUpperCase()];
            if (target && target !== sourceId && !seen.has('c|' + target)) {
                graphEdges.push({ source: sourceId, target, kind: 'copy' });
                seen.add('c|' + target);
            }
        }
        CALL_RE.lastIndex = 0;
        while ((m = CALL_RE.exec(content)) !== null) {
            const target = nameIndex[m[1].toUpperCase()];
            if (target && target !== sourceId && !seen.has('l|' + target)) {
                graphEdges.push({ source: sourceId, target, kind: 'call' });
                seen.add('l|' + target);
            }
        }
        ASSIGN_RE.lastIndex = 0;
        while ((m = ASSIGN_RE.exec(content)) !== null) {
            const raw = (m[1] || m[2] || '').trim();
            if (!raw || SYNTHETIC_ASSIGN.test(raw)) continue;
            const expected = raw.toUpperCase();
            const hit = dataPool.find(e =>
                e.base === expected
                || e.stem === expected
                || e.base === expected + '.TXT'
                || e.base === expected + '.DAT'
            );
            if (!hit) continue;
            const dataId = idOf(hit.path);
            dataFileLookup[expected] = hit.path;
            if (!dataNodeById[dataId]) {
                graphNodes.push({
                    id: dataId,
                    label: path.basename(hit.path),
                    type: 'data',
                    path: hit.path,
                    reason: `Data file referenced via SELECT … ASSIGN TO '${raw}'`
                });
                fileStates[dataId] = 'skipped';
                dataNodeById[dataId] = true;
            }
            const edgeKey = 'd|' + sourceId + '->' + dataId;
            if (!seen.has(edgeKey)) {
                graphEdges.push({ source: sourceId, target: dataId, kind: 'data', via: raw });
                seen.add(edgeKey);
            }
        }
    }

    // JCL DD → dataset mapping. Adds to dataFileLookup so `SELECT FOO
    // ASSIGN TO FOO` resolves when FOO is the DD name in a JCL step
    // rather than an actual repo filename.
    const jclContextByProgram = {};
    const addJclInvocation = (pgm, jclFile, stepName, dds) => {
        const key = pgm.toUpperCase();
        (jclContextByProgram[key] = jclContextByProgram[key] || []).push({
            jclFile: path.relative(inputPath, jclFile),
            stepName,
            dds: dds.map(d => ({
                name: d.name,
                dsn:  d.dsn || null,
                disp: d.disp || null,
                sysout: !!d.sysout
            }))
        });
    };

    for (const jclPath of allFiles.jclFiles) {
        try {
            const jcl = fs.readFileSync(jclPath, 'utf-8');
            const parsed = parseJcl(jcl);
            if (!parsed) continue;
            for (const step of parsed.steps || []) {
                if (step.exec && step.exec.pgm) {
                    addJclInvocation(step.exec.pgm, jclPath, step.name, step.dds || []);
                }
                for (const dd of step.dds || []) {
                    if (!dd.name || !dd.dsn) continue;
                    // Mainframe DSNs often look like &SYSUID..DATA; drop the
                    // leading symbol, split on dot, take the last qualifier,
                    // and look for a repo file matching it.
                    const qual = dd.dsn
                        .replace(/^[&]?[A-Z0-9]+\./i, '')
                        .split('.')
                        .filter(Boolean)
                        .pop();
                    if (!qual) continue;
                    const candidates = dataPool.filter(e =>
                        e.base.startsWith(qual.toUpperCase())
                        || e.stem === qual.toUpperCase()
                    );
                    if (candidates.length > 0) {
                        const upperDD = dd.name.toUpperCase();
                        if (!dataFileLookup[upperDD]) {
                            dataFileLookup[upperDD] = candidates[0].path;
                        }
                    }
                }
            }
        } catch {}
    }

    return {
        graph: { nodes: graphNodes, edges: graphEdges },
        fileStates,
        fileContents,
        nameIndex,
        dataFileLookup,
        jclContextByProgram
    };
}

module.exports = { buildConversionGraph };
