/**
 * Per-artifact classification + MANUAL_REVIEW.md builder.
 *
 * classifyArtifact(filePath) → { category, action, recommendation }
 *   For every non-COBOL artifact in the repo we emit one of:
 *     - PORT      (rewrite / re-implement in target stack)
 *     - EMBEDDED  (already folded into a generated class)
 *     - KEEP      (ship as-is alongside Java output)
 *     - REVIEW    (needs a human decision)
 *   Unknown extensions fall through to REVIEW + "inspect manually".
 *
 * buildManualReviewMd(files, conversionId) → markdown string
 *   Consumed by the /api/download/:id zip builder. Groups non-converted
 *   files by classifyArtifact category, sorts categories so PORT/REVIEW
 *   (the highest-effort work) surfaces first, and caps per-category file
 *   lists at 200 with a "…and N more" note to keep the document readable.
 */

const path = require('path');

function classifyArtifact(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath).toLowerCase();

    // Mainframe orchestration / data — the things most likely to need real work.
    if (/\.(jcl|proc)$/i.test(ext)) return {
        category: 'Mainframe orchestration (JCL)',
        action: 'PORT',
        recommendation: 'JCL is not COBOL — parse each step (EXEC PGM=…) and map it to Spring Batch, Airflow, Kubernetes CronJob, or a shell script. DD statements → input/output paths. See the JCL analyzer in the UI for per-file step breakdown.'
    };
    if (/\.(cpy|copy)$/i.test(ext)) return {
        category: 'COBOL copybook',
        action: 'EMBEDDED',
        recommendation: 'Copybooks are shared data definitions. They get embedded into the Java model classes for programs that COPY them — no standalone Java file. If a copybook is not referenced by any converted program, verify the reference was resolvable.'
    };
    if (/\.(dat|csv|txt)$/i.test(ext)) return {
        category: 'Data file',
        action: 'KEEP',
        recommendation: 'Ship alongside the Java as runtime input. Update file paths in Java (BufferedReader/Writer) to point at wherever these will live in production — typically `src/main/resources/` for test data, or a configured external path for real data.'
    };
    if (/\.(bms|mps)$/i.test(ext)) return {
        category: 'BMS screen map (CICS)',
        action: 'PORT',
        recommendation: 'BMS defines terminal screens. Port to a web UI (React / Thymeleaf / JSF) or a Swing/JavaFX form. The converted Java uses console output as a placeholder — replace with a real UI layer.'
    };

    if (/\.(py|python)$/i.test(ext)) return {
        category: 'Python source',
        action: 'REVIEW',
        recommendation: 'Python is a separate concern from the COBOL conversion. Either port to Java (if it\'s support tooling) or keep as an out-of-process service called from Java via REST / subprocess.'
    };
    if (/\.(html?|htm)$/i.test(ext)) return {
        category: 'HTML',
        action: 'KEEP',
        recommendation: 'Keep as-is for the web layer. If it\'s static markup, move into `src/main/resources/static/`. If it\'s a template (JSP/Thymeleaf/Mustache), align with your Java framework\'s template directory.'
    };
    if (/\.(css|scss|sass|less)$/i.test(ext)) return {
        category: 'Stylesheet',
        action: 'KEEP',
        recommendation: 'Keep as-is in `src/main/resources/static/` or your frontend build system.'
    };
    if (/\.(js|mjs|ts|tsx|jsx)$/i.test(ext)) return {
        category: 'JavaScript / TypeScript',
        action: 'KEEP',
        recommendation: 'Keep as-is — separate from COBOL. If this is front-end code, move into your frontend build (Vite/Webpack); if it\'s Node tooling, keep as a separate service.'
    };
    if (/\.(sh|bash|zsh)$/i.test(ext)) return {
        category: 'Shell script',
        action: 'REVIEW',
        recommendation: 'If the script invokes COBOL binaries, update to invoke `java -jar` with equivalent arguments. If it\'s general tooling, keep as-is or rewrite in Java if cross-platform is a concern.'
    };
    if (/\.(sql|ddl|db2)$/i.test(ext)) return {
        category: 'SQL / DDL',
        action: 'KEEP',
        recommendation: 'Keep as-is and run via JDBC or a migration tool (Flyway / Liquibase). DB2 DDL may need minor tweaks to land on PostgreSQL/Oracle/MySQL.'
    };
    if (/\.(xml|xsd|wsdl)$/i.test(ext)) return {
        category: 'XML artifact',
        action: 'KEEP',
        recommendation: 'Keep as-is. Parse in Java via JAXB, DOM, or Jackson XML as appropriate.'
    };
    if (/\.(yaml|yml|toml|ini|properties|conf)$/i.test(ext)) return {
        category: 'Config',
        action: 'KEEP',
        recommendation: 'Keep as-is. Load in Java via Spring @ConfigurationProperties or a config library.'
    };
    if (/\.(json)$/i.test(ext)) return {
        category: 'JSON',
        action: 'KEEP',
        recommendation: 'Keep as-is. Parse in Java via Jackson or Gson.'
    };
    if (/\.(md|rst|adoc|txt)$/i.test(ext)) return {
        category: 'Documentation',
        action: 'KEEP',
        recommendation: 'Keep in repo — valuable context for maintainers.'
    };
    if (/\.(png|jpe?g|gif|svg|ico|webp|pdf)$/i.test(ext)) return {
        category: 'Binary asset',
        action: 'KEEP',
        recommendation: 'Keep in repo — serve as static content if needed.'
    };
    if (/\.(class|jar|war|ear)$/i.test(ext)) return {
        category: 'Pre-compiled Java',
        action: 'REVIEW',
        recommendation: 'Existing Java binaries — confirm these don\'t conflict with the newly generated Java classes.'
    };
    if (/\.(c|cc|cpp|h|hpp|go|rs|rb|php|kt|scala|swift)$/i.test(ext)) return {
        category: 'Other source language',
        action: 'REVIEW',
        recommendation: 'Not COBOL and not the target language. Decide whether to port to Java or keep as a separate service/module.'
    };
    if (base === 'makefile' || base.endsWith('.mk')) return {
        category: 'Makefile',
        action: 'REVIEW',
        recommendation: 'Replace with Maven/Gradle build for the Java output. If the Makefile builds native COBOL, those steps become obsolete once migration is complete.'
    };
    if (base.endsWith('.gitignore') || base === 'license' || base === 'license.md' || base === 'copying') {
        return {
            category: 'VCS / license',
            action: 'KEEP',
            recommendation: 'Keep in repo.'
        };
    }

    return {
        category: 'Unknown / other',
        action: 'REVIEW',
        recommendation: 'File type not auto-recognized. Manually inspect and decide: port logic to Java, keep as-is, or discard.'
    };
}

function buildManualReviewMd(files, conversionId) {
    const lines = [];
    lines.push(`# Manual review checklist`);
    lines.push('');
    lines.push(`Conversion ID: \`${conversionId}\``);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`This checklist covers every artifact in the source repository that was`);
    lines.push(`**not** converted to Java. The COBOL conversion handles business logic`);
    lines.push(`only — everything else (JCL jobs, data files, web assets, shell scripts,`);
    lines.push(`SQL, documentation, other languages, etc.) needs a decision from you.`);
    lines.push('');
    lines.push(`## Actions at a glance`);
    lines.push('');
    lines.push(`- **PORT** — rewrite / re-implement in the target stack`);
    lines.push(`- **EMBEDDED** — already handled by the conversion output`);
    lines.push(`- **KEEP** — ship as-is alongside the Java`);
    lines.push(`- **REVIEW** — needs a human decision before moving forward`);
    lines.push('');

    const nonJava = files.filter(f => f.java_status !== 'SUCCESS');
    const grouped = new Map();
    const countByAction = { PORT: 0, EMBEDDED: 0, KEEP: 0, REVIEW: 0 };

    for (const f of nonJava) {
        const cls = classifyArtifact(f.source_path || f.path || '');
        countByAction[cls.action] = (countByAction[cls.action] || 0) + 1;
        if (!grouped.has(cls.category)) grouped.set(cls.category, { cls, items: [] });
        grouped.get(cls.category).items.push(f);
    }

    lines.push(`## Summary`);
    lines.push('');
    lines.push(`| Action | Count |`);
    lines.push(`|--------|-------|`);
    for (const [action, count] of Object.entries(countByAction)) {
        if (count > 0) lines.push(`| ${action} | ${count} |`);
    }
    lines.push('');

    if (grouped.size === 0) {
        lines.push(`_Nothing to review — every file in the repo was successfully converted._`);
        return lines.join('\n');
    }

    // PORT/REVIEW first — highest effort deserves top billing.
    const categoryOrder = [...grouped.entries()].sort(([, a], [, b]) => {
        const weight = { PORT: 0, REVIEW: 1, EMBEDDED: 2, KEEP: 3 };
        return (weight[a.cls.action] ?? 9) - (weight[b.cls.action] ?? 9);
    });

    for (const [category, { cls, items }] of categoryOrder) {
        lines.push(`## ${category} — ${cls.action} (${items.length} file${items.length === 1 ? '' : 's'})`);
        lines.push('');
        lines.push(cls.recommendation);
        lines.push('');
        lines.push(`**Files:**`);
        lines.push('');
        for (const f of items.slice(0, 200)) {
            const status = f.java_status ? ` — \`${f.java_status}\`` : '';
            lines.push(`- \`${f.path}\`${status}`);
        }
        if (items.length > 200) lines.push(`- _…and ${items.length - 200} more_`);
        lines.push('');
    }

    lines.push(`---`);
    lines.push(`_End of checklist._`);
    return lines.join('\n');
}

module.exports = { classifyArtifact, buildManualReviewMd };
