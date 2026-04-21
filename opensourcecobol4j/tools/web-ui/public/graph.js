/**
 * Live dependency graph for COBOL → Java conversion.
 * Renders the repo as a force-directed graph (Cytoscape.js + fcose) and
 * updates node states in real time as files move from pending → active → done.
 */
(function () {
    const STATE_CLASSES = ['pending', 'active', 'done', 'failed', 'skipped', 'awaiting_review'];

    let cy = null;
    let pollTimer = null;
    let currentId = null;
    let onNodeClick = null;
    let onStateUpdate = null;
    let _rawGraphData = null;
    let _latestFileStates = {};

    function destroy() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (cy) { cy.destroy(); cy = null; }
        currentId = null;
    }

    function buildElements(graph, fileStates) {
        const elements = [];
        for (const n of graph.nodes) {
            elements.push({
                group: 'nodes',
                data: { id: n.id, label: n.label, type: n.type, path: n.path, reason: n.reason || '' },
                classes: fileStates[n.id] || 'pending'
            });
        }
        for (const e of graph.edges) {
            elements.push({
                group: 'edges',
                data: {
                    id: `${e.source}__${e.target}__${e.kind}`,
                    source: e.source,
                    target: e.target,
                    kind: e.kind
                },
                classes: e.kind
            });
        }
        return elements;
    }

    function styleSheet() {
        return [
            {
                selector: 'node',
                style: {
                    'label': '',
                    'font-family': 'Space Grotesk, sans-serif',
                    'font-size': '10px',
                    'font-weight': 500,
                    'color': '#e8e6ff',
                    'text-valign': 'bottom',
                    'text-margin-y': 4,
                    'text-outline-color': '#0a0828',
                    'text-outline-width': 2,
                    'min-zoomed-font-size': 9,
                    'width': 28,
                    'height': 28,
                    'background-color': '#1a1550',
                    'border-color': '#3a3270',
                    'border-width': 2,
                    'transition-property': 'background-color, border-color, border-width, width, height',
                    'transition-duration': '300ms'
                }
            },
            {
                /* Show labels only when zoomed in OR for highlighted states */
                selector: 'node.show-label, node.active, node.awaiting_review, node.failed',
                style: { 'label': 'data(label)' }
            },
            {
                selector: 'node[type="copybook"]',
                style: {
                    'shape': 'round-rectangle',
                    'width': 28,
                    'height': 28
                }
            },
            {
                /* Data files (SELECT … ASSIGN TO targets) — distinct shape/colour */
                selector: 'node[type="data"]',
                style: {
                    'shape': 'cylinder',
                    'width': 30,
                    'height': 36,
                    'background-color': '#b45309',
                    'border-color': '#fde68a',
                    'border-width': 2
                }
            },
            {
                /* Data-dependency edges — dashed amber to distinguish from call/copy */
                selector: 'edge[kind="data"]',
                style: {
                    'line-color': '#b45309',
                    'target-arrow-color': '#b45309',
                    'line-style': 'dashed',
                    'width': 1.5
                }
            },
            /* §14 — extended dependency types. Each edge/node gets a
               distinct style so the orchestration/DB/CICS/IMS layers are
               visually separable on a real enterprise repo. */
            {
                selector: 'node[type="missing-external"]',
                style: {
                    'shape': 'diamond',
                    'width': 24, 'height': 24,
                    'background-color': '#6b7280',
                    'border-color': '#94a3b8',
                    'border-width': 1.5,
                    'border-style': 'dashed'
                }
            },
            {
                selector: 'edge[kind="call-external"]',
                style: {
                    /* Slightly lighter than the default so it still reads
                       against the dark canvas after 0.7 opacity. */
                    'line-color': '#94a3b8',
                    'target-arrow-color': '#94a3b8',
                    'line-style': 'dashed',
                    'width': 1.3,
                    'opacity': 0.8
                }
            },
            {
                selector: 'edge[kind="sql-include"]',
                style: {
                    'line-color': '#2563eb',
                    'target-arrow-color': '#2563eb',
                    'line-style': 'dotted',
                    'width': 1.5
                }
            },
            {
                selector: 'edge[kind="cics-link"], edge[kind="cics-xctl"]',
                style: {
                    'line-color': '#7c3aed',
                    'target-arrow-color': '#7c3aed',
                    'width': 2
                }
            },
            {
                selector: 'edge[kind="cics-xctl"]',
                style: {
                    /* XCTL = transfer of control, no return — draw thicker + taper to
                       signal "fire and forget". */
                    'line-style': 'dashed',
                    'arrow-scale': 1.3
                }
            },
            {
                selector: 'node[type="bms-map"]',
                style: {
                    'shape': 'rectangle',
                    'width': 30, 'height': 22,
                    'background-color': '#7c3aed',
                    'border-color': '#c4b5fd',
                    'border-width': 2
                }
            },
            {
                selector: 'edge[kind="cics-map"]',
                style: {
                    'line-color': '#7c3aed',
                    'target-arrow-color': '#7c3aed',
                    'line-style': 'dotted',
                    'width': 1.2
                }
            },
            {
                selector: 'node[type="ims-pcb"]',
                style: {
                    'shape': 'hexagon',
                    'width': 26, 'height': 26,
                    'background-color': '#0f766e',
                    'border-color': '#5eead4',
                    'border-width': 2
                }
            },
            {
                selector: 'edge[kind="ims"]',
                style: {
                    /* Brightened from #0f766e (teal-700) which was too dark
                       on the dark canvas. Teal-500 reads on both themes. */
                    'line-color': '#14b8a6',
                    'target-arrow-color': '#14b8a6',
                    'line-style': 'dashed',
                    'width': 1.5
                }
            },
            {
                selector: 'node.pending',
                style: {
                    'background-color': '#1a1550',
                    'border-color': '#3a3270',
                    'opacity': 0.75
                }
            },
            {
                selector: 'node.active',
                style: {
                    'background-color': '#7c5cff',
                    'border-color': '#b8a0ff',
                    'border-width': 4,
                    'width': 44,
                    'height': 44,
                    'shadow-blur': 24,
                    'shadow-color': '#7c5cff',
                    'shadow-opacity': 0.9,
                    'shadow-offset-x': 0,
                    'shadow-offset-y': 0,
                    'z-index': 10
                }
            },
            {
                selector: 'node.done',
                style: {
                    'background-color': '#22c55e',
                    'border-color': '#86efac',
                    'border-width': 2
                }
            },
            {
                selector: 'node.failed',
                style: {
                    'background-color': '#ef4444',
                    'border-color': '#fca5a5',
                    'border-width': 2
                }
            },
            {
                selector: 'node.awaiting_review',
                style: {
                    'background-color': '#f59e0b',
                    'border-color': '#fcd34d',
                    'border-width': 4,
                    'width': 44,
                    'height': 44,
                    'shadow-blur': 28,
                    'shadow-color': '#f59e0b',
                    'shadow-opacity': 0.95,
                    'shadow-offset-x': 0,
                    'shadow-offset-y': 0,
                    'z-index': 12
                }
            },
            {
                selector: 'node.skipped',
                style: {
                    'background-color': '#1a1550',
                    'border-color': '#5a5290',
                    'border-style': 'dashed',
                    'opacity': 0.55
                }
            },
            {
                selector: 'edge',
                style: {
                    'curve-style': 'bezier',
                    'width': 1.8,
                    // Baseline edge color picked so it reads on BOTH themes:
                    // light-purple gray stays visible on the dark #0a0828 canvas
                    // AND against the near-white light-theme canvas. The
                    // previous `#3a3270 @ 0.55 opacity` was effectively
                    // invisible on dark — user-reported 2026-04-21.
                    'line-color': '#8077c7',
                    'target-arrow-color': '#8077c7',
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 0.9,
                    'opacity': 0.75,
                    'transition-property': 'line-color, target-arrow-color, opacity, width',
                    'transition-duration': '300ms'
                }
            },
            {
                selector: 'edge.copy',
                style: { 'line-style': 'dashed' }
            },
            {
                selector: 'edge.lit-active',
                style: {
                    'line-color': '#7c5cff',
                    'target-arrow-color': '#b8a0ff',
                    'opacity': 1,
                    'width': 2.5
                }
            }
        ];
    }

    function applyStates(fileStates, currentFiles) {
        if (!cy) return;
        _latestFileStates = fileStates || {};
        const counts = { total: 0, pending: 0, active: 0, done: 0, failed: 0, skipped: 0, awaiting_review: 0 };
        cy.batch(() => {
            cy.nodes().forEach(node => {
                const id = node.id();
                const newState = fileStates[id] || 'pending';
                STATE_CLASSES.forEach(c => {
                    if (c === newState) node.addClass(c);
                    else node.removeClass(c);
                });
                counts.total++;
                if (counts[newState] !== undefined) counts[newState]++;
            });

            // Light up edges connecting active nodes to their dependencies.
            cy.edges().removeClass('lit-active');
            (currentFiles || []).forEach(activeId => {
                const node = cy.getElementById(activeId);
                if (node && node.length) {
                    node.connectedEdges().addClass('lit-active');
                }
            });
        });
        if (onStateUpdate) onStateUpdate(counts);
    }

    function setOverlay(message, kind) {
        const container = document.getElementById('graphCanvas');
        if (!container) return;
        container.classList.remove('empty');
        container.dataset.state = kind || '';
        container.dataset.message = message || '';
    }

    async function load(conversionId, options = {}) {
        currentId = conversionId;
        onNodeClick = options.onNodeClick || null;
        onStateUpdate = options.onStateUpdate || null;

        setOverlay('Scanning repository…', 'loading');

        // Wait for the backend to finish scanning and build the graph.
        let data;
        for (let attempt = 0; attempt < 60; attempt++) {
            if (currentId !== conversionId) return; // cancelled
            try {
                const r = await fetch(`/api/graph/${conversionId}?full=1`);
                data = await r.json();
                if (data.ready) break;
            } catch (err) {
                console.warn('graph fetch failed', err);
            }
            await new Promise(res => setTimeout(res, 600));
        }
        if (!data || !data.ready) {
            setOverlay('Could not load dependency graph', 'error');
            return;
        }

        const container = document.getElementById('graphCanvas');
        if (!container) return;
        container.classList.remove('empty');
        container.dataset.state = '';
        container.dataset.message = '';

        if (!data.graph || !data.graph.nodes || data.graph.nodes.length === 0) {
            setOverlay('No COBOL files found in this repository', 'empty');
            return;
        }
        // Stash raw graph for app.js to query for dependencies
        _rawGraphData = data.graph;

        if (cy) cy.destroy();

        const elements = buildElements(data.graph, data.fileStates || {});
        cy = cytoscape({
            container,
            elements,
            style: styleSheet(),
            layout: {
                name: 'fcose',
                animate: false,
                quality: 'proof',
                randomize: true,
                nodeRepulsion: 24000,
                idealEdgeLength: 140,
                edgeElasticity: 0.35,
                gravity: 0.10,
                gravityRange: 3.0,
                gravityCompound: 1.0,
                nodeSeparation: 120,
                packComponents: true,
                componentSpacing: 80,
                numIter: 3500,
                tile: true,
                padding: 60
            },
            wheelSensitivity: 0.2,
            minZoom: 0.15,
            maxZoom: 3
        });

        cy.on('tap', 'node', evt => {
            if (onNodeClick) onNodeClick(evt.target.data());
        });

        // Compact duration formatter — used only by the hover tooltip,
        // so it's local rather than imported from helpers.js (graph.js
        // loads before helpers.js in index.html).
        const formatDuration = (ms) => {
            if (!ms || ms < 0) return '';
            if (ms < 1000) return ms + 'ms';
            if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
            const m = Math.floor(ms / 60_000);
            const s = Math.round((ms % 60_000) / 1000);
            return `${m}m ${s}s`;
        };

        // Show labels on hover regardless of zoom + rationale tooltip.
        // Tooltip pulls from the richer per-file data when the parent page
        // has published it on window.cobolGraph.__fileData — that object
        // carries java_status, conversionAccuracy, timeline[last].ms, etc.
        // Falls back to the node's own data when the map isn't populated
        // (early in the conversion, or for non-program nodes).
        cy.on('mouseover', 'node', evt => {
            evt.target.addClass('show-label');
            const d = evt.target.data();
            const tip = document.getElementById('graphTooltip');
            if (tip) {
                const stateClass = STATE_CLASSES.find(c => evt.target.hasClass(c)) || 'pending';
                // Pick up file-level detail published by the main app.
                const extra = (window.cobolGraph && window.cobolGraph.__fileData && window.cobolGraph.__fileData[d.id]) || {};
                const duration = extra.durationMs ? formatDuration(extra.durationMs) : '';
                const accuracy = (typeof extra.accuracy === 'number') ? extra.accuracy + '%' : '';
                const errLine = extra.error
                    ? `<div class="tip-reason tip-error" style="color:#f87171;">${String(extra.error).slice(0, 180)}</div>`
                    : '';
                tip.innerHTML = `
                    <div class="tip-name">${d.label || d.id}</div>
                    <div class="tip-row"><span>Type</span><span>${d.type || ''}</span></div>
                    <div class="tip-row"><span>Status</span><span class="tip-state ${stateClass}">${stateClass.replace('_', ' ')}</span></div>
                    ${duration ? `<div class="tip-row"><span>Duration</span><span>${duration}</span></div>` : ''}
                    ${accuracy ? `<div class="tip-row"><span>Accuracy</span><span>${accuracy}</span></div>` : ''}
                    ${errLine}
                    ${d.reason ? `<div class="tip-reason">${d.reason}</div>` : ''}
                `;
                tip.classList.add('visible');
            }
        });
        cy.on('mouseout',  'node', evt => {
            evt.target.removeClass('show-label');
            const tip = document.getElementById('graphTooltip');
            if (tip) tip.classList.remove('visible');
        });

        // Safety: hide tooltip on click (modal may steal focus before mouseout fires)
        cy.on('tap', () => {
            const tip = document.getElementById('graphTooltip');
            if (tip) tip.classList.remove('visible');
        });

        // Safety: hide when mouse leaves the entire graph canvas
        const canvasEl = document.getElementById('graphCanvas');
        if (canvasEl) {
            canvasEl.addEventListener('mouseleave', () => {
                const tip = document.getElementById('graphTooltip');
                if (tip) tip.classList.remove('visible');
            });
        }
        cy.on('mousemove', 'node', evt => {
            const tip = document.getElementById('graphTooltip');
            if (!tip) return;
            const orig = evt.originalEvent;
            tip.style.left = (orig.pageX + 14) + 'px';
            tip.style.top  = (orig.pageY + 14) + 'px';
        });

        // Show all labels when zoomed in past a threshold
        cy.on('zoom', () => {
            const z = cy.zoom();
            if (z >= 0.9) cy.nodes().addClass('show-label');
            else cy.nodes().removeClass('show-label');
        });

        applyStates(data.fileStates || {}, data.currentFiles || []);
        startPolling();
    }

    function startPolling() {
        if (pollTimer) clearTimeout(pollTimer);
        const tick = async () => {
            if (!currentId) return;
            try {
                const r = await fetch(`/api/graph/${currentId}`);
                const data = await r.json();
                if (data.ready) {
                    applyStates(data.fileStates || {}, data.currentFiles || []);
                    if (data.tokens && window.updateTokenPanel) {
                        window.updateTokenPanel(data.tokens);
                    }
                    if (data.risks && window.updateRisksPanel) {
                        window.updateRisksPanel(data.risks);
                    }
                }
                if (data.status === 'completed') {
                    pollTimer = null;
                    if (window.onConversionComplete) {
                        try { window.onConversionComplete(); } catch {}
                    }
                    return;
                }
            } catch (err) { /* swallow */ }
            pollTimer = setTimeout(tick, 800);
        };
        pollTimer = setTimeout(tick, 800);
    }

    window.cobolGraph = {
        load, destroy, applyStates,
        get _cy() { return cy; },
        get rawGraph() { return _rawGraphData; },
        get fileStates() { return _latestFileStates; }
    };
})();
