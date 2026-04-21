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

// --- Extended dependency detection (§14) ----------------------------------
// EXEC SQL INCLUDE <name> — DB2 SQL copybook include. Semantics are identical
// to a COBOL COPY for graph purposes: pulls in shared DECLARE / SELECT / etc.
// Match the whole block loosely so the END-EXEC terminator doesn't trip us.
const SQL_INCLUDE_RE = /EXEC\s+SQL\s+INCLUDE\s+([A-Z0-9_-]+)\s+END-EXEC/gi;

// EXEC CICS LINK/XCTL PROGRAM('name') — CICS program-control transfers.
// LINK  = synchronous call (like CALL, but via CICS transaction services)
// XCTL  = transfer control (like CALL but caller never resumes)
// Both are graph-significant as "this program reaches that program at
// runtime" edges. Kept separate edge kinds so the UI can style them.
const CICS_LINK_RE = /EXEC\s+CICS\s+LINK\s+PROGRAM\s*\(\s*['"]?([A-Z0-9_-]+)['"]?\s*\)/gi;
const CICS_XCTL_RE = /EXEC\s+CICS\s+XCTL\s+PROGRAM\s*\(\s*['"]?([A-Z0-9_-]+)['"]?\s*\)/gi;

// EXEC CICS SEND MAP('MAP') MAPSET('MAPSET') — BMS screen map reference.
// Map names belong to mapsets (the physical bundle); the edge targets the
// mapset because that's what the BMS file ships as. Works even when
// only MAP() is present (MAPSET defaults to the current copy-list).
const CICS_SEND_MAP_RE = /EXEC\s+CICS\s+SEND\s+MAP\s*\(\s*['"]?([A-Z0-9_-]+)['"]?\s*\)\s*(?:MAPSET\s*\(\s*['"]?([A-Z0-9_-]+)['"]?\s*\))?/gi;

// IMS DLI:  CALL 'CBLTDLI' USING ..., <PCB-NAME>  — the PCB parameter IS the
// dependency (an IMS database/transaction pointer). Capture only the CALL
// wrapper here; the PCB-NAME is a bare identifier that we can't reliably
// resolve to a repo file (PCBs are declared in separate DBDs), so we emit
// a `missing-external` node for visibility.
const IMS_CALL_RE = /CALL\s+['"](?:CBLTDLI|AIBTDLI)['"]\s+USING\s+([^.]+?)\s*\.?/gi;

// Unresolved CALLs become `missing-external` nodes so the graph makes the
// "this program calls something outside the repo" boundary visible rather
// than silently dropping the edge.

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
        const calledTargets = []; // track so we can decide which CALL targets are external
        while ((m = CALL_RE.exec(content)) !== null) {
            const calleeName = m[1].toUpperCase();
            calledTargets.push(calleeName);
            const target = nameIndex[calleeName];
            if (target && target !== sourceId && !seen.has('l|' + target)) {
                graphEdges.push({ source: sourceId, target, kind: 'call' });
                seen.add('l|' + target);
            }
        }
        // Unresolved CALL targets — mark as missing-external so the graph
        // shows the "outside the repo" boundary instead of silently dropping
        // the edge. Common for enterprise COBOL that calls system utilities
        // (CEE3ABD, ILBOABN0, …) or programs that live in another library.
        // Skip the well-known IMS/DLI CALL wrappers — those are handled by
        // the IMS_CALL_RE block below as `ims` edges, not external programs.
        const IMS_WRAPPERS = new Set(['CBLTDLI', 'AIBTDLI', 'PLITDLI', 'ASMTDLI']);
        for (const calleeName of calledTargets) {
            if (nameIndex[calleeName]) continue;       // resolved
            if (IMS_WRAPPERS.has(calleeName)) continue; // handled below
            const extId = 'external:' + calleeName;
            if (!seen.has('xx|' + extId)) {
                if (!dataNodeById[extId]) {
                    graphNodes.push({
                        id: extId,
                        label: calleeName,
                        type: 'missing-external',
                        path: null,
                        reason: `CALL '${calleeName}' — target not in repo (system utility, external library, or unresolved sibling).`
                    });
                    fileStates[extId] = 'skipped';
                    dataNodeById[extId] = true;
                }
                graphEdges.push({ source: sourceId, target: extId, kind: 'call-external' });
                seen.add('xx|' + extId);
            }
        }

        // EXEC SQL INCLUDE — DB2 SQL copybook references.
        SQL_INCLUDE_RE.lastIndex = 0;
        while ((m = SQL_INCLUDE_RE.exec(content)) !== null) {
            const target = nameIndex[m[1].toUpperCase()];
            if (target && target !== sourceId && !seen.has('sqli|' + target)) {
                graphEdges.push({ source: sourceId, target, kind: 'sql-include' });
                seen.add('sqli|' + target);
            }
        }
        // EXEC CICS LINK / XCTL PROGRAM(…). Unresolved program names fall
        // through to a missing-external node (same pattern as CALL) so the
        // graph still shows the edge to a visible "outside the repo"
        // boundary instead of silently dropping it.
        const handleCicsTransfer = (re, kind, keyPrefix) => {
            re.lastIndex = 0;
            let mm;
            while ((mm = re.exec(content)) !== null) {
                const name = mm[1].toUpperCase();
                const key = keyPrefix + '|' + name;
                if (seen.has(key)) continue;
                const target = nameIndex[name];
                if (target && target !== sourceId) {
                    graphEdges.push({ source: sourceId, target, kind });
                } else if (!target) {
                    const extId = 'external:' + name;
                    if (!dataNodeById[extId]) {
                        graphNodes.push({
                            id: extId,
                            label: name,
                            type: 'missing-external',
                            path: null,
                            reason: `EXEC CICS ${kind === 'cics-link' ? 'LINK' : 'XCTL'} PROGRAM('${name}') — target not in repo.`
                        });
                        fileStates[extId] = 'skipped';
                        dataNodeById[extId] = true;
                    }
                    graphEdges.push({ source: sourceId, target: extId, kind });
                }
                seen.add(key);
            }
        };
        handleCicsTransfer(CICS_LINK_RE, 'cics-link', 'cl');
        handleCicsTransfer(CICS_XCTL_RE, 'cics-xctl', 'cx');
        // EXEC CICS SEND MAP(…) [MAPSET(…)] — BMS map / mapset dependency.
        // We emit a `bms-map` node for the mapset (or the map name as
        // fallback when MAPSET isn't specified) — these are almost never
        // in the repo as COBOL, so they render as external/unresolved.
        CICS_SEND_MAP_RE.lastIndex = 0;
        while ((m = CICS_SEND_MAP_RE.exec(content)) !== null) {
            const mapName = m[1].toUpperCase();
            const mapsetName = (m[2] || m[1]).toUpperCase();
            const existing = nameIndex[mapsetName];
            if (existing && !seen.has('bm|' + mapsetName)) {
                graphEdges.push({ source: sourceId, target: existing, kind: 'cics-map' });
                seen.add('bm|' + mapsetName);
            } else if (!existing) {
                const bmsId = 'bms:' + mapsetName;
                if (!dataNodeById[bmsId]) {
                    graphNodes.push({
                        id: bmsId,
                        label: mapsetName + (mapName !== mapsetName ? ` (${mapName})` : ''),
                        type: 'bms-map',
                        path: null,
                        reason: `BMS screen-map reference — EXEC CICS SEND MAP('${mapName}')`
                    });
                    fileStates[bmsId] = 'skipped';
                    dataNodeById[bmsId] = true;
                }
                if (!seen.has('bm|' + mapsetName)) {
                    graphEdges.push({ source: sourceId, target: bmsId, kind: 'cics-map' });
                    seen.add('bm|' + mapsetName);
                }
            }
        }
        // IMS DLI: CALL 'CBLTDLI' USING …, PCB-NAME. The PCB name is the
        // database/transaction pointer; lives in a DBD that doesn't survive
        // the scan, so we emit it as a missing-external `ims-pcb` node for
        // visibility rather than silently dropping the edge.
        IMS_CALL_RE.lastIndex = 0;
        while ((m = IMS_CALL_RE.exec(content)) !== null) {
            // USING clause may contain one or more identifiers — the PCB
            // is conventionally the last one (after the DLI function code
            // and the I/O area). Take the last identifier after splitting
            // on whitespace/commas.
            const usingClause = (m[1] || '').trim();
            const parts = usingClause.split(/[\s,]+/).filter(Boolean);
            const pcb = (parts[parts.length - 1] || '').toUpperCase();
            if (!pcb || !/^[A-Z][A-Z0-9_-]*$/.test(pcb)) continue;
            const pcbId = 'ims:' + pcb;
            const key = 'im|' + pcb;
            if (!seen.has(key)) {
                if (!dataNodeById[pcbId]) {
                    graphNodes.push({
                        id: pcbId,
                        label: pcb,
                        type: 'ims-pcb',
                        path: null,
                        reason: `IMS DLI call — PCB '${pcb}' (database/transaction pointer; declared in a DBD outside the repo).`
                    });
                    fileStates[pcbId] = 'skipped';
                    dataNodeById[pcbId] = true;
                }
                graphEdges.push({ source: sourceId, target: pcbId, kind: 'ims' });
                seen.add(key);
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
