/**
 * POST /api/fix-java — AI-powered Java repair for a single converted file.
 *
 * Body: { conversionId, relativePath }
 *
 * Dual transport:
 *   - `Accept: text/event-stream` → streams `step` events as the repair
 *     progresses (read → probe-compile → context → AI → apply → recompile)
 *     and a final `final` event with the same payload. Keeps the UI alive
 *     during the 10–30s the AI takes.
 *   - otherwise → single JSON response with the same payload shape.
 *
 * Pipeline steps (each emits a `step` event in streaming mode):
 *   1. read COBOL source + current Java from disk
 *   2. probe-compile current Java to capture real compile errors for the prompt
 *   3. build PROGRAM-ID → Java-class map (sibling signatures context)
 *   4. call azureAgent.fixJavaCode with {code, errors, run cache, deps}
 *   5. write repaired Java, create .before-fix backup if none exists
 *   6. re-score accuracy + add "Auto-repaired" penalty
 *   7. recompile — flip COMPILE_FAIL → SUCCESS if javac now accepts it
 *
 * mount(app, deps) where deps = { activeConversions, azureAgent }.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function mount(app, deps) {
    const { activeConversions, azureAgent } = deps;

    app.post('/api/fix-java', async (req, res) => {
        const { conversionId, relativePath, runContext } = req.body || {};
        if (!conversionId || !relativePath) {
            return res.status(400).json({ success: false, error: 'conversionId and relativePath required' });
        }
        const conversion = activeConversions.get(conversionId);
        if (!conversion || !conversion.result || !conversion.result.report) {
            return res.status(404).json({ success: false, error: 'Conversion not found or not complete' });
        }
        const norm = String(relativePath).replace(/\\/g, '/');
        const entry = (conversion.result.report.files || []).find(f => (f.path || '').replace(/\\/g, '/') === norm);
        if (!entry) return res.status(404).json({ success: false, error: 'File not in report' });
        if (!entry.java_path || !fs.existsSync(entry.java_path)) {
            return res.status(400).json({ success: false, error: 'No Java file exists for this entry' });
        }

        // SSE when requested, otherwise a single JSON response at the end.
        const wantsStream = /text\/event-stream/i.test(req.headers.accept || '');
        let emit;
        if (wantsStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders && res.flushHeaders();
            emit = (type, payload) => {
                try {
                    res.write(`event: ${type}\n`);
                    res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
                } catch {}
            };
        } else {
            emit = () => {};
        }

        try {
            const t0 = Date.now();
            emit('step', { step: 'read_source', label: 'Reading COBOL + current Java from disk' });
            const cobolSource = fs.readFileSync(entry.source_path, 'utf-8');
            const javaCode = fs.readFileSync(entry.java_path, 'utf-8');
            emit('step', { step: 'source_read', label: 'Source read', ms: Date.now() - t0, cobolBytes: cobolSource.length, javaBytes: javaCode.length });

            emit('step', { step: 'probe_compile', label: 'Compiling current Java to capture errors' });
            const tProbe = Date.now();
            let compileErrors = '';
            try {
                execSync(`javac "${entry.java_path}"`, {
                    cwd: entry.work_dir || path.dirname(entry.java_path),
                    timeout: 30000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) {
                compileErrors = (e.stderr ? e.stderr.toString() : e.message) || '';
            }
            emit('step', {
                step: 'probe_done',
                label: compileErrors ? 'Compile errors captured' : 'Current Java compiles — repair will focus on semantic/accuracy',
                ms: Date.now() - tProbe,
                errorBytes: compileErrors.length,
                errorPreview: compileErrors.split('\n').slice(0, 3).join(' | ').slice(0, 300)
            });

            // Latest run outputs (if any) are cached on the conversion.
            const runCache = (conversion._lastRun && conversion._lastRun[entry.path]) || {};

            // PROGRAM-ID → Java class map. Lets the AI reference real sibling
            // classes instead of inventing names for CALL targets.
            const programIdToJavaClass = {};
            const programIdRe = /^\s*(?:\d+\s+)?PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)['"]?/im;
            for (const f of (conversion.result.report.files || [])) {
                if (!f.java_path || f === entry || !f.source_path) continue;
                const base = path.basename(f.source_path, path.extname(f.source_path)).toUpperCase();
                const javaClass = path.basename(f.java_path, '.java');
                programIdToJavaClass[base] = javaClass;
                try {
                    const src = fs.readFileSync(f.source_path, 'utf-8');
                    const m = src.match(programIdRe);
                    if (m) programIdToJavaClass[m[1].toUpperCase()] = javaClass;
                } catch {}
            }

            emit('step', {
                step: 'context_built',
                label: 'Context ready — calling AI repair agent',
                dependencies: Object.keys(programIdToJavaClass).length,
                hasRunOutput: !!(runCache.cobolOutput || runCache.javaOutput)
            });
            const tAI = Date.now();
            // Caller-supplied runContext (from the Run panel's Fix-with-AI)
            // gives the AI the comparator verdict + output files that the
            // conversion._lastRun cache doesn't carry. Fall back to the
            // cache for legacy callers that don't pass runContext.
            const rc = (runContext && typeof runContext === 'object') ? runContext : {};
            const fix = await azureAgent.fixJavaCode({
                javaCode,
                cobolSource,
                compileErrors,
                runOutput: rc.javaOutput || runCache.javaOutput || '',
                cobolOutput: rc.cobolOutput || runCache.cobolOutput || '',
                cobolError: rc.cobolError || runCache.cobolError || '',
                javaError:  rc.javaError  || runCache.javaError  || '',
                cobolOutputFiles: Array.isArray(rc.cobolOutputFiles) ? rc.cobolOutputFiles : undefined,
                javaOutputFiles:  Array.isArray(rc.javaOutputFiles)  ? rc.javaOutputFiles  : undefined,
                comparatorVerdict: rc.verdict || null,
                dependencies: programIdToJavaClass,
                // Called right before the AI request goes out. Lets us ship
                // the full prompt to the UI as a debugging attachment so the
                // user can inspect exactly what the model saw when a fix
                // produces an unexpected result.
                onPromptReady: ({ systemPrompt, userPrompt }) => {
                    emit('prompt', {
                        systemPrompt,
                        userPrompt,
                        systemBytes: systemPrompt.length,
                        userBytes: userPrompt.length
                    });
                }
            });
            emit('step', {
                step: 'ai_done',
                label: fix.success ? 'AI returned repaired Java' : 'AI repair failed',
                ms: Date.now() - tAI,
                tokens: fix.usage ? (fix.usage.total_tokens || fix.usage.totalTokens || null) : null,
                javaBytes: fix.javaCode ? fix.javaCode.length : 0,
                error: fix.success ? null : fix.error
            });

            if (!fix.success) {
                const payload = { success: false, error: fix.error || 'Fix failed' };
                if (wantsStream) { emit('final', payload); return res.end(); }
                return res.status(500).json(payload);
            }

            // Keep a single .before-fix backup so the user can always undo to
            // whatever the original AI output was — subsequent fixes overwrite
            // each other, not the pristine original.
            emit('step', { step: 'apply', label: 'Writing repaired Java to disk + creating backup' });
            const backupPath = entry.java_path.replace(/\.java$/i, '.java.before-fix');
            if (!fs.existsSync(backupPath)) {
                try { fs.copyFileSync(entry.java_path, backupPath); } catch {}
            }
            fs.writeFileSync(entry.java_path, fix.javaCode, 'utf-8');
            // Also update the per-file work_dir copy — /api/run compiles
            // FROM there, not from javaDir. Without this, fixes appear to
            // land (javaDir has the new code, Java pane refreshes, accuracy
            // re-scores) but the next Run still executes the pre-fix
            // workDir copy. User-reported on DEPTPAY: fix-with-AI
            // produced the correct formatPIC9_7V99WithDecimal but Run kept
            // showing the stale formatPIC9_7V99 output.
            if (entry.work_dir) {
                const workCopy = path.join(entry.work_dir, path.basename(entry.java_path));
                try { fs.writeFileSync(workCopy, fix.javaCode, 'utf-8'); } catch {}
                // Drop stale .class too so the next javac run doesn't use
                // the old bytecode against a changed source (rare but
                // possible if javac fails mid-repair).
                const staleClass = workCopy.replace(/\.java$/i, '.class');
                try { fs.existsSync(staleClass) && fs.unlinkSync(staleClass); } catch {}
            }

            // Flag the file as auto-repaired so the browser shows the penalty.
            if (entry.accuracyBreakdown) {
                entry.accuracyBreakdown.semanticPenalties = [
                    ...(entry.accuracyBreakdown.semanticPenalties || []),
                    'Auto-repaired by Fix Java agent'
                ];
            }

            try {
                const acc = azureAgent.analyzeConversionAccuracy(cobolSource, fix.javaCode);
                if (acc && typeof acc.accuracy === 'number') {
                    entry.conversionAccuracy = acc.accuracy;
                    entry.accuracyDetails = acc.details || [];
                    entry.accuracyBreakdown = {
                        cobolMetrics: acc.cobolMetrics,
                        javaMetrics: acc.javaMetrics,
                        semanticPenalties: acc.semanticPenalties || []
                    };
                }
            } catch {}

            // Recompile post-fix so the response tells the user whether the
            // repair ACTUALLY compiles — previously the endpoint returned
            // success as soon as the AI produced anything, leaving users to
            // discover compile errors only on the next Run panel click.
            emit('step', { step: 'recompile', label: 'Recompiling the repaired Java' });
            const tRe = Date.now();
            let compileStatus = 'unknown';
            let compileError = null;
            try {
                const workDir = path.dirname(entry.java_path);
                try {
                    execSync(`javac "${entry.java_path}"`, {
                        cwd: workDir,
                        timeout: 30000,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                    compileStatus = 'ok';
                    if (entry.java_status === 'COMPILE_FAIL') {
                        entry.java_status = 'SUCCESS';
                        entry.error = undefined;
                    }
                } catch (compileErr) {
                    compileStatus = 'fail';
                    compileError = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
                    entry.java_status = 'COMPILE_FAIL';
                    entry.error = compileError;
                }
            } catch (recompileOuterErr) {
                // If the recompile wrapper itself blew up, surface it instead of
                // masking it as a fix failure.
                compileStatus = 'unknown';
                compileError = recompileOuterErr.message;
            }
            emit('step', {
                step: 'recompile_done',
                label: 'Recompile complete: ' + compileStatus,
                ms: Date.now() - tRe,
                compileStatus,
                errorPreview: compileError ? String(compileError).split('\n').slice(0, 3).join(' | ').slice(0, 300) : null
            });

            const payload = {
                success: true,
                applied: true,
                newJavaCode: fix.javaCode,
                backupPath: path.basename(backupPath),
                newAccuracy: entry.conversionAccuracy,
                compileStatus,
                compileError,
                newJavaStatus: entry.java_status,
                usage: fix.usage || null
            };
            if (wantsStream) { emit('final', payload); return res.end(); }
            res.json(payload);
        } catch (err) {
            const payload = { success: false, error: err.message };
            if (wantsStream) { emit('final', payload); return res.end(); }
            res.status(500).json(payload);
        }
    });
}

module.exports = { mount };
