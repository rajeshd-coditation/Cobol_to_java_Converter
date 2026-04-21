/**
 * Accuracy / penalty guidance — shared UI helpers.
 *
 * Loaded BEFORE app.js via a <script> tag. Top-level declarations here
 * become globals (no ES module wrapper) which is how app.js reaches them.
 *
 * What this module owns:
 *   PENALTY_GUIDANCE       per-penalty "what to check" copy shown to
 *                          the reviewer. Keys MUST match exactly what the
 *                          server emits in accuracyBreakdown.semanticPenalties
 *                          (see src/core/accuracy-scorer.js) — if you rename
 *                          a penalty on the server, update the key here too.
 *   renderAccuracyPanel    injects the confidence-score pill + metrics row
 *                          + per-penalty guidance list above the Java
 *                          `<pre>` in the Results Browser and Code Comparison
 *                          modal. No-op when accuracy >= 100 (nothing to
 *                          review).
 *   buildAccuracyBanner    string form of the same breakdown, prepended
 *                          as Java `//` comments to exported / downloaded
 *                          Java files so the guidance survives outside the
 *                          web UI. Lines are word-wrapped to ~90 chars.
 *   getAccuracyClass /     CSS-class + bucket-name helpers used by the
 *   getAccuracyLevel       results-table row renderer.
 */

const PENALTY_GUIDANCE = {
    'File I/O simulated':       'Real file I/O was replaced with in-memory arrays. Verify SELECT/OPEN/READ/WRITE/CLOSE logic against your target file system (FileReader/FileWriter, BufferedReader, etc.).',
    'File I/O simplified':      'File handling was generated but may not use proper Java I/O classes. Check that file paths, encoding, and error handling match production needs.',
    'DEPENDING ON simplified':  'OCCURS DEPENDING ON (variable-length tables) may not use dynamic collections. Confirm ArrayList/List<> is used where COBOL had variable-length data.',
    'FILE STATUS simulated':    'COBOL FILE STATUS codes were not mapped to Java IOException/FileNotFoundException. Verify error handling around file operations.',
    'Packed decimal simplified':'COMP-3/COMP packed decimal should use BigDecimal for financial precision. Check arithmetic correctness (rounding, scale).',
    'Variable records approximated': 'RECORDING MODE V (variable-length records) is hard to replicate. Verify record serialization format matches source.',
    'Contains simulation markers': 'The Java code has comments marked "mock", "simulate", "placeholder", or "stub". Replace these with real implementations before production use.',
    'Fabricated input fallback': 'The Java silently substitutes hardcoded sample records when an input file is missing — COBOL would fail with status 35. Regenerate or hand-edit so the Java prints a file-not-found error and exits non-zero, matching COBOL behavior.',
    'CICS simplified':          'EXEC CICS commands (SEND/RECEIVE/LINK/XCTL) were simplified. You need a CICS runtime (JCICS) or equivalent transaction framework.',
    'IMS/DLI simplified':       'EXEC DLI / IMS database calls were simplified. You need an IMS framework (IMS Connect, etc.) or a relational equivalent.',
    'BMS adapted':              'BMS screen maps were adapted to console output. If you need a UI, replace with Swing/JavaFX or web frontend.',
    'CICS keys simplified':     'DFHAID (PF/Enter key) handling was simplified. Wire up real key events (KeyListener/ActionEvent) for a UI.',
};

function renderAccuracyPanel(paneEl, data) {
    if (!paneEl || data == null) return;
    const acc = data.accuracy;
    if (acc === null || acc === undefined || acc >= 100) return;

    const br = data.accuracyBreakdown || {};
    const cm = br.cobolMetrics || {};
    const jm = br.javaMetrics || {};
    const penalties = Array.isArray(br.semanticPenalties) ? br.semanticPenalties : [];

    const scoreClass = acc >= 85 ? 'good' : acc >= 65 ? 'warn' : 'poor';

    const panel = document.createElement('div');
    panel.className = 'accuracy-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Conversion accuracy breakdown');

    const header = document.createElement('div');
    header.className = 'accuracy-panel-header';
    header.innerHTML = `
        <span class="accuracy-panel-score ${scoreClass}">${acc}%</span>
        <span>Conversion confidence — review the items below</span>
    `;
    panel.appendChild(header);

    if (cm.codeLines || jm.codeLines) {
        const metrics = document.createElement('div');
        metrics.className = 'accuracy-panel-metrics';
        metrics.innerHTML = `
            <span>COBOL: <strong>${cm.codeLines || 0}</strong> lines - <strong>${cm.dataItems || 0}</strong> PIC - <strong>${cm.procedures || 0}</strong> procedures</span>
            <span>Java: <strong>${jm.codeLines || 0}</strong> lines - <strong>${jm.fields || 0}</strong> fields - <strong>${jm.methods || 0}</strong> methods</span>
        `;
        panel.appendChild(metrics);
    }

    if (penalties.length > 0) {
        const label = document.createElement('div');
        label.className = 'accuracy-panel-label';
        label.textContent = 'What lowered the score';
        panel.appendChild(label);

        const list = document.createElement('ul');
        list.className = 'accuracy-panel-penalties';
        for (const p of penalties) {
            const desc = PENALTY_GUIDANCE[p] || 'Manual inspection recommended.';
            const li = document.createElement('li');
            li.className = 'accuracy-panel-penalty';
            const title = document.createElement('span');
            title.className = 'pn-title';
            title.textContent = p;
            const d = document.createElement('span');
            d.className = 'pn-desc';
            d.textContent = desc;
            li.appendChild(title);
            li.appendChild(d);
            list.appendChild(li);
        }
        panel.appendChild(list);
    } else {
        // No named penalties — lower score usually means code-volume ratio.
        const note = document.createElement('div');
        note.className = 'accuracy-panel-metrics';
        note.innerHTML = '<span>No specific feature penalties. Lower score reflects code-volume or procedure-coverage ratios — verify all paragraphs and data items are represented.</span>';
        panel.appendChild(note);
    }

    // Insert BEFORE the <pre> holding the Java source so the panel appears
    // above the code.
    const pre = paneEl.querySelector('pre.browser-code');
    if (pre) paneEl.insertBefore(panel, pre);
    else paneEl.appendChild(panel);
}

function buildAccuracyBanner(data) {
    const acc = data.accuracy;
    if (acc === null || acc === undefined || acc >= 100) return '';

    const br = data.accuracyBreakdown || {};
    const cm = br.cobolMetrics || {};
    const jm = br.javaMetrics || {};
    const penalties = Array.isArray(br.semanticPenalties) ? br.semanticPenalties : [];

    let banner = '// ===============================================================\n';
    banner += `// Conversion confidence: ${acc}%   —   review the items below\n`;
    banner += '// ===============================================================\n';

    if (cm.codeLines || jm.codeLines) {
        banner += `// COBOL: ${cm.codeLines || 0} code lines, ${cm.dataItems || 0} PIC items, ${cm.procedures || 0} procedures\n`;
        banner += `// Java:  ${jm.codeLines || 0} code lines, ${jm.fields || 0} fields, ${jm.methods || 0} methods\n`;
    }

    if (penalties.length > 0) {
        banner += '//\n// What lowered the score — please verify manually:\n';
        for (const p of penalties) {
            const guidance = PENALTY_GUIDANCE[p] || 'Manual inspection recommended.';
            banner += `//   - ${p}\n`;
            // Word-wrap guidance to ~95 chars for readability in a Java file.
            const words = guidance.split(' ');
            let line = '//       ';
            for (const w of words) {
                if ((line.length + w.length + 1) > 95) {
                    banner += line + '\n';
                    line = '//       ' + w;
                } else {
                    line += (line.endsWith(' ') ? '' : ' ') + w;
                }
            }
            banner += line + '\n';
        }
    } else if (acc < 100) {
        // Score dropped without named penalties — usually code-volume ratio.
        banner += '//\n// No specific feature penalties — lower score reflects code-volume or\n';
        banner += '// procedure-coverage ratios. Compare the generated Java against the COBOL\n';
        banner += '// source side-by-side to confirm all paragraphs/data items are represented.\n';
    }

    banner += '// ===============================================================\n\n';
    return banner;
}

function getAccuracyClass(accuracy) {
    if (accuracy >= 75) return 'accuracy-high';
    if (accuracy >= 50) return 'accuracy-medium';
    return 'accuracy-low';
}

function getAccuracyLevel(accuracy) {
    if (accuracy >= 75) return 'high';
    if (accuracy >= 50) return 'medium';
    return 'low';
}
