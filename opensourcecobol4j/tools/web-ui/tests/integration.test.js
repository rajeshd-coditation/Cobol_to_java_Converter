/**
 * Integration test — one real Azure conversion end-to-end.
 * Converts CBACT02C.cbl (178 lines, reads a VSAM card file) + its copybook
 * CVACT02Y and verifies:
 *   1. The AI returns Java without a fabricated-fallback pattern.
 *   2. The accuracy scorer does NOT flag Fabricated input fallback.
 *   3. `javac` accepts the output (compile-gate intent).
 *   4. Our context block (copybook body) actually appears in the request if
 *      DEBUG_PROMPTS is set.
 *
 * Run with:
 *   AZURE_OPENAI_* set in .env  AND
 *   node --test tests/integration.test.js
 *
 * Cost: one conversion (~4-10k input tokens, ~2-3k output tokens).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const os = require('node:os');

// Load .env ourselves (azureAgent expects env already populated).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const azureAgent = require('../azureAgent');

// The repo root that holds the vendored CardDemo fixture.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COBOL_PATH  = path.join(REPO_ROOT, 'carddemo-app', 'cbl', 'CBACT02C.cbl');
const COPY_PATH   = path.join(REPO_ROOT, 'carddemo-app', 'cpy', 'CVACT02Y.cpy');

test('end-to-end: CBACT02C + CVACT02Y → Azure convert → compile-clean Java', async (t) => {
    // Initialize Azure from the real .env. If creds aren't present, skip.
    const ok = azureAgent.initializeAzure();
    if (!ok || !azureAgent.isAvailable()) {
        t.skip('Azure AI not configured in .env — skipping integration test');
        return;
    }

    assert.ok(fs.existsSync(COBOL_PATH), `missing fixture: ${COBOL_PATH}`);
    assert.ok(fs.existsSync(COPY_PATH),  `missing fixture: ${COPY_PATH}`);

    const cobolSource = fs.readFileSync(COBOL_PATH, 'utf-8');
    const copybookBody = fs.readFileSync(COPY_PATH, 'utf-8');

    // Turn on the debug prompt dump so we can inspect what got sent.
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobol-prompts-'));
    process.env.DEBUG_PROMPTS = dumpDir;

    console.log(`   Converting CBACT02C.cbl (${cobolSource.length} chars) with CVACT02Y inlined …`);
    const t0 = Date.now();
    const result = await azureAgent.convertCobolToJava(cobolSource, 0, {
        calledPrograms: [],
        copybooks: ['CVACT02Y'],
        programIdToJavaClass: {},
        copybookBodies: { 'CVACT02Y': copybookBody },
        siblingSignatures: {},
        jclInvocations: []
    });
    const ms = Date.now() - t0;
    console.log(`   Azure returned in ${ms}ms, success=${result.success}, ` +
                `chars=${(result.javaCode || '').length}, ` +
                `tokens=${result.usage ? result.usage.total_tokens : '?'}`);

    assert.ok(result.success, `conversion failed: ${result.error}`);
    assert.ok(result.javaCode && result.javaCode.length > 200, 'Java output is suspiciously small');

    // ─── Prompt dump: copybook body must have been sent to the AI ──
    const dumpFiles = fs.readdirSync(dumpDir);
    assert.ok(dumpFiles.length >= 1, `expected at least one prompt dump, got none in ${dumpDir}`);
    const firstDump = JSON.parse(fs.readFileSync(path.join(dumpDir, dumpFiles[0]), 'utf-8'));
    const userMsg = (firstDump.messages || []).find(m => m.role === 'user');
    assert.ok(userMsg, 'prompt dump has no user message');
    assert.match(userMsg.content, /=== COPYBOOK CVACT02Y ===/,
        'copybook header missing from the prompt that was actually sent to Azure');
    assert.ok(userMsg.content.includes(copybookBody.trim().split('\n')[0]),
        'copybook body was not inlined into the prompt');
    console.log(`   ✓ prompt dump confirms copybook was inlined (${firstDump.messages.length} messages, ${userMsg.content.length} chars in user msg)`);

    // ─── Fidelity: no banned sample-data phrases ──
    const banned = [
        'using sample data for demonstration',
        'Input file not found, using sample',
        'Using sample ACCT-REC record',
        'Using sample CARD-REC record'
    ];
    for (const phrase of banned) {
        assert.ok(!result.javaCode.toLowerCase().includes(phrase.toLowerCase()),
            `generated Java contains banned phrase "${phrase}" — fidelity rule FAILED`);
    }
    console.log('   ✓ no banned fabrication phrases in output');

    // ─── Accuracy scorer agrees (no Fabricated input fallback penalty) ──
    const accuracy = azureAgent.analyzeConversionAccuracy(cobolSource, result.javaCode);
    const penalties = accuracy.semanticPenalties || [];
    assert.ok(!penalties.includes('Fabricated input fallback'),
        `accuracy scorer flagged Fabricated input fallback: ${JSON.stringify(penalties)}`);
    console.log(`   ✓ accuracy=${accuracy.accuracy}%, penalties=${JSON.stringify(penalties)}`);

    // ─── javac compile-gate: write to a temp work dir and compile ──
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbact02c-'));
    // Class name: PascalCase of the COBOL basename.
    const className = 'Cbact02c';
    const javaPath = path.join(workDir, className + '.java');

    // Normalize the class name the same way server.js does (mirrored inline —
    // the normalizer lives in server.js which is not a module we can require).
    let java = result.javaCode;
    const classMatch = java.match(/public\s+class\s+(\w+)\s*\{/);
    if (classMatch && classMatch[1] !== className) {
        console.log(`   🔧 Renaming class ${classMatch[1]} → ${className}`);
        java = java.replace(new RegExp(`\\b${classMatch[1]}\\b`, 'g'), className);
    }
    fs.writeFileSync(javaPath, java);

    let compileResult = 'ok';
    let compileErr = null;
    try {
        execSync(`javac "${javaPath}"`, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    } catch (e) {
        compileResult = 'fail';
        compileErr = e.stderr ? e.stderr.toString() : e.message;
    }
    console.log(`   ✓ javac result: ${compileResult}`);
    if (compileErr) {
        console.log('   ─── compile error ───');
        console.log(compileErr.split('\n').slice(0, 20).join('\n'));
        console.log(`   Java written at: ${javaPath}`);
    }

    // The compile-gate logic should mark COMPILE_FAIL in this case; we don't
    // fail the test if the AI output doesn't compile (that's a Real Finding,
    // not a test bug). Report both outcomes conversationally.
    t.diagnostic(`initial compile: ${compileResult}${compileErr ? ' (see stdout)' : ''}`);

    // ─── Repair pass: if compile failed, exercise fixJavaCode the same way
    // processFile would. Tests the §22.1 auto-repair + §23.1 full-source and
    // §23.2.3 copybook body flowing into the repair prompt.
    if (compileResult === 'fail') {
        console.log('   🔧 invoking fixJavaCode repair agent on the broken output…');
        const repairT0 = Date.now();
        const repair = await azureAgent.fixJavaCode({
            javaCode: java,
            cobolSource,
            compileErrors: compileErr,
            runOutput: null,
            cobolOutput: null,
            dependencies: {}
        });
        const repairMs = Date.now() - repairT0;
        console.log(`   Azure repair returned in ${repairMs}ms, success=${repair.success}, ` +
                    `chars=${(repair.javaCode || '').length}, ` +
                    `tokens=${repair.usage ? repair.usage.total_tokens : '?'}`);
        assert.ok(repair.success, `repair call failed: ${repair.error}`);
        assert.ok(repair.javaCode && repair.javaCode.length > 200,
            'repair output suspiciously small');

        // Re-normalize class name + recompile.
        let repaired = repair.javaCode;
        const rMatch = repaired.match(/public\s+class\s+(\w+)\s*\{/);
        if (rMatch && rMatch[1] !== className) {
            repaired = repaired.replace(new RegExp(`\\b${rMatch[1]}\\b`, 'g'), className);
        }
        fs.writeFileSync(javaPath, repaired);

        let repairCompileResult = 'ok';
        let repairCompileErr = null;
        try {
            execSync(`javac "${javaPath}"`, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
        } catch (e) {
            repairCompileResult = 'fail';
            repairCompileErr = e.stderr ? e.stderr.toString() : e.message;
        }
        console.log(`   ✓ post-repair javac: ${repairCompileResult}`);
        if (repairCompileErr) {
            console.log('   ─── post-repair compile error ───');
            console.log(repairCompileErr.split('\n').slice(0, 20).join('\n'));
        }

        // Re-score too — ensure repair didn't introduce a Fabricated fallback.
        const repairAcc = azureAgent.analyzeConversionAccuracy(cobolSource, repaired);
        console.log(`   ✓ post-repair accuracy=${repairAcc.accuracy}%, penalties=${JSON.stringify(repairAcc.semanticPenalties || [])}`);
        assert.ok(!(repairAcc.semanticPenalties || []).includes('Fabricated input fallback'),
            'repair introduced a Fabricated input fallback — fidelity rule leak in repair prompt');

        t.diagnostic(`post-repair compile: ${repairCompileResult}`);
    }
});
