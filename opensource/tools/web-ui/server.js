// Load environment variables
require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const aiAgent = require('./aiAgent');
const azureAgent = require('./azureAgent');

const app = express();
const PORT = 3000;

// Determine which AI provider to use
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Path to the scanner script
const SCANNER_SCRIPT = path.join(__dirname, '..', 'cobol_repo_scanner.sh');

// Helper function to convert to PascalCase for Java class names
function toPascalCase(str) {
    return str
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

// Store active conversions
const activeConversions = new Map();

// Sanitize text for Mermaid node labels
function mermaidSafe(text) {
    return (text || '')
        .replace(/"/g, "'")
        .replace(/[<>{}[\]|]/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .substring(0, 55);
}

// Build a Mermaid flowchart from a program's processFlow array
function buildMermaidFlowchart(rules) {
    const flow = rules.processFlow || [];
    if (flow.length === 0) return null;

    // Normalize: support both old string[] and new object[] format
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

    // Connect sequentially
    for (let i = 0; i < steps.length - 1; i++) {
        chart += `    ${steps[i].id} --> ${steps[i + 1].id}\n`;
    }

    return chart;
}

// Build a Mermaid knowledge graph for the whole system
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

// Generate a Markdown PRD from an array of business rule objects
function generatePRD(allBusinessRules, repoPath) {
    const repoName = path.basename(repoPath || 'COBOL Application');
    const date = new Date().toISOString().split('T')[0];

    let md = `# Product Requirements Document\n`;
    md += `## Auto-Generated from COBOL Source Analysis\n\n`;
    md += `**Source:** ${repoName}  \n`;
    md += `**Generated:** ${date}  \n`;
    md += `**Programs Analyzed:** ${allBusinessRules.length}\n\n`;
    md += `---\n\n`;

    // System-level knowledge graph
    if (allBusinessRules.length > 0) {
        md += `## System Knowledge Graph\n\n`;
        md += `> Relationships between programs, files, and external dependencies\n\n`;
        md += `\`\`\`mermaid\n`;
        md += buildKnowledgeGraph(allBusinessRules);
        md += `\`\`\`\n\n---\n\n`;
    }

    // Collect all unique external dependencies for system overview
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

        // Process flow as Mermaid diagram
        if (rules.processFlow && rules.processFlow.length > 0) {
            const chart = buildMermaidFlowchart(rules);
            if (chart) {
                md += `**Process Flow Diagram:**\n\n`;
                md += `\`\`\`mermaid\n${chart}\`\`\`\n\n`;
            }

            // Also list steps with their per-step business rules
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

        if (rules.externalDependencies && rules.externalDependencies.length > 0) {
            md += `**External Dependencies:** ${rules.externalDependencies.join(', ')}\n\n`;
        }

        md += `---\n\n`;
    }

    return md;
}

// Escape HTML special characters
function esc(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Generate a self-contained HTML PRD report
function generatePRDHtml(allBusinessRules, repoPath) {
    const repoName = path.basename(repoPath || 'COBOL Application');
    const date = new Date().toISOString().split('T')[0];

    const kgChart = buildKnowledgeGraph(allBusinessRules);

    // Build TOC entries
    const programs = allBusinessRules.filter(Boolean);
    const tocHtml = programs.map(r => {
        const anchor = (r.programName || '').replace(/[^a-zA-Z0-9]/g, '-');
        return `<li><a href="#prog-${anchor}">${esc(r.programName)}</a></li>`;
    }).join('\n');

    // Build program sections
    const sectionsHtml = programs.map(r => {
        if (!r) return '';
        const anchor = (r.programName || '').replace(/[^a-zA-Z0-9]/g, '-');

        // Business rules list
        const rulesHtml = (r.businessRules || []).length > 0
            ? `<h3>Business Rules</h3><ol class="rules-list">${r.businessRules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ol>`
            : '';

        // Process flow diagram + per-step rules
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

        // Data entities table
        let dataHtml = '';
        if (r.dataEntities && r.dataEntities.length > 0) {
            dataHtml = `<h3>Key Data Fields</h3><table><thead><tr><th>Field</th><th>PIC Clause</th><th>Description</th></tr></thead><tbody>`;
            r.dataEntities.slice(0, 20).forEach(e => {
                dataHtml += `<tr><td><code>${esc(e.name || '')}</code></td><td>${esc(e.picClause || '')}</td><td>${esc(e.description || '')}</td></tr>`;
            });
            dataHtml += `</tbody></table>`;
        }

        // External dependencies
        const depsHtml = (r.externalDependencies || []).length > 0
            ? `<h3>External Dependencies</h3><div class="tags">${r.externalDependencies.map(d => `<span class="tag">${esc(d)}</span>`).join('')}</div>`
            : '';

        return `
<section class="program-section" id="prog-${anchor}">
  <h2>${esc(r.programName)}</h2>
  ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
  ${rulesHtml}
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
    --bg: #0a0818; --bg2: #130f2e; --card: #1a1550;
    --border: rgba(108,61,232,0.3); --border-light: rgba(255,255,255,0.08);
    --purple: #6c3de8; --purple-light: #9b6cff;
    --green: #2ecc71; --blue: #4a9eff;
    --text: #e0e0ff; --text2: #8888aa; --text3: #c0c0e0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 15px; line-height: 1.65; }
  a { color: var(--purple-light); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  .layout { display: flex; min-height: 100vh; }
  .sidebar { width: 260px; min-width: 220px; background: var(--bg2); border-right: 1px solid var(--border-light); padding: 28px 18px; position: sticky; top: 0; height: 100vh; overflow-y: auto; flex-shrink: 0; }
  .main { flex: 1; padding: 40px 48px; max-width: 1000px; }

  /* Sidebar */
  .sidebar-title { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; color: var(--text2); text-transform: uppercase; margin-bottom: 14px; }
  .sidebar nav ul { list-style: none; }
  .sidebar nav li { margin-bottom: 6px; }
  .sidebar nav a { font-size: 0.82rem; color: var(--text3); padding: 3px 6px; border-radius: 4px; display: block; transition: background 0.15s; }
  .sidebar nav a:hover { background: rgba(108,61,232,0.18); color: var(--text); text-decoration: none; }
  .sidebar-sep { border: none; border-top: 1px solid var(--border-light); margin: 16px 0; }
  .sidebar-meta { font-size: 0.75rem; color: var(--text2); line-height: 1.8; }
  .sidebar-logo { font-size: 1rem; font-weight: 700; color: var(--purple-light); margin-bottom: 20px; letter-spacing: 0.04em; }

  /* Header */
  .report-header { margin-bottom: 40px; padding-bottom: 28px; border-bottom: 1px solid var(--border); }
  .report-header h1 { font-size: 2rem; font-weight: 700; color: var(--text); margin-bottom: 6px; }
  .report-header .subtitle { color: var(--text2); font-size: 0.9rem; }
  .report-header .meta-row { display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap; }
  .meta-pill { background: rgba(108,61,232,0.15); border: 1px solid var(--border); border-radius: 20px; padding: 4px 14px; font-size: 0.78rem; color: var(--purple-light); }

  /* Knowledge graph section */
  .kg-section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; margin-bottom: 36px; }
  .kg-section h2 { font-size: 1.2rem; margin-bottom: 6px; color: var(--text); }
  .kg-section .kg-hint { font-size: 0.8rem; color: var(--text2); margin-bottom: 18px; }

  /* Program sections */
  .program-section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px 32px; margin-bottom: 28px; }
  .program-section h2 { font-size: 1.35rem; font-weight: 700; color: var(--purple-light); border-bottom: 1px solid var(--border-light); padding-bottom: 10px; margin-bottom: 14px; }
  .program-section h3 { font-size: 0.92rem; font-weight: 600; color: var(--text2); text-transform: uppercase; letter-spacing: 0.08em; margin: 22px 0 10px 0; }
  .desc { color: var(--text3); font-size: 0.92rem; margin-bottom: 8px; font-style: italic; }

  /* Rules */
  .rules-list { padding-left: 22px; }
  .rules-list li { color: var(--text3); font-size: 0.88rem; margin-bottom: 5px; }

  /* Mermaid */
  .mermaid-wrap { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 18px; overflow-x: auto; margin-bottom: 6px; }
  .mermaid { font-size: 13px; }

  /* Step rules */
  .step-rules { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
  .step-item { background: rgba(0,0,0,0.2); border-left: 3px solid var(--purple); border-radius: 0 6px 6px 0; padding: 10px 14px; }
  .step-label { font-size: 0.87rem; font-weight: 600; color: var(--text); margin-bottom: 5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .step-num { color: var(--text2); min-width: 20px; }
  .step-rule-list { list-style: disc; padding-left: 20px; margin-top: 5px; }
  .step-rule-list li { font-size: 0.82rem; color: var(--text2); margin-bottom: 3px; }

  /* Badges */
  .badge { font-size: 0.68rem; font-weight: 700; padding: 2px 7px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .badge-start, .badge-end { background: rgba(108,61,232,0.3); color: var(--purple-light); }
  .badge-process { background: rgba(26,21,80,0.8); color: #c0c0ff; border: 1px solid rgba(108,61,232,0.4); }
  .badge-decision { background: rgba(13,59,110,0.6); color: var(--blue); }
  .badge-io { background: rgba(10,61,46,0.6); color: var(--green); }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; margin-top: 4px; }
  th { background: rgba(108,61,232,0.15); color: var(--purple-light); font-weight: 600; text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border-light); color: var(--text3); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(108,61,232,0.2); padding: 1px 5px; border-radius: 3px; font-size: 0.82em; color: var(--purple-light); }

  /* Tags */
  .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .tag { background: rgba(10,61,46,0.5); border: 1px solid rgba(46,204,113,0.3); color: var(--green); border-radius: 16px; padding: 3px 12px; font-size: 0.78rem; font-family: monospace; }

  /* Print */
  @media print {
    .sidebar { display: none; }
    .main { padding: 20px; }
    .program-section { break-inside: avoid; }
  }
  @media (max-width: 700px) {
    .sidebar { display: none; }
    .main { padding: 20px 16px; }
  }
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
    startOnLoad: true,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#6c3de8', primaryTextColor: '#e0e0ff', primaryBorderColor: '#9b6cff',
      lineColor: '#9b6cff', secondaryColor: '#1a1550', tertiaryColor: '#0d3b6e',
      background: '#0a0818', mainBkg: '#1a1550', nodeBorder: '#6c3de8',
      edgeLabelBackground: '#1a1550', titleColor: '#e0e0ff',
      fontFamily: 'Segoe UI, system-ui, sans-serif'
    }
  });
</script>
</body>
</html>`;
}

// API: Start conversion
app.post('/api/convert', async (req, res) => {
    const { repoUrl } = req.body;

    if (!repoUrl || repoUrl.trim() === '') {
        return res.status(400).json({ error: 'Repository URL or path is required' });
    }

    const conversionId = Date.now().toString();
    const outputDir = path.join(os.tmpdir(), `cobol_output_${conversionId}`);

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Initialize conversion status
    activeConversions.set(conversionId, {
        status: 'running',
        logs: [],
        result: null
    });

    // Run the scanner script
    const process = spawn('bash', [SCANNER_SCRIPT, repoUrl.trim(), outputDir], {
        cwd: path.dirname(SCANNER_SCRIPT)
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        const conversion = activeConversions.get(conversionId);
        if (conversion) {
            conversion.logs.push(text);
        }
    });

    process.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    process.on('close', (code) => {
        const conversion = activeConversions.get(conversionId);
        if (conversion) {
            conversion.status = 'completed';
            conversion.result = parseOutput(stdout, outputDir);
        }
    });

    res.json({ conversionId, outputDir });
});

// API: Start conversion using Azure AI Agent
app.post('/api/convert-azure', async (req, res) => {
    const { repoUrl } = req.body;

    if (!repoUrl || repoUrl.trim() === '') {
        return res.status(400).json({ error: 'Repository URL or path is required' });
    }

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    const conversionId = Date.now().toString();
    const outputDir = path.join(os.tmpdir(), `azure_cobol_output_${conversionId}`);
    const javaDir = path.join(outputDir, 'java');

    // Create output directories
    fs.mkdirSync(javaDir, { recursive: true });

    // Initialize conversion status
    activeConversions.set(conversionId, {
        status: 'running',
        logs: ['🤖 Starting Azure AI conversion...\n'],
        result: null,
        useAzureAI: true
    });

    // Process in background
    (async () => {
        const conversion = activeConversions.get(conversionId);
        const results = {
            outputDir,
            totalFiles: 0,
            converted: 0,
            skippedCopybook: 0,
            skippedNoId: 0,
            skippedError: 0,
            failCompile: 0,
            failExec: 0,
            otherFilesCount: 0,  // JCL, data files, etc. (not COBOL - doesn't affect success rate)
            convertedFiles: [],
            skippedFiles: [],
            errorFiles: [],
            businessRulesData: [],
            report: { files: [], summary: {} }
        };

        try {
            // Determine input path
            let inputPath = repoUrl.trim();

            // If it's a git URL, clone it first
            if (inputPath.startsWith('http') || inputPath.startsWith('git@')) {
                conversion.logs.push('📥 Cloning repository...\n');
                const cloneDir = path.join(os.tmpdir(), `repo_${conversionId}`);
                const { execSync } = require('child_process');
                try {
                    execSync(`git clone --depth 1 "${inputPath}" "${cloneDir}"`, { timeout: 60000 });
                    inputPath = cloneDir;
                    conversion.logs.push('✅ Repository cloned successfully\n');
                } catch (cloneErr) {
                    conversion.logs.push(`❌ Failed to clone repository: ${cloneErr.message}\n`);
                    conversion.status = 'completed';
                    conversion.result = results;
                    return;
                }
            }

            if (!fs.existsSync(inputPath)) {
                conversion.logs.push(`❌ Path not found: ${inputPath}\n`);
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }

            // Scan for ALL mainframe files (COBOL, Copybooks, JCL, data, etc.)
            conversion.logs.push('🔍 Scanning for mainframe files...\n');
            const allFiles = azureAgent.scanForAllMainframeFiles(inputPath);
            const cobolFiles = allFiles.cobolFiles;

            // Calculate totals
            const totalMainframeFiles = cobolFiles.length +
                allFiles.copybookFiles.length +
                allFiles.jclFiles.length +
                allFiles.dataFiles.length +
                allFiles.otherFiles.length;

            results.totalFiles = cobolFiles.length;

            // Log file breakdown
            conversion.logs.push(`📁 Found ${totalMainframeFiles} mainframe-related files:\n`);
            conversion.logs.push(`   • COBOL programs: ${cobolFiles.length} (will be converted)\n`);
            if (allFiles.copybookFiles.length > 0) {
                conversion.logs.push(`   • Copybooks (.cpy): ${allFiles.copybookFiles.length} (skipped)\n`);
            }
            if (allFiles.jclFiles.length > 0) {
                conversion.logs.push(`   • JCL files: ${allFiles.jclFiles.length} (skipped)\n`);
            }
            if (allFiles.dataFiles.length > 0) {
                conversion.logs.push(`   • Data files: ${allFiles.dataFiles.length} (skipped)\n`);
            }
            if (allFiles.otherFiles.length > 0) {
                conversion.logs.push(`   • Other files: ${allFiles.otherFiles.length} (skipped)\n`);
            }
            conversion.logs.push('\n');

            // Add other files to skipped list with category labels
            // Note: Only copybooks count towards skippedCopybook (affects success rate)
            // JCL, data, and other files go to otherFilesCount (doesn't affect success rate)
            for (const filePath of allFiles.copybookFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Copybook`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_COPYBOOK'
                });
            }
            results.skippedCopybook = allFiles.copybookFiles.length;

            // JCL files - tracked separately, don't affect COBOL success rate
            for (const filePath of allFiles.jclFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - JCL`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_JCL'
                });
            }
            results.otherFilesCount += allFiles.jclFiles.length;

            // Data files - tracked separately
            for (const filePath of allFiles.dataFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Data File`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_DATA'
                });
            }
            results.otherFilesCount += allFiles.dataFiles.length;

            // Other files - tracked separately
            for (const filePath of allFiles.otherFiles) {
                const relativePath = path.relative(inputPath, filePath);
                results.skippedFiles.push(`${relativePath} - Other`);
                results.report.files.push({
                    path: relativePath,
                    source_path: filePath,
                    java_status: 'SKIPPED_OTHER'
                });
            }
            results.otherFilesCount += allFiles.otherFiles.length;

            if (cobolFiles.length === 0) {
                conversion.logs.push('⚠️ No COBOL files found in the repository\n');
                conversion.status = 'completed';
                conversion.result = results;
                return;
            }


            // Parallel processing configuration
            const BATCH_SIZE = 5; // Process 5 files concurrently

            // Helper function to process a single file
            async function processFile(cobolPath, index, total, inputPath) {
                const relativePath = path.relative(inputPath, cobolPath);
                const baseName = path.basename(cobolPath, path.extname(cobolPath));

                const fileResult = {
                    relativePath,
                    baseName,
                    cobolPath,
                    status: null,
                    reportEntry: null
                };

                try {
                    const cobolSource = fs.readFileSync(cobolPath, 'utf-8');

                    // Skip if it looks like a copybook (no PROGRAM-ID)
                    if (!cobolSource.match(/PROGRAM-ID/i)) {
                        fileResult.status = 'skipped_noid';
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_NO_ID'
                        };
                        return fileResult;
                    }

                    // Skip if file is too small
                    if (cobolSource.trim().length < 50) {
                        fileResult.status = 'skipped_small';
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'SKIPPED_NO_ID'
                        };
                        return fileResult;
                    }

                    // Convert to Java and extract business rules in parallel
                    const [conversionResult, businessRulesResult] = await Promise.all([
                        azureAgent.convertCobolToJava(cobolSource),
                        azureAgent.extractBusinessRules(cobolSource, baseName)
                    ]);
                    fileResult.businessRules = businessRulesResult;

                    if (conversionResult.success) {
                        // Create work directory for this file (for UI buttons)
                        const workDir = path.join(outputDir, 'work', baseName);
                        fs.mkdirSync(workDir, { recursive: true });

                        // Get the correct class name (PascalCase)
                        const javaClassName = toPascalCase(baseName);
                        const javaFileName = javaClassName + '.java';
                        const javaPath = path.join(javaDir, javaFileName);

                        // Fix ALL class name references in the generated Java code
                        let fixedJavaCode = conversionResult.javaCode;

                        // FIRST: Detect the actual class name the AI generated
                        // This handles cases where AI uses a completely different name (e.g., CardAuthorizationProgram instead of COPAUA0C)
                        const classNameMatch = fixedJavaCode.match(/public\s+class\s+(\w+)\s*\{/);
                        const aiGeneratedClassName = classNameMatch ? classNameMatch[1] : null;

                        // If AI used a different class name, replace it with the correct one
                        if (aiGeneratedClassName && aiGeneratedClassName !== javaClassName) {
                            console.log(`   🔧 Fixing class name: ${aiGeneratedClassName} → ${javaClassName}`);

                            // Replace class declaration
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'),
                                `$1${javaClassName}$2`
                            );
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace constructor declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace new ClassName() instantiations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(new\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'),
                                `$1${javaClassName}$2`
                            );

                            // Replace variable type declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s,\\(])${aiGeneratedClassName}(\\s+\\w+\\s*[=;,\\)])`, 'gm'),
                                `$1${javaClassName}$2`
                            );

                            // Replace static method calls
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s\\(])${aiGeneratedClassName}(\\.\\w+)`, 'gm'),
                                `$1${javaClassName}$2`
                            );
                        }

                        // ALSO: Create patterns for all case variants of the base name (fallback)
                        const variants = [
                            baseName,                    // Original: CBPAUP0C
                            baseName.toLowerCase(),      // Lowercase: cbpaup0c
                            baseName.toUpperCase(),      // Uppercase: CBPAUP0C
                        ];

                        // Replace ALL occurrences of any variant with the correct PascalCase name
                        for (const variant of variants) {
                            // Replace class declaration
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+class\\s+)${variant}(\\s*\\{)`, 'gi'),
                                `$1${javaClassName}$2`
                            );
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(class\\s+)${variant}(\\s*\\{)`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace constructor declarations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(public\\s+)${variant}(\\s*\\()`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace new ClassName() instantiations
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(new\\s+)${variant}(\\s*\\()`, 'gi'),
                                `$1${javaClassName}$2`
                            );

                            // Replace variable type declarations (ClassName varName)
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s,\\(])${variant}(\\s+\\w+\\s*[=;,\\)])`, 'gim'),
                                `$1${javaClassName}$2`
                            );

                            // Replace static method calls (ClassName.method)
                            fixedJavaCode = fixedJavaCode.replace(
                                new RegExp(`(^|[\\s\\(])${variant}(\\.\\w+)`, 'gim'),
                                `$1${javaClassName}$2`
                            );
                        }

                        fs.writeFileSync(javaPath, fixedJavaCode);

                        // Also save to work dir for UI access
                        fs.writeFileSync(path.join(workDir, javaFileName), fixedJavaCode);

                        // Copy original COBOL source to work dir
                        fs.copyFileSync(cobolPath, path.join(workDir, path.basename(cobolPath)));

                        // Compile and run Java code to get REAL output
                        let javaOutput = '';
                        let compareStatus = 'JAVA_ONLY';
                        let compilationError = null;

                        try {
                            const { execSync } = require('child_process');
                            const javaFileInWorkDir = path.join(workDir, javaFileName);

                            // Compile the Java file
                            try {
                                execSync(`javac "${javaFileInWorkDir}"`, {
                                    cwd: workDir,
                                    timeout: 30000,
                                    stdio: ['pipe', 'pipe', 'pipe']
                                });

                                // Run the compiled Java class with empty input (for programs that expect Scanner input)
                                try {
                                    // Use spawnSync to capture both stdout and stderr properly
                                    const { spawnSync } = require('child_process');
                                    const result = spawnSync('java', ['-cp', workDir, javaClassName], {
                                        cwd: workDir,
                                        timeout: 10000,
                                        encoding: 'utf-8',
                                        shell: false,
                                        input: '\n\n\n'  // Provide empty input lines for Scanner
                                    });

                                    const stdout = result.stdout || '';
                                    const stderr = result.stderr || '';
                                    const exitCode = result.status;

                                    // Combine stdout and stderr for complete output
                                    let combinedOutput = '';
                                    if (stdout.trim()) {
                                        combinedOutput = stdout.trim();
                                    }
                                    if (stderr.trim()) {
                                        // Include stderr output - it often contains useful program output
                                        if (combinedOutput) {
                                            combinedOutput += '\n' + stderr.trim();
                                        } else {
                                            combinedOutput = stderr.trim();
                                        }
                                    }

                                    if (combinedOutput.length > 0) {
                                        javaOutput = combinedOutput;
                                        compareStatus = 'MATCH';
                                    } else if (exitCode === 0) {
                                        javaOutput = '[Program executed successfully but produced no console output]';
                                    } else if (result.error) {
                                        // Check for specific error types
                                        const errMsg = result.error.message || '';
                                        if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
                                            javaOutput = '[Program timed out - may require interactive input]';
                                        } else {
                                            javaOutput = `[Runtime Error] ${errMsg}`;
                                        }
                                    } else {
                                        javaOutput = `[Program exited with code ${exitCode}]`;
                                    }
                                } catch (runErr) {
                                    javaOutput = `[Runtime Error] ${runErr.message}`;
                                }
                            } catch (compileErr) {
                                compilationError = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                                javaOutput = `[Compilation Error]\n${compilationError}`;
                            }

                            fs.writeFileSync(path.join(workDir, 'java_output.txt'), javaOutput);
                            fs.writeFileSync(path.join(workDir, 'native_output.txt'),
                                'COBOL native execution not available (requires mainframe environment)');

                        } catch (execErr) {
                            javaOutput = `[Execution Error] ${execErr.message}`;
                            fs.writeFileSync(path.join(workDir, 'java_output.txt'), javaOutput);
                        }

                        fileResult.status = 'success';

                        // Analyze conversion accuracy
                        const accuracyResult = azureAgent.analyzeConversionAccuracy(cobolSource, conversionResult.javaCode);

                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_path: javaPath,
                            work_dir: workDir,
                            java_status: 'SUCCESS',
                            compare: compareStatus,
                            method: 'azure_ai',
                            conversionAccuracy: accuracyResult.accuracy,
                            accuracyDetails: accuracyResult.details
                        };

                    } else {
                        fileResult.status = 'error';
                        fileResult.error = conversionResult.error;
                        fileResult.reportEntry = {
                            path: relativePath,
                            source_path: cobolPath,
                            java_status: 'CONVERT_FAIL',
                            error: conversionResult.error
                        };
                    }

                } catch (fileErr) {
                    fileResult.status = 'error';
                    fileResult.error = fileErr.message;
                    fileResult.reportEntry = {
                        path: relativePath,
                        source_path: cobolPath,
                        java_status: 'FAIL',
                        error: fileErr.message
                    };
                }

                return fileResult;
            }

            // Process files in parallel batches
            conversion.logs.push(`🚀 Processing ${cobolFiles.length} files in parallel (batch size: ${BATCH_SIZE})...\n\n`);

            let completedCount = 0;

            for (let i = 0; i < cobolFiles.length; i += BATCH_SIZE) {
                const batch = cobolFiles.slice(i, Math.min(i + BATCH_SIZE, cobolFiles.length));
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(cobolFiles.length / BATCH_SIZE);

                conversion.logs.push(`📦 Batch ${batchNum}/${totalBatches}: Converting ${batch.length} files...\n`);

                // Process batch in parallel
                const batchPromises = batch.map((cobolPath, idx) =>
                    processFile(cobolPath, i + idx, cobolFiles.length, inputPath)
                );

                const batchResults = await Promise.all(batchPromises);

                // Process results
                for (const fileResult of batchResults) {
                    completedCount++;

                    if (fileResult.status === 'success') {
                        results.converted++;
                        results.convertedFiles.push(`${fileResult.relativePath} [AZURE_AI]`);
                        conversion.logs.push(`   ✅ ${fileResult.relativePath}\n`);
                    } else if (fileResult.status === 'skipped_noid' || fileResult.status === 'skipped_small') {
                        results.skippedNoId++;
                        results.skippedFiles.push(`${fileResult.relativePath} - No PROGRAM-ID`);
                        conversion.logs.push(`   ⏭️ ${fileResult.relativePath} (skipped)\n`);
                    } else if (fileResult.status === 'error') {
                        results.skippedError++;
                        results.errorFiles.push(`${fileResult.relativePath} - ${fileResult.error}`);
                        conversion.logs.push(`   ❌ ${fileResult.relativePath}: ${fileResult.error?.substring(0, 50) || 'Error'}\n`);
                    }

                    if (fileResult.reportEntry) {
                        results.report.files.push(fileResult.reportEntry);
                    }

                    if (fileResult.businessRules) {
                        results.businessRulesData.push(fileResult.businessRules);
                    }
                }

                conversion.logs.push(`   📊 Progress: ${completedCount}/${cobolFiles.length} files (${Math.round(completedCount / cobolFiles.length * 100)}%)\n\n`);

                // Small delay between batches to avoid rate limiting
                if (i + BATCH_SIZE < cobolFiles.length) {
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay to avoid rate limits
                }
            }

            // Calculate average conversion accuracy
            const accuracyValues = results.report.files
                .filter(f => f.conversionAccuracy !== undefined)
                .map(f => f.conversionAccuracy);
            const averageAccuracy = accuracyValues.length > 0
                ? Math.round(accuracyValues.reduce((a, b) => a + b, 0) / accuracyValues.length)
                : 0;

            // Update summary
            // Note: Azure AI conversions are JAVA_ONLY (no native COBOL comparison)
            results.report.summary = {
                total: results.totalFiles,
                processed: results.totalFiles - results.skippedCopybook - results.skippedNoId,
                matches: 0,
                mismatches: 0,
                success_java_only: results.converted,
                fail_conversion: results.skippedError,
                fail_compile: 0,
                fail_execution: 0,
                skipped_copybook: results.skippedCopybook,
                skipped_noid: results.skippedNoId,
                averageAccuracy: averageAccuracy
            };

            conversion.logs.push(`\n${'='.repeat(50)}\n`);
            conversion.logs.push(`📊 Conversion Summary (Azure AI)\n`);
            conversion.logs.push(`${'='.repeat(50)}\n`);
            conversion.logs.push(`Total files scanned: ${results.totalFiles}\n`);
            conversion.logs.push(`✅ Successfully converted: ${results.converted}\n`);
            conversion.logs.push(`📈 Average Conversion Accuracy: ${averageAccuracy}%\n`);
            conversion.logs.push(`Skipped (no PROGRAM-ID): ${results.skippedNoId}\n`);
            if (results.skippedError > 0) {
                conversion.logs.push(`❌ Errors: ${results.skippedError}\n`);
            }
            conversion.logs.push(`\n🤖 Powered by Azure AI Agent\n`);

            // Generate PRD from collected business rules
            if (results.businessRulesData.length > 0) {
                try {
                    const prdContent = generatePRD(results.businessRulesData, inputPath);
                    const prdPath = path.join(outputDir, 'PRD.md');
                    fs.writeFileSync(prdPath, prdContent);
                    const htmlContent = generatePRDHtml(results.businessRulesData, inputPath);
                    const htmlPath = path.join(outputDir, 'PRD.html');
                    fs.writeFileSync(htmlPath, htmlContent);
                    // Save raw JSON for diagram rendering in the UI
                    const dataPath = path.join(outputDir, 'businessRules.json');
                    fs.writeFileSync(dataPath, JSON.stringify(results.businessRulesData, null, 2));
                    results.prdGenerated = true;
                    conversion.logs.push(`📄 Business Rules PRD generated (${results.businessRulesData.length} programs documented)\n`);
                } catch (prdErr) {
                    console.error('PRD generation error:', prdErr.message);
                }
            }

        } catch (err) {
            conversion.logs.push(`\n❌ Conversion error: ${err.message}\n`);
        }

        conversion.status = 'completed';
        conversion.result = results;
    })();

    res.json({ conversionId, outputDir, useAzureAI: true });
});

// API: Get conversion status
app.get('/api/status/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);

    if (!conversion) {
        return res.status(404).json({ error: 'Conversion not found' });
    }

    res.json(conversion);
});

// API: Get converted files list
app.get('/api/files/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);

    if (!conversion || !conversion.result) {
        return res.status(404).json({ error: 'Conversion not found or not complete' });
    }

    // List Java files in output directory
    const javaDir = path.join(conversion.result.outputDir, 'java');
    let javaFiles = [];

    try {
        if (fs.existsSync(javaDir)) {
            javaFiles = fs.readdirSync(javaDir)
                .filter(f => f.endsWith('.java'))
                .map(f => ({
                    name: f,
                    path: path.join(javaDir, f)
                }));
        }
    } catch (err) {
        console.error('Error reading java directory:', err);
    }

    res.json({ files: javaFiles, ...conversion.result });
});

// API: Get file content
app.get('/api/file-content', (req, res) => {
    const filePath = req.query.path;

    if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(404).json({ error: 'File not found' });
    }
});

// API: Get comparison data (COBOL vs Java outputs)
app.get('/api/comparison', (req, res) => {
    const workDir = req.query.workDir;

    if (!workDir || workDir === 'N/A') {
        return res.status(400).json({ error: 'Work directory not available' });
    }

    const result = {
        nativeOutput: null,
        javaOutput: null,
        diff: null,
        nativeExists: false,
        javaExists: false
    };

    // Read native output
    const nativePath = path.join(workDir, 'native_output.txt');
    try {
        if (fs.existsSync(nativePath)) {
            result.nativeOutput = fs.readFileSync(nativePath, 'utf-8');
            result.nativeExists = true;
        }
    } catch (err) {
        console.error('Error reading native output:', err);
    }

    // Read java output
    const javaPath = path.join(workDir, 'java_output.txt');
    try {
        if (fs.existsSync(javaPath)) {
            result.javaOutput = fs.readFileSync(javaPath, 'utf-8');
            result.javaExists = true;
        }
    } catch (err) {
        console.error('Error reading java output:', err);
    }

    // Read diff if exists
    const diffPath = path.join(workDir, 'diff.txt');
    try {
        if (fs.existsSync(diffPath)) {
            result.diff = fs.readFileSync(diffPath, 'utf-8');
        }
    } catch (err) {
        console.error('Error reading diff:', err);
    }

    res.json(result);
});

// API: Get code comparison (COBOL source vs Java code)
app.get('/api/code-comparison', (req, res) => {
    const workDir = req.query.workDir;

    if (!workDir || workDir === 'N/A') {
        return res.status(400).json({ error: 'Work directory not available' });
    }

    const result = {
        javaCode: null,
        javaExists: false
    };

    // Try to find Java file in work directory
    try {
        if (fs.existsSync(workDir)) {
            const files = fs.readdirSync(workDir);
            const javaFile = files.find(f => f.endsWith('.java'));

            if (javaFile) {
                const javaPath = path.join(workDir, javaFile);
                result.javaCode = fs.readFileSync(javaPath, 'utf-8');
                result.javaExists = true;
            }
        }
    } catch (err) {
        console.error('Error reading java code:', err);
    }

    res.json(result);
});

// API: Get generated PRD content
app.get('/api/prd/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion || !conversion.result) {
        return res.status(404).json({ error: 'Conversion not found or not complete' });
    }
    const prdPath = path.join(conversion.result.outputDir, 'PRD.md');
    if (!fs.existsSync(prdPath)) {
        return res.status(404).json({ error: 'PRD not generated' });
    }
    try {
        const content = fs.readFileSync(prdPath, 'utf-8');
        res.json({ content, programCount: conversion.result.businessRulesData?.length || 0 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read PRD' });
    }
});

// API: Get generated HTML report
app.get('/api/prd-html/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion || !conversion.result) {
        return res.status(404).json({ error: 'Conversion not found or not complete' });
    }
    const htmlPath = path.join(conversion.result.outputDir, 'PRD.html');
    if (!fs.existsSync(htmlPath)) {
        return res.status(404).json({ error: 'HTML report not generated' });
    }
    try {
        const content = fs.readFileSync(htmlPath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read HTML report' });
    }
});

// API: Get raw business rules JSON for diagram rendering
app.get('/api/prd-data/:id', (req, res) => {
    const conversion = activeConversions.get(req.params.id);
    if (!conversion || !conversion.result) {
        return res.status(404).json({ error: 'Conversion not found or not complete' });
    }
    const dataPath = path.join(conversion.result.outputDir, 'businessRules.json');
    if (!fs.existsSync(dataPath)) {
        // Fall back to in-memory data if file not written yet
        const data = conversion.result.businessRulesData;
        if (!data || data.length === 0) return res.status(404).json({ error: 'No business rules data available' });
        return res.json({ programs: data });
    }
    try {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        res.json({ programs: data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read business rules data' });
    }
});

// Strip ANSI codes
function stripAnsi(string) {
    return string.replace(/\u001b\[[0-9;]*m/g, '');
}

// Parse scanner output
function parseOutput(output, outputDir) {
    // Try to read report.json
    const reportPath = path.join(outputDir, 'report.json');
    let report = null;

    try {
        if (fs.existsSync(reportPath)) {
            const reportData = fs.readFileSync(reportPath, 'utf-8');
            report = JSON.parse(reportData);
        }
    } catch (e) {
        console.error('Error reading report.json:', e);
    }

    // Default result structure
    const result = {
        outputDir,
        totalFiles: 0,
        converted: 0,
        skippedCopybook: 0,
        skippedNoId: 0,
        skippedError: 0,
        convertedFiles: [],
        skippedFiles: [],
        errorFiles: [],
        report: report // Include full report for advanced UI
    };

    if (report && report.summary) {
        // Use data from JSON report
        result.totalFiles = report.summary.total;
        result.converted = (report.summary.matches || 0) + (report.summary.mismatches || 0) + (report.summary.success_java_only || 0); // Executed files
        // Sum all failure types for total errors
        result.skippedError = (report.summary.fail_conversion || 0) + (report.summary.fail_compile || 0) + (report.summary.fail_execution || 0);

        // Count skips manualy from file list
        let copybooks = 0;
        let noIds = 0;

        report.files.forEach(file => {
            // Status mapping
            if (file.java_status === 'SUCCESS' || file.java_status === 'COMPARE_FAIL' || file.compare === 'MATCH' || file.compare === 'MISMATCH') {
                // It was converted and ran (or at least converted)
                let statusIcon = '✅';
                if (file.compare === 'MISMATCH') statusIcon = '⚠️';
                if (file.compare === 'FAIL') statusIcon = '❌';

                result.convertedFiles.push(`${file.path} [${file.compare}]`);
            } else if (file.java_status === 'SKIPPED_COPYBOOK') {
                copybooks++;
                result.skippedFiles.push(`${file.path} - Copybook`);
            } else if (file.java_status === 'SKIPPED_NO_ID') {
                noIds++;
                result.skippedFiles.push(`${file.path} - No ID DIVISION`);
            } else {
                // Failures
                result.errorFiles.push(`${file.path} - ${file.java_status}`);
            }
        });

        result.skippedCopybook = copybooks;
        result.skippedNoId = noIds;

    } else {
        // Fallback to log parsing (legacy)
        const cleanOutput = stripAnsi(output);
        const lines = cleanOutput.split('\n');

        for (const line of lines) {
            // Parse summary numbers
            if (line.includes('Total files scanned:')) {
                const match = line.match(/Total files scanned:\s*(\d+)/);
                if (match) result.totalFiles = parseInt(match[1]);
            }
            if (line.includes('Successfully converted:')) {
                const match = line.match(/Successfully converted:\s*(\d+)/);
                if (match) result.converted = parseInt(match[1]);
            }
            if (line.includes('Skipped (copybooks):')) {
                const match = line.match(/Skipped \(copybooks\):\s*(\d+)/);
                if (match) result.skippedCopybook = parseInt(match[1]);
            }
            if (line.includes('Skipped (no ID DIV):')) {
                const match = line.match(/Skipped \(no ID DIV\):\s*(\d+)/);
                if (match) result.skippedNoId = parseInt(match[1]);
            }
            if (line.includes('Skipped (errors):')) {
                const match = line.match(/Skipped \(errors\):\s*(\d+)/);
                if (match) result.skippedError = parseInt(match[1]);
            }

            // Parse individual file results
            if (line.includes('[OK]') && line.includes('Converted:')) {
                const match = line.match(/Converted:\s*(.+)$/);
                if (match) result.convertedFiles.push(match[1].trim());
            }
            if (line.includes('[SKIP]')) {
                const match = line.match(/\[SKIP\]\s*(.+)$/);
                if (match) result.skippedFiles.push(match[1].trim());
            }
            if (line.includes('[ERROR]') && !line.includes('Failed to clone repository')) {
                const match = line.match(/\[ERROR\]\s*(.+)\s-\sConversion failed/);
                if (match) {
                    result.errorFiles.push(`${match[1].trim()} - Conversion Error`);
                }
            }
        }
    }

    return result;
}


// ============================================
// AI Agent API Endpoints
// ============================================

// API: Check if AI is available
app.get('/api/ai/status', (req, res) => {
    res.json({
        available: aiAgent.isAvailable(),
        message: aiAgent.isAvailable()
            ? 'AI agent is ready'
            : 'AI agent not configured. Add your OpenAI API key to .env file.'
    });
});

// API: Analyze a failed conversion
app.post('/api/ai/analyze', async (req, res) => {
    const { sourcePath, workDir, errorType } = req.body;

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    if (!aiAgent.isAvailable()) {
        return res.status(503).json({
            error: 'AI agent not available. Please configure your OpenAI API key in .env file.',
            quickSuggestions: aiAgent.getQuickSuggestions(errorType, '')
        });
    }

    try {
        // Read COBOL source
        let cobolSource = '';
        try {
            cobolSource = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            return res.status(404).json({ error: 'COBOL source file not found' });
        }

        // Read error log if available
        let errorLog = '';
        if (workDir) {
            const cobjLog = path.join(workDir, 'cobj.log');
            const javacLog = path.join(workDir, 'javac.log');
            const javaStderr = path.join(workDir, 'java_stderr.log');

            if (fs.existsSync(cobjLog)) {
                errorLog += '=== COBJ Conversion Log ===\n' + fs.readFileSync(cobjLog, 'utf-8') + '\n';
            }
            if (fs.existsSync(javacLog)) {
                errorLog += '=== Java Compilation Log ===\n' + fs.readFileSync(javacLog, 'utf-8') + '\n';
            }
            if (fs.existsSync(javaStderr)) {
                errorLog += '=== Java Runtime Errors ===\n' + fs.readFileSync(javaStderr, 'utf-8') + '\n';
            }
        }

        // Get quick suggestions first
        const quickSuggestions = aiAgent.getQuickSuggestions(errorType, errorLog);

        // Perform AI analysis
        const result = await aiAgent.analyzeConversionFailure(cobolSource, errorLog, errorType);

        res.json({
            ...result,
            quickSuggestions
        });

    } catch (error) {
        console.error('AI analyze error:', error);
        res.status(500).json({ error: 'AI analysis failed: ' + error.message });
    }
});

// API: Auto-fix COBOL code
app.post('/api/ai/fix', async (req, res) => {
    const { sourcePath, workDir } = req.body;

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    if (!aiAgent.isAvailable()) {
        return res.status(503).json({
            error: 'AI agent not available. Please configure your OpenAI API key in .env file.'
        });
    }

    try {
        // Read COBOL source
        let cobolSource = '';
        try {
            cobolSource = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            return res.status(404).json({ error: 'COBOL source file not found' });
        }

        // Read error log if available
        let errorLog = '';
        if (workDir) {
            const cobjLog = path.join(workDir, 'cobj.log');
            if (fs.existsSync(cobjLog)) {
                errorLog = fs.readFileSync(cobjLog, 'utf-8');
            }
        }

        // Attempt auto-fix
        const result = await aiAgent.autoFixCobolCode(cobolSource, errorLog);

        res.json(result);

    } catch (error) {
        console.error('AI fix error:', error);
        res.status(500).json({ error: 'AI fix failed: ' + error.message });
    }
});


// ============================================
// Azure AI Agent API Endpoints
// ============================================

// API: Get Azure AI status
app.get('/api/azure/status', (req, res) => {
    res.json({
        available: azureAgent.isAvailable(),
        config: azureAgent.getConfig(),
        message: azureAgent.isAvailable()
            ? 'Azure AI agent is ready'
            : 'Azure AI not configured. Add AZURE_OPENAI_* to .env file.'
    });
});

// API: Convert single COBOL file to Java using Azure
app.post('/api/azure/convert', async (req, res) => {
    const { cobolSource, sourcePath } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    try {
        let source = cobolSource;

        // If sourcePath provided, read from file
        if (!source && sourcePath) {
            if (fs.existsSync(sourcePath)) {
                source = fs.readFileSync(sourcePath, 'utf-8');
            } else {
                return res.status(404).json({ error: 'Source file not found' });
            }
        }

        if (!source) {
            return res.status(400).json({ error: 'COBOL source code required' });
        }

        const result = await azureAgent.convertCobolToJava(source);
        res.json(result);

    } catch (error) {
        console.error('Azure convert error:', error);
        res.status(500).json({ error: 'Azure conversion failed: ' + error.message });
    }
});

// API: Scan directory for COBOL files
app.post('/api/azure/scan', async (req, res) => {
    const { directory } = req.body;

    if (!directory) {
        return res.status(400).json({ error: 'Directory path required' });
    }

    if (!fs.existsSync(directory)) {
        return res.status(404).json({ error: 'Directory not found' });
    }

    try {
        const cobolFiles = azureAgent.scanForCobolFiles(directory);
        res.json({
            success: true,
            directory,
            files: cobolFiles,
            count: cobolFiles.length
        });
    } catch (error) {
        res.status(500).json({ error: 'Scan failed: ' + error.message });
    }
});

// API: Convert entire directory using Azure AI
app.post('/api/azure/convert-directory', async (req, res) => {
    const { inputDir, outputDir } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    if (!inputDir) {
        return res.status(400).json({ error: 'Input directory required' });
    }

    if (!fs.existsSync(inputDir)) {
        return res.status(404).json({ error: 'Input directory not found' });
    }

    // Default output directory
    const outDir = outputDir || path.join(os.tmpdir(), `azure_java_output_${Date.now()}`);

    try {
        const result = await azureAgent.convertDirectory(inputDir, outDir);
        res.json({
            ...result,
            outputDir: outDir
        });
    } catch (error) {
        console.error('Azure directory conversion error:', error);
        res.status(500).json({ error: 'Directory conversion failed: ' + error.message });
    }
});

// API: Analyze failure using Azure AI
app.post('/api/azure/analyze', async (req, res) => {
    const { sourcePath, workDir, errorType } = req.body;

    if (!azureAgent.isAvailable()) {
        return res.status(503).json({
            error: 'Azure AI not available. Configure AZURE_OPENAI_* in .env file.'
        });
    }

    if (!sourcePath) {
        return res.status(400).json({ error: 'Source path required' });
    }

    try {
        let cobolSource = '';
        try {
            cobolSource = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            return res.status(404).json({ error: 'COBOL source file not found' });
        }

        // Read error logs
        let errorLog = '';
        if (workDir) {
            const logFiles = ['cobj.log', 'javac.log', 'java_stderr.log'];
            for (const logFile of logFiles) {
                const logPath = path.join(workDir, logFile);
                if (fs.existsSync(logPath)) {
                    errorLog += `=== ${logFile} ===\n${fs.readFileSync(logPath, 'utf-8')}\n`;
                }
            }
        }

        const result = await azureAgent.analyzeConversionFailure(cobolSource, errorLog, errorType);
        res.json(result);

    } catch (error) {
        console.error('Azure analyze error:', error);
        res.status(500).json({ error: 'Azure analysis failed: ' + error.message });
    }
});

// API: Get current AI provider info
app.get('/api/ai/provider', (req, res) => {
    res.json({
        provider: AI_PROVIDER,
        openai: {
            available: aiAgent.isAvailable()
        },
        azure: {
            available: azureAgent.isAvailable(),
            config: azureAgent.getConfig()
        }
    });
});

// API: Extract file dependencies (COPY and CALL statements)
app.get('/api/dependencies', (req, res) => {
    const filePath = req.query.path;

    if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const dependencies = {
            copybooks: [],
            programCalls: [],
            hasRelationships: false
        };

        // Extract COPY statements (e.g., COPY 'FILENAME', COPY FILENAME, COPY FILENAME.)
        const copyRegex = /COPY\s+['"]?([A-Z0-9_-]+)['"]?\s*\.?/gi;
        let match;
        while ((match = copyRegex.exec(content)) !== null) {
            const copybookName = match[1].toUpperCase();
            if (!dependencies.copybooks.includes(copybookName)) {
                dependencies.copybooks.push(copybookName);
            }
        }

        // Extract CALL statements (e.g., CALL 'PROGRAMNAME', CALL "PROGRAMNAME")
        const callRegex = /CALL\s+['"]([A-Z0-9_-]+)['"]/gi;
        while ((match = callRegex.exec(content)) !== null) {
            const programName = match[1].toUpperCase();
            if (!dependencies.programCalls.includes(programName)) {
                dependencies.programCalls.push(programName);
            }
        }

        dependencies.hasRelationships = dependencies.copybooks.length > 0 || dependencies.programCalls.length > 0;

        res.json(dependencies);
    } catch (err) {
        res.status(404).json({ error: 'File not found or could not be read' });
    }
});


// Start server
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 COBOL Converter UI starting...');
    console.log('='.repeat(50));

    // Initialize AI agents based on provider
    if (AI_PROVIDER === 'azure') {
        const azureInit = azureAgent.initializeAzure();
        if (!azureInit) {
            console.log('   Falling back to OpenAI...');
            aiAgent.initializeOpenAI();
        }
    } else {
        aiAgent.initializeOpenAI();
    }

    // Also try to initialize the other provider (for dual support)
    if (AI_PROVIDER === 'openai') {
        azureAgent.initializeAzure(); // Silent init for Azure as backup
    }

    console.log('='.repeat(50));
    console.log(`🌐 Server running at http://localhost:${PORT}`);
    console.log(`📁 AI Provider: ${AI_PROVIDER.toUpperCase()}`);
    console.log('='.repeat(50) + '\n');
});
