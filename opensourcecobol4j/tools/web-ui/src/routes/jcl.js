/**
 * GET /api/jcl-analysis — parse one JCL file and (optionally) cross-reference
 * its PGM= targets with the classes that were converted in a given conversion.
 *
 * Query: { conversionId?, path }
 * Returns: { parsed, coverage: [ { program, converted, javaClass?, status } ],
 *            recommendation, source }
 *
 * Coverage is populated only when conversionId matches an active conversion.
 * Recommendation picks a modern orchestration target (Spring Batch / Airflow /
 * cron) based on step count + presence of DB2/SORT steps.
 *
 * mount(app, deps) where deps = { activeConversions, parseJcl }.
 */

const fs = require('fs');
const path = require('path');

function mount(app, deps) {
    const { activeConversions, parseJcl } = deps;

    app.get('/api/jcl-analysis', (req, res) => {
        const { conversionId, path: filePath } = req.query;
        if (!filePath) return res.status(400).json({ error: 'path required' });
        let source = '';
        try { source = fs.readFileSync(filePath, 'utf-8'); }
        catch { return res.status(404).json({ error: 'JCL source not found' }); }

        const parsed = parseJcl(source);
        const result = { parsed, coverage: [], recommendation: null, source };

        // Cross-reference PGM= with the converted report. Uses PROGRAM-ID
        // extracted from the COBOL source AND the file basename as keys so
        // JCL that references either will resolve.
        if (conversionId && activeConversions.has(conversionId) && parsed) {
            const conversion = activeConversions.get(conversionId);
            const reportFiles = (conversion.result && conversion.result.report && conversion.result.report.report && conversion.result.report.report.files)
                              || (conversion.result && conversion.result.report && conversion.result.report.files)
                              || [];
            const pidMap = {};
            const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
            for (const f of reportFiles) {
                if (!f.source_path) continue;
                const base = path.basename(f.source_path, path.extname(f.source_path)).toUpperCase();
                if (!pidMap[base]) pidMap[base] = { javaPath: f.java_path || null, status: f.java_status };
                try {
                    const src = fs.readFileSync(f.source_path, 'utf-8');
                    const m = src.match(programIdRe);
                    if (m) {
                        const pid = m[1].toUpperCase();
                        if (!pidMap[pid]) pidMap[pid] = { javaPath: f.java_path || null, status: f.java_status };
                    }
                } catch {}
            }
            for (const pgm of parsed.programs) {
                const hit = pidMap[pgm];
                result.coverage.push({
                    program: pgm,
                    converted: !!(hit && hit.status === 'SUCCESS'),
                    javaClass: hit && hit.javaPath ? path.basename(hit.javaPath, '.java') : null,
                    status: hit ? hit.status : 'NOT_IN_CONVERSION'
                });
            }
        }

        // Recommendation heuristic: multi-step / DB2 → Spring Batch,
        // SORT → Beam, otherwise a plain scheduler.
        if (parsed) {
            const stepCount = parsed.steps.length;
            const hasSort = parsed.steps.some(s => /SORT/i.test(s.exec.pgm || ''));
            const hasDB2  = parsed.steps.some(s => /DSNMTV01|DSN/i.test(s.exec.pgm || ''));
            if (hasDB2 || stepCount >= 3) {
                result.recommendation = 'Spring Batch job (multi-step with chunk processing). Each JCL step becomes a Spring Batch Step; DD datasets map to ItemReaders/ItemWriters. Schedule via Quartz or Spring Scheduler.';
            } else if (hasSort) {
                result.recommendation = 'Spring Batch or Apache Beam pipeline — the SORT step is a natural fit for a GroupBy/Sort operator.';
            } else {
                result.recommendation = 'Shell script, Airflow DAG, or Kubernetes CronJob. Each EXEC step becomes a task; DD datasets map to input/output paths.';
            }
        }

        res.json(result);
    });
}

module.exports = { mount };
