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

        // Optional: ?format=maven emits a pom.xml + src/main/java/ layout
        // so the zip drops straight into an IDE / CI pipeline. Default
        // stays the flat `java/` layout for users who just want files.
        const mavenFormat = req.query.format === 'maven';

        const report = conversion.result.report;
        const files = report.files || [];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const zipName = `cobol-to-java-${req.params.id}-${stamp}${mavenFormat ? '-maven' : ''}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('warning', err => { if (err.code !== 'ENOENT') console.warn('zip warning', err); });
        archive.on('error', err => { console.error('zip error', err); try { res.end(); } catch {} });
        archive.pipe(res);

        // 1. All generated Java files. Flat layout by default; Maven
        // format drops them under src/main/java/ so `mvn compile` works
        // against the unzipped tree immediately. Keeping the default-
        // package layout here — the AI emits classes without a package
        // declaration and Maven compiles default-package sources fine.
        let javaCount = 0;
        const javaDest = mavenFormat ? 'src/main/java' : 'java';
        for (const f of files) {
            if (!f.java_path || !fs.existsSync(f.java_path)) continue;
            archive.file(f.java_path, { name: `${javaDest}/${path.basename(f.java_path)}` });
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
            `Layout: **${mavenFormat ? 'Maven project (src/main/java/ + pom.xml)' : 'flat (java/*.java)'}**`,
            ``,
            `Contents:`,
            ``,
            `- \`${javaDest}/\` — generated Java sources (one file per converted program)`,
            mavenFormat ? `- \`pom.xml\` — minimal Maven build (Java 11, no deps, default package). \`mvn compile\` against this tree just works.` : '',
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
            mavenFormat
                ? `3. To compile: \`mvn compile\` from the unzipped tree. All classes share`
                    + `\n   the default package; add your own package declarations as you refactor.`
                : `3. To compile: drop \`java/*.java\` into your build (e.g. Maven/Gradle`
                    + `\n   \`src/main/java\`) and \`javac\` — all generated classes share the`
                    + `\n   default package. (Or re-download as Maven format: add \`?format=maven\`.)`,
            ``
        ].filter(Boolean).join('\n');
        archive.append(readme, { name: 'README.md' });

        // 6. pom.xml — Maven format only. Minimal but runnable: Java 11
        // source/target, default package (the generated classes don't
        // declare one), UTF-8 encoding, no external deps. `mvn compile`
        // against the unzipped tree just works.
        if (mavenFormat) {
            const pomXml = buildPomXml(req.params.id, javaCount);
            archive.append(pomXml, { name: 'pom.xml' });
        }

        archive.finalize();
    });
}

/**
 * Minimal pom.xml for the Maven download format. Keeps dependencies
 * empty — the generated Java uses only JDK classes (BigDecimal,
 * BufferedReader, etc.) — so users can add their own dependencies
 * (JDBC driver, logging framework) as they modernize.
 */
function buildPomXml(conversionId, javaCount) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.cobol2java.generated</groupId>
    <artifactId>cobol-to-java-${conversionId}</artifactId>
    <version>0.1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <!--
      Generated by the COBOL-to-Java converter.
      Contains ${javaCount} converted class${javaCount === 1 ? '' : 'es'}, all in the default package
      (the AI conversion path doesn't emit package declarations — drop your own
      if you want to reorganize).

      No dependencies declared — the generated code uses only java.* APIs.
      Add JDBC driver, logging framework, etc. as you modernize.
    -->

    <properties>
        <maven.compiler.source>11</maven.compiler.source>
        <maven.compiler.target>11</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <build>
        <!-- Generated Java is default-package; Maven picks up *.java under
             src/main/java without requiring a nested package path. -->
        <sourceDirectory>src/main/java</sourceDirectory>
    </build>
</project>
`;
}

module.exports = { mount };
