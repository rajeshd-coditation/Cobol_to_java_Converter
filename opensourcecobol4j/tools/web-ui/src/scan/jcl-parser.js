/**
 * Forgiving JCL parser — returns
 * { jobName, steps[], programs[], datasets[], procs[], libraries[] }.
 *
 * Each step is { name, exec: { pgm? | proc? }, dds: [{ name, dsn, disp,
 * sysout }], steplibs: [dsn...] }. `libraries[]` is the job-wide dedup
 * of every STEPLIB / JOBLIB DSN seen — these are the load libraries
 * where DB2 plans, bound DBRMs, and linker-output objects live, so
 * surfacing them helps users understand what the mainframe runtime
 * expected.
 *
 * Mainframe JCL has many dialects and line-continuation quirks; we
 * catch the common constructs (JOB / EXEC PGM= / EXEC PROC= / DD DSN=
 * / DD SYSOUT=* / STEPLIB / JOBLIB) and skip the rest. Enough to
 * drive our graph builder + DD-context injector + orchestration tab.
 */
function parseJcl(content) {
    if (!content) return null;
    const lines = content.split(/\r?\n/);
    const out = {
        jobName: null,
        steps: [],
        programs: new Set(),
        datasets: new Set(),
        procs: new Set(),
        libraries: new Set()   // deduped STEPLIB / JOBLIB DSNs across the whole job
    };
    let currentStep = null;

    const jobRe  = /^\/\/([A-Z0-9#@$]+)\s+JOB\b/i;
    const stepRe = /^\/\/([A-Z0-9#@$]+)\s+EXEC\s+(.*)/i;
    const ddRe   = /^\/\/([A-Z0-9#@$]+)\s+DD\s+(.*)/i;

    for (let raw of lines) {
        if (!raw) continue;
        // Comments / instream data markers
        if (raw.startsWith('//*') || raw.startsWith('/*')) continue;
        if (!raw.startsWith('//')) continue;

        let m;
        if ((m = jobRe.exec(raw))) {
            out.jobName = m[1];
            continue;
        }
        if ((m = stepRe.exec(raw))) {
            if (currentStep) out.steps.push(currentStep);
            currentStep = { name: m[1], exec: {}, dds: [], steplibs: [] };
            const args = m[2];
            const pgmM  = /PGM\s*=\s*([A-Z0-9#@$]+)/i.exec(args);
            const procM = /PROC\s*=\s*([A-Z0-9#@$]+)/i.exec(args);
            if (pgmM)  { currentStep.exec.pgm  = pgmM[1];  out.programs.add(pgmM[1].toUpperCase()); }
            else if (procM) { currentStep.exec.proc = procM[1]; out.procs.add(procM[1].toUpperCase()); }
            else {
                // Bare EXEC PROCNAME (no keyword)
                const bare = args.match(/^\s*([A-Z0-9#@$]+)/i);
                if (bare) { currentStep.exec.proc = bare[1]; out.procs.add(bare[1].toUpperCase()); }
            }
            continue;
        }
        if ((m = ddRe.exec(raw))) {
            const ddName = m[1];
            // JOBLIB sits BEFORE the first EXEC — we still need to
            // capture it as a job-wide library. Let JOBLIB through
            // with no currentStep; everything else requires a step.
            const upperDD = ddName.toUpperCase();
            if (!currentStep && upperDD !== 'JOBLIB') continue;
            const args = m[2];
            const dsnM  = /DSN\s*=\s*([^,\s]+)/i.exec(args);
            const dispM = /DISP\s*=\s*([A-Z0-9(),\s]+)/i.exec(args);
            const sysoutM = /SYSOUT\s*=\s*\*/i.exec(args);
            const ddEntry = {
                name: ddName,
                dsn:   dsnM ? dsnM[1] : null,
                disp:  dispM ? dispM[1].trim() : null,
                sysout: !!sysoutM
            };
            // Job-level JOBLIB (no currentStep) only contributes to
            // libraries[]; step-level DDs go into the active step's dd
            // list + dataset set.
            if (currentStep) {
                currentStep.dds.push(ddEntry);
            }
            if (ddEntry.dsn) out.datasets.add(ddEntry.dsn);
            // STEPLIB / JOBLIB → load-library hint. Both feed
            // libraries[]; only STEPLIB goes into the step's steplibs
            // (JOBLIB is job-wide, not step-scoped).
            if (upperDD === 'STEPLIB' && ddEntry.dsn && currentStep) {
                currentStep.steplibs.push(ddEntry.dsn);
                out.libraries.add(ddEntry.dsn);
            } else if (upperDD === 'JOBLIB' && ddEntry.dsn) {
                out.libraries.add(ddEntry.dsn);
            }
            continue;
        }
    }
    if (currentStep) out.steps.push(currentStep);
    out.programs  = [...out.programs];
    out.datasets  = [...out.datasets];
    out.procs     = [...out.procs];
    out.libraries = [...out.libraries];
    return out;
}

module.exports = { parseJcl };
