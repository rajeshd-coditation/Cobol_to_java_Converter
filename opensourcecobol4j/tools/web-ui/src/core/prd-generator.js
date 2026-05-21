/**
 * PRD generation from collected business rule objects.
 *
 *   generatePRD(allBusinessRules, repoPath) → Markdown string
 *   generatePRDHtml(allBusinessRules, repoPath) → standalone HTML string
 *
 * Both are pure functions — they take an array of business-rule objects
 * (each produced by src/ai/business-rules.js::extractBusinessRules) and
 * return a string. Writing the output to disk is the caller's job.
 *
 * Mermaid helper functions are also exported so routes can call them
 * independently when building the UI's live diagram API.
 */

const path = require('path');

function mermaidSafe(text) {
    return (text || '')
        .replace(/"/g, "'")
        .replace(/[<>{}[\]|]/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .substring(0, 55);
}

function esc(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildMermaidFlowchart(rules) {
    const flow = rules.processFlow || [];
    if (flow.length === 0) return null;

    const steps = flow.map((s, i) => {
        if (typeof s === 'string') return { id: `S${i}`, step: s, type: 'process', rules: [] };
        return { id: `S${i}`, step: s.step || `Step ${i + 1}`, type: s.type || 'process', rules: s.rules || [] };
    });

    let chart = `flowchart TD\n`;
    chart += `    classDef startEnd fill:#6c3de8,stroke:#9b6cff,color:#fff,rx:20\n`;
    chart += `    classDef process fill:#1a1550,stroke:#6c3de8,color:#e0e0ff\n`;
    chart += `    classDef decision fill:#0d3b6e,stroke:#4a9eff,color:#e0f0ff\n`;
    chart += `    classDef io fill:#0a3d2e,stroke:#2ecc71,color:#d0ffe8\n`;

    steps.forEach(s => {
        const label = mermaidSafe(s.step);
        switch (s.type) {
            case 'start':
            case 'end':
                chart += `    ${s.id}(["${label}"]):::startEnd\n`; break;
            case 'decision':
                chart += `    ${s.id}{"${label}"}:::decision\n`; break;
            case 'io':
                chart += `    ${s.id}[/"${label}"/]:::io\n`; break;
            default:
                chart += `    ${s.id}["${label}"]:::process\n`;
        }
    });

    for (let i = 0; i < steps.length - 1; i++) {
        chart += `    ${steps[i].id} --> ${steps[i + 1].id}\n`;
    }

    return chart;
}

function buildKnowledgeGraph(allBusinessRules) {
    let chart = `graph LR\n`;
    chart += `    classDef program fill:#6c3de8,stroke:#9b6cff,color:#fff\n`;
    chart += `    classDef file fill:#0a3d2e,stroke:#2ecc71,color:#d0ffe8\n`;
    chart += `    classDef extern fill:#0d3b6e,stroke:#4a9eff,color:#e0f0ff\n`;

    const programNames = new Set(allBusinessRules.map(r => r.programName).filter(Boolean));
    const fileNodes = new Set();

    allBusinessRules.forEach(r => {
        if (!r || !r.programName) return;
        const pid = `P_${r.programName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        chart += `    ${pid}["${mermaidSafe(r.programName)}"]:::program\n`;
    });

    allBusinessRules.forEach(r => {
        if (!r || !r.programName) return;
        const pid = `P_${r.programName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        (r.externalDependencies || []).forEach(dep => {
            const did = `D_${dep.replace(/[^a-zA-Z0-9]/g, '_')}`;
            if (!fileNodes.has(did)) {
                fileNodes.add(did);
                const cls = programNames.has(dep) ? 'program' : 'file';
                const shape = cls === 'file' ? `[("${mermaidSafe(dep)}")]` : `["${mermaidSafe(dep)}"]`;
                chart += `    ${did}${shape}:::${cls}\n`;
            }
            chart += `    ${pid} --> ${did}\n`;
        });
    });

    return chart;
}

function generatePRD(allBusinessRules, repoPath) {
    const repoName = path.basename(repoPath || 'COBOL Application');
    const date = new Date().toISOString().split('T')[0];

    let md = `# Product Requirements Document\n`;
    md += `## Auto-Generated from COBOL Source Analysis\n\n`;
    md += `**Source:** ${repoName}  \n`;
    md += `**Generated:** ${date}  \n`;
    md += `**Programs Analyzed:** ${allBusinessRules.length}\n\n`;
    md += `---\n\n`;

    if (allBusinessRules.length > 0) {
        md += `## System Knowledge Graph\n\n`;
        md += `> Relationships between programs, files, and external dependencies\n\n`;
        md += `\`\`\`mermaid\n`;
        md += buildKnowledgeGraph(allBusinessRules);
        md += `\`\`\`\n\n---\n\n`;
    }

    const allDeps = new Set();
    allBusinessRules.forEach(r => (r.externalDependencies || []).forEach(d => allDeps.add(d)));

    if (allDeps.size > 0) {
        md += `## System Overview\n\n`;
        md += `### External Files & Programs Referenced\n\n`;
        [...allDeps].forEach(d => { md += `- ${d}\n`; });
        md += `\n---\n\n`;
    }

    md += `## Program-Level Business Rules\n\n`;

    for (const rules of allBusinessRules) {
        if (!rules) continue;
        md += `### ${rules.programName}\n\n`;
        if (rules.description) md += `**Description:** ${rules.description}\n\n`;

        if (rules.businessRules && rules.businessRules.length > 0) {
            md += `**Business Rules:**\n\n`;
            rules.businessRules.forEach((r, i) => { md += `${i + 1}. ${r}\n`; });
            md += `\n`;
        }

        if (rules.processFlow && rules.processFlow.length > 0) {
            const chart = buildMermaidFlowchart(rules);
            if (chart) {
                md += `**Process Flow Diagram:**\n\n`;
                md += `\`\`\`mermaid\n${chart}\`\`\`\n\n`;
            }
            const steps = rules.processFlow;
            const hasObjects = steps.length > 0 && typeof steps[0] === 'object';
            if (hasObjects) {
                md += `**Process Steps & Business Rules:**\n\n`;
                steps.forEach((s, i) => {
                    md += `${i + 1}. **${s.step}**`;
                    if (s.rules && s.rules.length > 0) {
                        s.rules.forEach(r => { md += `\n   - ${r}`; });
                    }
                    md += `\n`;
                });
                md += `\n`;
            }
        }

        if (rules.dataEntities && rules.dataEntities.length > 0) {
            md += `**Key Data Fields:**\n\n`;
            md += `| Field | PIC Clause | Description |\n`;
            md += `|-------|-----------|-------------|\n`;
            rules.dataEntities.slice(0, 20).forEach(e => {
                md += `| \`${e.name || ''}\` | ${e.picClause || ''} | ${e.description || ''} |\n`;
            });
            md += `\n`;
        }

        if (rules.coverage && rules.coverage.coverage && rules.coverage.coverage.length > 0) {
            const s = rules.coverage.summary || {};
            const total = s.total || rules.coverage.coverage.length;
            const covered = s.covered || 0;
            const partial = s.partial || 0;
            const missing = s.missing || 0;
            md += `**Business Rule Coverage:** ${covered}/${total} covered`;
            if (partial > 0) md += `, ${partial} partial`;
            if (missing > 0) md += `, ${missing} missing`;
            md += `\n\n`;
            md += `| # | Business Rule | COBOL | Java |\n`;
            md += `|---|--------------|-------|------|\n`;
            rules.coverage.coverage.forEach((c, i) => {
                const label = c.status === 'COVERED' ? 'Covered' : c.status === 'PARTIAL' ? 'Partial' : 'Missing';
                md += `| ${i + 1} | ${c.rule} | Yes | ${label}${c.note ? ` — ${c.note}` : ''} |\n`;
            });
            md += `\n`;
        }

        if (rules.externalDependencies && rules.externalDependencies.length > 0) {
            md += `**External Dependencies:** ${rules.externalDependencies.join(', ')}\n\n`;
        }

        md += `---\n\n`;
    }

    return md;
}

function generatePRDHtml(allBusinessRules, repoPath) {
    const repoName = path.basename(repoPath || 'COBOL Application');
    const date = new Date().toISOString().split('T')[0];
    const kgChart = buildKnowledgeGraph(allBusinessRules);
    const programs = allBusinessRules.filter(Boolean);

    const tocHtml = programs.map(r => {
        const anchor = (r.programName || '').replace(/[^a-zA-Z0-9]/g, '-');
        return `<li><a href="#prog-${anchor}">${esc(r.programName)}</a></li>`;
    }).join('\n');

    const sectionsHtml = programs.map(r => {
        if (!r) return '';
        const anchor = (r.programName || '').replace(/[^a-zA-Z0-9]/g, '-');

        const rulesHtml = (r.businessRules || []).length > 0
            ? `<h3>Business Rules</h3><ol class="rules-list">${r.businessRules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ol>`
            : '';

        let flowHtml = '';
        if (r.processFlow && r.processFlow.length > 0) {
            const chart = buildMermaidFlowchart(r);
            if (chart) {
                flowHtml += `<h3>Process Flow</h3>`;
                flowHtml += `<div class="mermaid-wrap"><pre class="mermaid">${esc(chart)}</pre></div>`;
            }
            const steps = r.processFlow;
            const hasObjects = steps.length > 0 && typeof steps[0] === 'object';
            const stepsWithRules = hasObjects ? steps.filter(s => s.rules && s.rules.length > 0) : [];
            if (stepsWithRules.length > 0) {
                flowHtml += `<h3>Step-Level Business Rules</h3><div class="step-rules">`;
                steps.forEach((s, i) => {
                    const stepRules = s.rules || [];
                    const typeBadge = s.type ? `<span class="badge badge-${s.type}">${s.type}</span>` : '';
                    flowHtml += `<div class="step-item">`;
                    flowHtml += `<div class="step-label">${typeBadge}<span class="step-num">${i + 1}.</span> ${esc(s.step)}</div>`;
                    if (stepRules.length > 0) {
                        flowHtml += `<ul class="step-rule-list">${stepRules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul>`;
                    }
                    flowHtml += `</div>`;
                });
                flowHtml += `</div>`;
            }
        }

        let dataHtml = '';
        if (r.dataEntities && r.dataEntities.length > 0) {
            dataHtml = `<h3>Key Data Fields</h3><table><thead><tr><th>Field</th><th>PIC Clause</th><th>Description</th></tr></thead><tbody>`;
            r.dataEntities.slice(0, 20).forEach(e => {
                dataHtml += `<tr><td><code>${esc(e.name || '')}</code></td><td>${esc(e.picClause || '')}</td><td>${esc(e.description || '')}</td></tr>`;
            });
            dataHtml += `</tbody></table>`;
        }

        let coverageHtml = '';
        if (r.coverage && r.coverage.coverage && r.coverage.coverage.length > 0) {
            const s = r.coverage.summary || {};
            const total = s.total || r.coverage.coverage.length;
            const covered = s.covered || 0;
            const partial = s.partial || 0;
            const missing = s.missing || 0;
            const pct = Math.round((covered + partial * 0.5) / total * 100);
            coverageHtml += `<h3>Business Rule Coverage</h3>`;
            coverageHtml += `<div class="coverage-summary">`;
            coverageHtml += `<div class="coverage-bar-wrap"><div class="coverage-bar" style="width:${pct}%"></div></div>`;
            coverageHtml += `<div class="coverage-stats">`;
            coverageHtml += `<span class="cov-pill covered">${covered} Covered</span>`;
            if (partial > 0) coverageHtml += `<span class="cov-pill partial">${partial} Partial</span>`;
            if (missing > 0) coverageHtml += `<span class="cov-pill missing">${missing} Missing</span>`;
            coverageHtml += `<span class="cov-total">${covered}/${total} rules fully implemented</span>`;
            coverageHtml += `</div></div>`;
            coverageHtml += `<table><thead><tr><th>#</th><th>Business Rule</th><th>COBOL</th><th>Java</th><th>Note</th></tr></thead><tbody>`;
            r.coverage.coverage.forEach((c, i) => {
                const cls = c.status === 'COVERED' ? 'covered' : c.status === 'PARTIAL' ? 'partial' : 'missing';
                const label = c.status === 'COVERED' ? 'Covered' : c.status === 'PARTIAL' ? 'Partial' : 'Missing';
                coverageHtml += `<tr><td>${i + 1}</td><td>${esc(c.rule)}</td>`;
                coverageHtml += `<td style="text-align:center;color:var(--green);font-size:0.78rem;font-weight:600;">Yes</td>`;
                coverageHtml += `<td><span class="cov-badge ${cls}">${label}</span></td>`;
                coverageHtml += `<td style="color:var(--text2);font-size:0.8rem">${esc(c.note || '')}</td></tr>`;
            });
            coverageHtml += `</tbody></table>`;
        }

        const depsHtml = (r.externalDependencies || []).length > 0
            ? `<h3>External Dependencies</h3><div class="tags">${r.externalDependencies.map(d => `<span class="tag">${esc(d)}</span>`).join('')}</div>`
            : '';

        return `
<section class="program-section" id="prog-${anchor}">
  <h2>${esc(r.programName)}</h2>
  ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
  ${rulesHtml}
  ${coverageHtml}
  ${flowHtml}
  ${dataHtml}
  ${depsHtml}
</section>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PRD — ${esc(repoName)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
  :root {
    --bg:#0a0818;--bg2:#130f2e;--card:#1a1550;
    --border:rgba(108,61,232,0.3);--border-light:rgba(255,255,255,0.08);
    --purple:#6c3de8;--purple-light:#9b6cff;
    --green:#2ecc71;--blue:#4a9eff;
    --text:#e0e0ff;--text2:#8888aa;--text3:#c0c0e0;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.65}
  a{color:var(--purple-light);text-decoration:none}
  a:hover{text-decoration:underline}
  .layout{display:flex;min-height:100vh}
  .sidebar{width:260px;min-width:220px;background:var(--bg2);border-right:1px solid var(--border-light);padding:28px 18px;position:sticky;top:0;height:100vh;overflow-y:auto;flex-shrink:0}
  .main{flex:1;padding:40px 48px;max-width:1000px}
  .sidebar-title{font-size:.72rem;font-weight:700;letter-spacing:.12em;color:var(--text2);text-transform:uppercase;margin-bottom:14px}
  .sidebar nav ul{list-style:none}
  .sidebar nav li{margin-bottom:6px}
  .sidebar nav a{font-size:.82rem;color:var(--text3);padding:3px 6px;border-radius:4px;display:block;transition:background .15s}
  .sidebar nav a:hover{background:rgba(108,61,232,.18);color:var(--text);text-decoration:none}
  .sidebar-sep{border:none;border-top:1px solid var(--border-light);margin:16px 0}
  .sidebar-meta{font-size:.75rem;color:var(--text2);line-height:1.8}
  .sidebar-logo{font-size:1rem;font-weight:700;color:var(--purple-light);margin-bottom:20px;letter-spacing:.04em}
  .report-header{margin-bottom:40px;padding-bottom:28px;border-bottom:1px solid var(--border)}
  .report-header h1{font-size:2rem;font-weight:700;color:var(--text);margin-bottom:6px}
  .report-header .subtitle{color:var(--text2);font-size:.9rem}
  .report-header .meta-row{display:flex;gap:24px;margin-top:14px;flex-wrap:wrap}
  .meta-pill{background:rgba(108,61,232,.15);border:1px solid var(--border);border-radius:20px;padding:4px 14px;font-size:.78rem;color:var(--purple-light)}
  .kg-section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;margin-bottom:36px}
  .kg-section h2{font-size:1.2rem;margin-bottom:6px;color:var(--text)}
  .kg-section .kg-hint{font-size:.8rem;color:var(--text2);margin-bottom:18px}
  .program-section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px 32px;margin-bottom:28px}
  .program-section h2{font-size:1.35rem;font-weight:700;color:var(--purple-light);border-bottom:1px solid var(--border-light);padding-bottom:10px;margin-bottom:14px}
  .program-section h3{font-size:.92rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin:22px 0 10px 0}
  .desc{color:var(--text3);font-size:.92rem;margin-bottom:8px;font-style:italic}
  .rules-list{padding-left:22px}
  .rules-list li{color:var(--text3);font-size:.88rem;margin-bottom:5px}
  .mermaid-wrap{background:rgba(0,0,0,.3);border-radius:8px;padding:18px;overflow-x:auto;margin-bottom:6px}
  .mermaid{font-size:13px}
  .step-rules{display:flex;flex-direction:column;gap:10px;margin-top:4px}
  .step-item{background:rgba(0,0,0,.2);border-left:3px solid var(--purple);border-radius:0 6px 6px 0;padding:10px 14px}
  .step-label{font-size:.87rem;font-weight:600;color:var(--text);margin-bottom:5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .step-num{color:var(--text2);min-width:20px}
  .step-rule-list{list-style:disc;padding-left:20px;margin-top:5px}
  .step-rule-list li{font-size:.82rem;color:var(--text2);margin-bottom:3px}
  .badge{font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:.06em}
  .badge-start,.badge-end{background:rgba(108,61,232,.3);color:var(--purple-light)}
  .badge-process{background:rgba(26,21,80,.8);color:#c0c0ff;border:1px solid rgba(108,61,232,.4)}
  .badge-decision{background:rgba(13,59,110,.6);color:var(--blue)}
  .badge-io{background:rgba(10,61,46,.6);color:var(--green)}
  table{width:100%;border-collapse:collapse;font-size:.83rem;margin-top:4px}
  th{background:rgba(108,61,232,.15);color:var(--purple-light);font-weight:600;text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}
  td{padding:8px 12px;border-bottom:1px solid var(--border-light);color:var(--text3);vertical-align:top}
  tr:last-child td{border-bottom:none}
  code{background:rgba(108,61,232,.2);padding:1px 5px;border-radius:3px;font-size:.82em;color:var(--purple-light)}
  .tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
  .tag{background:rgba(10,61,46,.5);border:1px solid rgba(46,204,113,.3);color:var(--green);border-radius:16px;padding:3px 12px;font-size:.78rem;font-family:monospace}
  .coverage-summary{margin-bottom:14px}
  .coverage-bar-wrap{height:8px;background:rgba(255,255,255,.08);border-radius:4px;margin-bottom:10px;overflow:hidden}
  .coverage-bar{height:100%;background:linear-gradient(90deg,#2ecc71,#6c3de8);border-radius:4px;transition:width .4s}
  .coverage-stats{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .cov-pill{font-size:.75rem;font-weight:700;padding:3px 10px;border-radius:12px}
  .cov-pill.covered{background:rgba(46,204,113,.2);color:var(--green);border:1px solid rgba(46,204,113,.35)}
  .cov-pill.partial{background:rgba(241,196,15,.15);color:#f1c40f;border:1px solid rgba(241,196,15,.3)}
  .cov-pill.missing{background:rgba(231,76,60,.15);color:#e74c3c;border:1px solid rgba(231,76,60,.3)}
  .cov-total{font-size:.78rem;color:var(--text2);margin-left:auto}
  .cov-badge{font-size:.75rem;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap}
  .cov-badge.covered{background:rgba(46,204,113,.2);color:var(--green)}
  .cov-badge.partial{background:rgba(241,196,15,.15);color:#f1c40f}
  .cov-badge.missing{background:rgba(231,76,60,.15);color:#e74c3c}
  @media print{.sidebar{display:none}.main{padding:20px}.program-section{break-inside:avoid}}
  @media(max-width:700px){.sidebar{display:none}.main{padding:20px 16px}}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-logo">Coditation</div>
    <div class="sidebar-title">Programs</div>
    <nav><ul>
      <li><a href="#kg-section">System Overview</a></li>
      ${tocHtml}
    </ul></nav>
    <hr class="sidebar-sep">
    <div class="sidebar-meta">
      <div><strong>Source:</strong> ${esc(repoName)}</div>
      <div><strong>Generated:</strong> ${date}</div>
      <div><strong>Programs:</strong> ${programs.length}</div>
    </div>
  </aside>
  <main class="main">
    <div class="report-header">
      <h1>Product Requirements Document</h1>
      <div class="subtitle">Auto-generated from COBOL source analysis</div>
      <div class="meta-row">
        <span class="meta-pill">Source: ${esc(repoName)}</span>
        <span class="meta-pill">Generated: ${date}</span>
        <span class="meta-pill">${programs.length} Programs Analyzed</span>
      </div>
    </div>
    <div class="kg-section" id="kg-section">
      <h2>System Knowledge Graph</h2>
      <p class="kg-hint">Relationships between programs, external files, and system dependencies</p>
      <div class="mermaid-wrap"><pre class="mermaid">${esc(kgChart)}</pre></div>
    </div>
    ${sectionsHtml}
  </main>
</div>
<script>
  mermaid.initialize({
    startOnLoad:true, theme:'dark',
    themeVariables:{
      primaryColor:'#6c3de8',primaryTextColor:'#e0e0ff',primaryBorderColor:'#9b6cff',
      lineColor:'#9b6cff',secondaryColor:'#1a1550',tertiaryColor:'#0d3b6e',
      background:'#0a0818',mainBkg:'#1a1550',nodeBorder:'#6c3de8',
      edgeLabelBackground:'#1a1550',titleColor:'#e0e0ff',
      fontFamily:'Segoe UI,system-ui,sans-serif'
    }
  });
</script>
</body>
</html>`;
}

module.exports = { mermaidSafe, esc, buildMermaidFlowchart, buildKnowledgeGraph, generatePRD, generatePRDHtml };
