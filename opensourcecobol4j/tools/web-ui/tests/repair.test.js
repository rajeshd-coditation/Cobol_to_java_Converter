/**
 * Deterministic test of the auto-repair path: injects a Java file with a
 * KNOWN compile error and asks fixJavaCode() to fix it. Verifies:
 *   - repair returns success + compilable Java
 *   - repair does NOT introduce a fabricated fallback
 *   - the COBOL source is sent IN FULL (not truncated), which is the
 *     §23.1 guarantee (middle-of-file bugs need full visibility)
 *
 * Cost: one Azure call (~5-8k tokens). Uses a small CardDemo program so
 * the prompt is bounded.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const os = require('node:os');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const azureAgent = require('../azureAgent');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COBOL_PATH = path.join(REPO_ROOT, 'carddemo-app', 'cbl', 'CBACT02C.cbl');

// Known-broken Java — the exact pattern our first integration run produced.
// `throws` is only valid on a method signature; seeing it inside an `if` is a
// real AI failure mode we observed. If the repair agent can fix this, the
// compile-gate pipeline works.
const BROKEN_JAVA = `
import java.io.*;
import java.util.*;

public class Cbact02c {
    public static void main(String[] args) {
        System.out.println("=== Program Started ===");
        try {
            readCardFile();
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(1);
        }
        System.out.println("=== Program Completed ===");
    }

    static void readCardFile() {
        String cardRecord = "10000001";
        // BUG: 'throws' is not valid here — this is what the AI produced once.
        if (cardRecord != null) throws java.io.IOException {
            System.out.println("Card: " + cardRecord);
        }
    }
}
`;

test('fixJavaCode repairs a known compile-error pattern from a CardDemo conversion', async (t) => {
    const ok = azureAgent.initializeAzure();
    if (!ok || !azureAgent.isAvailable()) {
        t.skip('Azure AI not configured');
        return;
    }

    assert.ok(fs.existsSync(COBOL_PATH));
    const cobolSource = fs.readFileSync(COBOL_PATH, 'utf-8');

    // First: confirm the input genuinely doesn't compile.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-test-'));
    const javaPath = path.join(workDir, 'Cbact02c.java');
    fs.writeFileSync(javaPath, BROKEN_JAVA);
    let initialCompile = 'ok';
    let initialErr = null;
    try {
        execSync(`javac "${javaPath}"`, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    } catch (e) {
        initialCompile = 'fail';
        initialErr = e.stderr ? e.stderr.toString() : e.message;
    }
    assert.equal(initialCompile, 'fail', 'fixture must start as a compile failure');
    console.log(`   ✓ fixture fails javac as expected:\n${initialErr.split('\n')[0]}`);

    // Enable prompt dumping so we can verify the COBOL is sent in full.
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-prompts-'));
    process.env.DEBUG_PROMPTS = dumpDir;

    console.log('   🔧 invoking fixJavaCode repair agent …');
    const t0 = Date.now();
    const repair = await azureAgent.fixJavaCode({
        javaCode: BROKEN_JAVA,
        cobolSource,
        compileErrors: initialErr,
        runOutput: null,
        cobolOutput: null,
        dependencies: {}
    });
    const ms = Date.now() - t0;
    console.log(`   Azure returned in ${ms}ms, success=${repair.success}, ` +
                `chars=${(repair.javaCode || '').length}, ` +
                `tokens=${repair.usage ? repair.usage.total_tokens : '?'}`);

    assert.ok(repair.success, `repair call failed: ${repair.error}`);
    assert.ok(repair.javaCode && repair.javaCode.length > 200,
        'repair output is suspiciously small');

    // Verify the prompt actually carried the full COBOL source (§23.1).
    const dumpFiles = fs.readdirSync(dumpDir);
    assert.ok(dumpFiles.length >= 1, 'expected a prompt dump');
    const dump = JSON.parse(fs.readFileSync(path.join(dumpDir, dumpFiles[0]), 'utf-8'));
    const userMsg = (dump.messages || []).find(m => m.role === 'user');
    assert.ok(userMsg, 'prompt dump missing user message');
    // The real COBOL has a distinctive tail; assert the full-length end made it in.
    const tail = cobolSource.trim().slice(-200);
    assert.ok(userMsg.content.includes(tail.split('\n').slice(-3).join('\n').trim().slice(0, 50)),
        'repair prompt did NOT include the end of the COBOL source — truncation regression!');
    console.log(`   ✓ prompt dump confirms full COBOL source was sent (${userMsg.content.length} chars)`);

    // Normalize class name and recompile.
    let repaired = repair.javaCode;
    const rMatch = repaired.match(/public\s+class\s+(\w+)\s*\{/);
    if (rMatch && rMatch[1] !== 'Cbact02c') {
        console.log(`   🔧 renamed class ${rMatch[1]} → Cbact02c`);
        repaired = repaired.replace(new RegExp(`\\b${rMatch[1]}\\b`, 'g'), 'Cbact02c');
    }
    fs.writeFileSync(javaPath, repaired);

    let finalCompile = 'ok';
    let finalErr = null;
    try {
        execSync(`javac "${javaPath}"`, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    } catch (e) {
        finalCompile = 'fail';
        finalErr = e.stderr ? e.stderr.toString() : e.message;
    }
    console.log(`   ✓ post-repair javac: ${finalCompile}`);
    if (finalErr) {
        console.log('   ─── post-repair compile error ───');
        console.log(finalErr.split('\n').slice(0, 25).join('\n'));
    }
    assert.equal(finalCompile, 'ok',
        `repair should produce COMPILING Java; got javac failure:\n${finalErr}`);

    // Scoring: the repair must not introduce a fabricated fallback.
    const acc = azureAgent.analyzeConversionAccuracy(cobolSource, repaired);
    console.log(`   ✓ post-repair accuracy=${acc.accuracy}%, penalties=${JSON.stringify(acc.semanticPenalties || [])}`);
    assert.ok(!(acc.semanticPenalties || []).includes('Fabricated input fallback'),
        'repair introduced a Fabricated input fallback');

    // Also: the broken `throws` pattern must be gone.
    assert.doesNotMatch(repaired, /if\s*\([^)]+\)\s+throws/,
        'repair did not remove the "if (…) throws" construct');
});
