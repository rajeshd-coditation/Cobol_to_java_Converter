/**
 * GET /api/download/:id — streams a zip of the converted Java + manifest +
 * MANUAL_REVIEW.md + raw report.json + a README.
 *
 * Contents packed into the archive:
 *   1. java/*.java         — every file that reached SUCCESS, under `java/`
 *   2. MANIFEST.md         — converted-file table with accuracy + penalties
 *   3. MANUAL_REVIEW.md    — per-category guidance for EVERYTHING not in (1)
 *                            (JCL, copybooks, data files, HTML, scripts, etc.)
 *   4. report.json         — raw structured report
 *   5. README.md           — orientation: where to start, next steps
 *
 * mount(app, deps) where deps = { activeConversions, buildManualReviewMd }.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function mount(app, deps) {
    const { activeConversions, buildManualReviewMd } = deps;

    app.get('/api/download/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        if (!conversion.result || !conversion.result.report) {
            return res.status(400).json({ error: 'Conversion not complete — nothing to download yet.' });
        }

        const report = conversion.result.report;
        const files = report.files || [];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const zipName = `cobol-to-java-${req.params.id}-${stamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', err => { if (err.code !== 'ENOENT') console.warn('zip warning', err); });
        archive.on('error', err => { console.error('zip error', err); try { res.end(); } catch {} });
        archive.pipe(res);

        // 1. All generated Java files — flatten into `java/`.
        let javaCount = 0;
        for (const f of files) {
            if (!f.java_path || !fs.existsSync(f.java_path)) continue;
            archive.file(f.java_path, { name: `java/${path.basename(f.java_path)}` });
            javaCount++;
        }

        // 2. MANIFEST.md
        const manifest = [];
        manifest.push(`# Conversion manifest`);
        manifest.push('');
        manifest.push(`Conversion ID: ${req.params.id}`);
        manifest.push(`Generated: ${new Date().toISOString()}`);
        manifest.push(`Total files in report: ${files.length}`);
        manifest.push(`Generated Java files: ${javaCount}`);
        manifest.push('');
        manifest.push(`## Converted files`);
        manifest.push('');
        manifest.push(`| COBOL path | Status | Accuracy | Java class |`);
        manifest.push(`|------------|--------|----------|------------|`);
        const converted = files.filter(f => f.java_status === 'SUCCESS');
        for (const f of converted) {
            const acc = f.conversionAccuracy != null ? `${f.conversionAccuracy}%` : '—';
            const javaClass = f.java_path ? path.basename(f.java_path, '.java') : '—';
            manifest.push(`| \`${f.path}\` | ${f.java_status || '—'} | ${acc} | ${javaClass} |`);
        }
        manifest.push('');
        const flagged = files.filter(f =>
            f.accuracyBreakdown
            && Array.isArray(f.accuracyBreakdown.semanticPenalties)
            && f.accuracyBreakdown.semanticPenalties.length > 0
        );
        if (flagged.length > 0) {
            manifest.push(`## Converted files needing manual review`);
            manifest.push('');
            for (const f of flagged) {
                manifest.push(`### \`${f.path}\` — ${f.conversionAccuracy}% confidence`);
                for (const p of f.accuracyBreakdown.semanticPenalties) {
                    manifest.push(`- **${p}**`);
                }
                manifest.push('');
            }
        }
        archive.append(manifest.join('\n'), { name: 'MANIFEST.md' });

        // 3. MANUAL_REVIEW.md — the non-Java leftovers with per-category guidance.
        archive.append(buildManualReviewMd(files, req.params.id), { name: 'MANUAL_REVIEW.md' });

        // 4. raw report.json
        archive.append(JSON.stringify(report, null, 2), { name: 'report.json' });

        // 5. README pointing at the above
        const readme = [
            `# COBOL → Java conversion output`,
            ``,
            `This archive contains the Java code generated from a COBOL-to-Java`,
            `conversion run, plus guidance on the remaining (non-COBOL) artifacts.`,
            ``,
            `Contents:`,
            ``,
            `- \`java/\` — generated Java sources (one file per converted program)`,
            `- \`MANIFEST.md\` — converted files: status, accuracy scores, penalties`,
            `- \`MANUAL_REVIEW.md\` — **non-converted** files: JCL, data, HTML, SQL,`,
            `  other languages, etc. Each gets an action label (PORT / KEEP / REVIEW)`,
            `  with a per-category recommendation for what to do next.`,
            `- \`report.json\` — full structured report for tooling`,
            ``,
            `## Next steps`,
            ``,
            `1. Read \`MANIFEST.md\` for converted-file status.`,
            `2. Read \`MANUAL_REVIEW.md\` — this is where the remaining modernization`,
            `   work is listed (orchestration, UI, scripts, SQL, etc.). Modernization`,
            `   is not complete until every item in there has a decision.`,
            `3. To compile: drop \`java/*.java\` into your build (e.g. Maven/Gradle`,
            `   \`src/main/java\`) and \`javac\` — all generated classes share the`,
            `   default package.`,
            ``
        ].join('\n');
        archive.append(readme, { name: 'README.md' });

        archive.finalize();
    });
}

module.exports = { mount };
