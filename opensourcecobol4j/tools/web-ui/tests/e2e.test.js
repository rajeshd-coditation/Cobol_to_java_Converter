/**
 * End-to-end test: spawns server.js as a subprocess on a free port, then
 * drives a real conversion via the same HTTP endpoints the UI uses:
 *   POST /api/scan-repo    → file list
 *   POST /api/convert-azure → kick off background conversion
 *   GET  /api/status/:id   → poll until completed
 *
 * Verifies the assembled pipeline — scan → graph → wave → convert →
 * compile-gate → auto-repair → score → write — behaves correctly against
 * a real CardDemo fixture. This is the "live processFile orchestration"
 * test that couldn't be covered by pure-function tests.
 *
 * Cost: ~1-3 conversions (~8-25k tokens depending on AI variance).
 * Picks the smallest CardDemo program (COBSWAIT.cbl, 41 lines).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WEB_UI    = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────

function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

async function waitForServer(port, maxWaitMs = 30000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/ai/provider`);
            if (r.ok) return true;
        } catch {} // connection refused while booting
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function postJson(url, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
}

async function getJson(url) {
    const r = await fetch(url);
    return { status: r.status, body: await r.json() };
}

// ─── The test ─────────────────────────────────────────────────────────────

test('e2e: scan → convert → poll → verify report on a minimal CardDemo fixture', async (t) => {
    // Skip gracefully if .env doesn't have Azure creds — no point burning time
    // spawning the server only to fail on the first API call.
    const envPath = path.join(WEB_UI, '.env');
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    if (!/AZURE_OPENAI_API_KEY\s*=\s*\S/.test(envText)) {
        t.skip('Azure creds not in .env — skipping e2e');
        return;
    }

    // Stage a minimal input dir containing exactly one small COBOL program.
    // Using a tmp copy keeps the CardDemo fixture untouched and scopes the
    // conversion to one file (cheaper + faster + deterministic).
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-input-'));
    const cobolSrc = path.join(REPO_ROOT, 'carddemo-app', 'cbl', 'COBSWAIT.cbl');
    assert.ok(fs.existsSync(cobolSrc), `fixture missing: ${cobolSrc}`);
    fs.copyFileSync(cobolSrc, path.join(inputDir, 'COBSWAIT.cbl'));
    console.log(`   staged input dir: ${inputDir}`);

    const port = await findFreePort();
    console.log(`   spawning server on port ${port} …`);

    // Spawn server.js as a subprocess. Inherit env plus our PORT override.
    const srv = spawn('node', ['server.js'], {
        cwd: WEB_UI,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const serverLogs = [];
    srv.stdout.on('data', d => serverLogs.push(d.toString()));
    srv.stderr.on('data', d => serverLogs.push('[ERR] ' + d.toString()));

    // Guarantee cleanup regardless of how the test exits.
    const cleanup = () => {
        try { srv.kill('SIGTERM'); } catch {}
        try { fs.rmSync(inputDir, { recursive: true, force: true }); } catch {}
    };
    t.after(cleanup);

    const up = await waitForServer(port);
    if (!up) {
        console.log('─── server logs ───');
        console.log(serverLogs.join('').slice(-2000));
        assert.fail('server did not come up in 30s');
    }
    console.log('   server is up');

    const base = `http://127.0.0.1:${port}`;

    // 1. Scan the tmp input dir. The endpoint names the field `repoUrl` even
    //    when it's a local path — if the string doesn't start with http/git@
    //    the server treats it as a pre-existing directory (no clone).
    const scan = await postJson(`${base}/api/scan-repo`, { repoUrl: inputDir });
    assert.equal(scan.status, 200, `scan failed: ${JSON.stringify(scan.body).slice(0, 200)}`);
    assert.ok(scan.body.ok, `scan not ok: ${JSON.stringify(scan.body)}`);
    const cobolEntry = (scan.body.files || []).find(f => f.type === 'cobol' && f.path === 'COBSWAIT.cbl');
    assert.ok(cobolEntry, `expected COBSWAIT.cbl in scan results, got: ${JSON.stringify(scan.body.files)}`);
    console.log(`   ✓ scan returned ${scan.body.counts.cobol} COBOL file(s)`);

    // 2. Kick off conversion.
    const convert = await postJson(`${base}/api/convert-azure`, {
        repoUrl: inputDir,
        selectedFiles: ['COBSWAIT.cbl']
    });
    assert.equal(convert.status, 200, `convert-azure failed: ${JSON.stringify(convert.body).slice(0, 200)}`);
    const conversionId = convert.body.conversionId;
    assert.ok(conversionId, 'expected conversionId in response');
    console.log(`   ✓ conversion started: ${conversionId}`);

    // 3. Poll until completed (or 5-minute deadline).
    const deadline = Date.now() + 300000;
    let status = null;
    while (Date.now() < deadline) {
        const s = await getJson(`${base}/api/status/${conversionId}`);
        status = s.body;
        if (status && (status.status === 'completed' || status.status === 'failed')) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    assert.ok(status, 'status never materialized');
    assert.equal(status.status, 'completed', `conversion did not complete: ${JSON.stringify(status).slice(0, 400)}`);
    console.log(`   ✓ conversion completed (${status.files ? status.files.length : '?'} files)`);

    // 4. Inspect the report for the pipeline's verdict.
    const report = status.result && status.result.report;
    assert.ok(report, `no report in status payload: ${JSON.stringify(status).slice(0, 400)}`);
    assert.ok(Array.isArray(report.files) && report.files.length >= 1, 'report has no files');

    const entry = report.files.find(f => f.path === 'COBSWAIT.cbl') || report.files[0];
    console.log(`   ✓ report entry:\n       java_status=${entry.java_status}\n       compare=${entry.compare}\n       conversionAccuracy=${entry.conversionAccuracy}%\n       repair_applied=${entry.repair_applied || 'none'}\n       penalties=${JSON.stringify((entry.accuracyBreakdown && entry.accuracyBreakdown.semanticPenalties) || [])}`);

    // Core assertion: the entry reached a DETERMINED outcome.
    // SUCCESS = Java output compiles (compile-gate accepted it, possibly
    //           after auto-repair).
    // COMPILE_FAIL = Java still doesn't compile even after any repair pass;
    //                includes the real javac error on entry.error.
    // Anything else is a bug. Notably: must NOT be "SUCCESS with hidden
    // compile error" — which is the pre-§22.1 state.
    const acceptableStatuses = new Set(['SUCCESS', 'COMPILE_FAIL', 'CONVERT_FAIL']);
    assert.ok(acceptableStatuses.has(entry.java_status),
        `unexpected java_status: ${entry.java_status}`);

    if (entry.java_status === 'SUCCESS') {
        // The compile-gate says the file compiles. Verify it's actually on disk.
        assert.ok(entry.java_path && fs.existsSync(entry.java_path),
            `SUCCESS but java_path missing: ${entry.java_path}`);
        const javaSrc = fs.readFileSync(entry.java_path, 'utf-8');
        // Fidelity: must not contain any of the banned fabrication phrases.
        const banned = [
            'using sample data for demonstration',
            'Using sample CARDFILE record',
            'Input file not found, using sample'
        ];
        for (const phrase of banned) {
            assert.ok(!javaSrc.toLowerCase().includes(phrase.toLowerCase()),
                `generated Java contains banned phrase "${phrase}"`);
        }
        // And we must NOT have the accuracy penalty for fabricated fallback.
        const penalties = (entry.accuracyBreakdown && entry.accuracyBreakdown.semanticPenalties) || [];
        assert.ok(!penalties.includes('Fabricated input fallback'),
            `SUCCESS path carries Fabricated input fallback penalty: ${JSON.stringify(penalties)}`);
        console.log('   ✓ SUCCESS path: Java on disk, no banned phrases, no fabrication penalty');
    } else if (entry.java_status === 'COMPILE_FAIL') {
        // Compile-gate correctly surfaces the failure instead of hiding it.
        assert.ok(entry.error && entry.error.length > 0,
            'COMPILE_FAIL but no error text captured');
        console.log(`   ✓ COMPILE_FAIL path: error preserved (${entry.error.length} chars of javac output)`);
    } else if (entry.java_status === 'CONVERT_FAIL') {
        // AI call itself failed — rare, but acceptable. Error must be recorded.
        assert.ok(entry.error);
        console.log(`   ✓ CONVERT_FAIL path: upstream AI error recorded`);
    }

    // Token accounting was actually wired. Tokens live on `conversion.tokens`
    // (top-level on the status payload, not under `result`).
    assert.ok(status.tokens && status.tokens.total > 0,
        `no token usage recorded — accounting is broken: ${JSON.stringify(status.tokens)}`);
    console.log(`   ✓ tokens used: ${status.tokens.total} across ${status.tokens.calls} AI call(s)`);

    // repair_applied must be one of the known tags (or null/undefined).
    if (entry.repair_applied) {
        assert.ok(['compile', 'fallback', 'compile+fallback'].includes(entry.repair_applied),
            `unknown repair_applied tag: ${entry.repair_applied}`);
        console.log(`   ✓ auto-repair fired: ${entry.repair_applied}`);
    }
});
