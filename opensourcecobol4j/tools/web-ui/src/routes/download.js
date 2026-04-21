/**
 * GET /api/download/:id — streams a zip of the converted Java + manifest +
 * MANUAL_REVIEW.md + raw report.json + a README + orchestration templates.
 *
 * Contents packed into the archive:
 *   1. java/ or src/main/java/   every SUCCESS .java file
 *   2. MANIFEST.md               converted-file table with accuracy + penalties
 *   3. MANUAL_REVIEW.md          per-category guidance for EVERYTHING not in (1)
 *   4. report.json               raw structured report
 *   5. README.md                 orientation: where to start, next steps
 *   6. pom.xml                   when ?format=maven
 *   7. jobs/<JOBNAME>.xml        Spring Batch starter templates, one per JCL
 *                                job — opt-in via ?orchestration=spring-batch
 *
 * mount(app, deps) where deps = { activeConversions, buildManualReviewMd,
 *                                 parseJcl }.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function mount(app, deps) {
    const { activeConversions, buildManualReviewMd, parseJcl } = deps;

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
        // Optional: ?orchestration=spring-batch emits starter Spring Batch
        // XML per JCL job under jobs/. Off by default because not every
        // consumer wants the scaffolding (some want the JCL untouched).
        const wantSpringBatch = req.query.orchestration === 'spring-batch';

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

        // 7. Spring Batch starter templates — one XML per JCL file that
        // parses. Each emits a <job> with one <step> per JCL EXEC step,
        // referencing the converted Java class where we have one and
        // leaving a TODO placeholder where we don't. Users get a runnable
        // skeleton they can fill in rather than a blank page.
        if (wantSpringBatch) {
            const jclFiles = files.filter(f => f.java_status === 'SKIPPED_JCL' && f.source_path);
            let springBatchCount = 0;
            // PROGRAM-ID → Java class map, same resolution the JCL
            // cross-reference uses. Pulled from the report so we don't
            // rescan sources just for this.
            const pidMap = {};
            for (const f of files) {
                if (!f.java_path || !f.source_path) continue;
                const base = path.basename(f.source_path, path.extname(f.source_path)).toUpperCase();
                pidMap[base] = path.basename(f.java_path, '.java');
            }
            for (const jcl of jclFiles) {
                try {
                    const src = fs.readFileSync(jcl.source_path, 'utf-8');
                    const parsed = parseJcl(src);
                    if (!parsed) continue;
                    const xml = buildSpringBatchXml(parsed, pidMap, path.basename(jcl.source_path));
                    const jobId = parsed.jobName || path.basename(jcl.source_path, path.extname(jcl.source_path));
                    archive.append(xml, { name: `jobs/${jobId}.spring-batch.xml` });
                    springBatchCount++;
                } catch {}
            }
            if (springBatchCount > 0) {
                archive.append(
                    buildSpringBatchReadme(springBatchCount),
                    { name: 'jobs/README.md' }
                );
            }
        }

        archive.finalize();
    });
}

function xmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Build a Spring Batch job XML from a parsed JCL structure. Each EXEC
 * step becomes a <step>; we reference the converted Java class as a
 * placeholder tasklet bean when we have one, and leave a descriptive
 * TODO comment for unresolved PGM= targets.
 *
 * Output is a starter — not a production job. Wires DDs to XML comments
 * so users see which datasets each step reads/writes without having to
 * guess at Spring Batch's ItemReader/ItemWriter shape (that's their call
 * depending on file vs JDBC vs whatever).
 */
function buildSpringBatchXml(parsed, pidMap, jclFilename) {
    const jobId = parsed.jobName || 'converted-job';
    const steps = parsed.steps || [];

    const stepXml = steps.map((s, idx) => {
        const pgm = s.exec && s.exec.pgm;
        const proc = s.exec && s.exec.proc;
        const javaClass = pgm ? pidMap[pgm.toUpperCase()] : null;
        const next = idx < steps.length - 1 ? ` next="${xmlEscape((steps[idx + 1].name) || ('step' + (idx + 2)))}"` : '';
        const stepId = xmlEscape(s.name || ('step' + (idx + 1)));

        // Per-step context block: DDs as XML comments so the user sees
        // what the mainframe runtime threaded through this step without
        // the converter pretending to understand the dataset shapes.
        const ddsComment = (s.dds || []).length > 0
            ? '\n        <!-- DD statements from JCL (consumed by the original PGM):\n' +
              (s.dds || []).map(dd => `             ${xmlEscape(dd.name)}${dd.dsn ? ` = ${xmlEscape(dd.dsn)}` : ''}${dd.sysout ? ' (SYSOUT)' : ''}`).join('\n') +
              '\n        -->'
            : '';
        const steplibsComment = (s.steplibs || []).length > 0
            ? '\n        <!-- STEPLIB load libraries:\n' +
              s.steplibs.map(l => `             ${xmlEscape(l)}`).join('\n') +
              '\n        -->'
            : '';

        if (proc) {
            return `    <step id="${stepId}"${next}>${ddsComment}${steplibsComment}
        <!-- EXEC PROC=${xmlEscape(proc)} — referenced procedure was not expanded by the converter.
             Re-point this step at whatever the PROC contains once you port its body. -->
        <tasklet ref="todoTasklet"/>
    </step>`;
        }

        if (javaClass) {
            return `    <step id="${stepId}"${next}>${ddsComment}${steplibsComment}
        <!-- Maps to converted Java class: ${xmlEscape(javaClass)}.
             Wrap as a Spring Batch Tasklet or swap for an ItemReader/Processor/Writer
             chain depending on this step's I/O shape. -->
        <tasklet ref="${xmlEscape(javaClass.charAt(0).toLowerCase() + javaClass.slice(1))}Tasklet"/>
    </step>`;
        }

        return `    <step id="${stepId}"${next}>${ddsComment}${steplibsComment}
        <!-- TODO: PGM=${xmlEscape(pgm || '(unknown)')} was not converted in this run
             (likely a system utility, external library, or missing sibling).
             Point this tasklet at the right Java implementation before running. -->
        <tasklet ref="todoTasklet"/>
    </step>`;
    }).join('\n\n');

    // Gather unique Java class names referenced so users see which beans
    // they still need to wire as tasklets.
    const uniqueClasses = new Set();
    for (const s of steps) {
        const pgm = s.exec && s.exec.pgm;
        if (pgm && pidMap[pgm.toUpperCase()]) uniqueClasses.add(pidMap[pgm.toUpperCase()]);
    }
    const beanHints = [...uniqueClasses].map(c => {
        const id = c.charAt(0).toLowerCase() + c.slice(1) + 'Tasklet';
        return `    <!-- <bean id="${id}" class="com.example.tasklets.${c}Tasklet"/> -->`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Spring Batch starter job generated from ${xmlEscape(jclFilename)}.
  Job name:  ${xmlEscape(jobId)}
  Steps:     ${steps.length}

  This is a STARTER template, not a production job. It preserves the
  JCL's step order and DD context as XML comments so you can map each
  step to the right Spring Batch pattern (Tasklet for simple invocations;
  Reader/Processor/Writer for data flows) without losing the mainframe
  runtime context.

  Each converted COBOL program is referenced by its camelCase bean id
  (e.g. ProgramName → programNameTasklet). You'll need to declare those
  beans pointing at whatever tasklet / chunk implementation you wrap the
  generated Java in. Hints at the bottom of this file.
-->
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns:batch="http://www.springframework.org/schema/batch"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
           https://www.springframework.org/schema/beans/spring-beans.xsd
           http://www.springframework.org/schema/batch
           https://www.springframework.org/schema/batch/spring-batch.xsd">

<batch:job id="${xmlEscape(jobId)}">
${stepXml}
</batch:job>

<!-- Tasklet bean hints — uncomment + point at your implementations: -->
${beanHints || '    <!-- (no converted programs referenced in this job) -->'}
<!-- <bean id="todoTasklet" class="com.example.tasklets.TodoTasklet"/> -->

</beans>
`;
}

function buildSpringBatchReadme(jobCount) {
    return `# Spring Batch starter templates

Generated ${jobCount} job XML file${jobCount === 1 ? '' : 's'} from the JCL in this repository.

Each file is a **starter**, not a production job:

- The \`<batch:job>\` preserves the JCL's step order and names.
- Each \`<step>\` references a tasklet bean named after the converted Java
  class (e.g. \`ProgramName\` → \`programNameTasklet\`). Bean hints are
  commented out at the bottom of each file — uncomment and point them at
  the tasklet implementations you wrap around the generated Java.
- DD statements from the original JCL are preserved as XML comments on
  each step so you can decide whether to map them to file paths, JDBC,
  or something else depending on the step's I/O shape.
- Steps whose PGM= target isn't in this conversion get a \`TODO\` tasklet
  with a pointer to what was missing.

## Typical next steps

1. Add Spring Boot + \`spring-boot-starter-batch\` to your \`pom.xml\`.
2. Wrap each converted Java class in a \`Tasklet\` that calls its entry method.
3. Implement \`todoTasklet\` for the unresolved steps OR replace those
   steps with real implementations.
4. For data-flow steps (SORT, MERGE, bulk READ/WRITE), consider replacing
   the tasklet with a proper \`ItemReader\` / \`ItemProcessor\` / \`ItemWriter\`
   chain so you get Spring Batch's chunk + restart features.

Not all JCL steps map cleanly to Spring Batch — CICS transactions, IMS
DLI calls, and BMS screen flow require a different target (CICS TX
framework, message queues, a real UI). The generated Java for those
stays in the main source tree; the Spring Batch XML just doesn't
reference them.
`;
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
