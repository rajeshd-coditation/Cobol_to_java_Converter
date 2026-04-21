/**
 * Compile-gate for the local `cobj` conversion path.
 *
 * Runs javac against every SUCCESS entry in a conversion's report. If javac
 * fails, flip the entry to COMPILE_FAIL with the real error text so the UI
 * surfaces it instead of showing a green checkmark on a broken file.
 *
 * The Azure path has its own in-line gate in processFile (with auto-repair);
 * this is the fallback for the local cobj flow where there's no repair agent.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCompileGateOnReport(result) {
    if (!result || !result.report || !Array.isArray(result.report.files)) return;
    for (const entry of result.report.files) {
        if (entry.java_status !== 'SUCCESS' || !entry.java_path) continue;
        if (!fs.existsSync(entry.java_path)) continue;
        try {
            execSync(`javac "${entry.java_path}"`, {
                cwd: path.dirname(entry.java_path),
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (compileErr) {
            const err = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
            entry.java_status = 'COMPILE_FAIL';
            entry.error = err;
            // Keep summary counters honest — KPIs would otherwise lie.
            if (result.report.summary) {
                result.report.summary.fail_compile = (result.report.summary.fail_compile || 0) + 1;
                if (result.report.summary.success_java_only > 0) {
                    result.report.summary.success_java_only--;
                }
            }
        }
    }
}

module.exports = { runCompileGateOnReport };
