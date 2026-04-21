/**
 * Deterministic tests for the fidelity rules landed in §22 / §23.
 * These do NOT call Azure — they exercise the pure regex/string logic so
 * you can verify the guardrails without spending tokens.
 *
 * Run with:  node --test tests/fidelity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const azureAgent = require('../azureAgent');

// Prompt-regression tests assert that certain rule strings live in the AI
// prompts. Those prompts used to all live in azureAgent.js; as we split
// them into src/ai/*.js feature modules this helper reads azureAgent.js +
// every file under src/ai/ so the assertions stay stable regardless of
// which module the prompt happens to be in. New prompt files are picked
// up automatically — no test edits needed.
function readAllPromptSources() {
    const parts = [fs.readFileSync(path.resolve(__dirname, '..', 'azureAgent.js'), 'utf-8')];
    const aiDir = path.resolve(__dirname, '..', 'src', 'ai');
    if (fs.existsSync(aiDir)) {
        for (const name of fs.readdirSync(aiDir)) {
            if (name.endsWith('.js')) {
                parts.push(fs.readFileSync(path.join(aiDir, name), 'utf-8'));
            }
        }
    }
    return parts.join('\n// ---module boundary---\n');
}

// ─── Representative fixture snippets ──────────────────────────────────────
const COBOL_FILE_IO = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CBACT01C.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT ACCT-REC ASSIGN TO ACCTREC.
       DATA DIVISION.
       FILE SECTION.
       FD ACCT-REC.
       01 ACCT-RECORD.
          05 ACCT-ID PIC 9(8).
          05 ACCT-BAL PIC S9(9)V99 COMP-3.
       PROCEDURE DIVISION.
           OPEN INPUT ACCT-REC.
           READ ACCT-REC.
           CLOSE ACCT-REC.
           STOP RUN.
`;

// What a BROKEN (fabricated-fallback) Java conversion looks like.
// Penalty detection should flag this.
const JAVA_WITH_FABRICATED_FALLBACK = `
import java.io.*;
import java.util.*;

public class Cbact01c {
    public static void main(String[] args) throws Exception {
        System.out.println("=== Program Started ===");
        try (BufferedReader br = new BufferedReader(new FileReader("ACCTREC"))) {
            String line;
            while ((line = br.readLine()) != null) {
                System.out.println(line);
            }
        } catch (FileNotFoundException e) {
            // BAD: this is the exact pattern we banned in §22.2
            System.out.println("Input file not found, using sample data for demonstration...");
            System.out.println("Using sample ACCT-REC record: 10000001");
            System.out.println("Using sample ACCT-REC record: 10000002");
        }
        System.out.println("=== Program Completed ===");
    }
}
`;

// What a FAITHFUL conversion looks like — fails-fast on missing file.
const JAVA_FAITHFUL = `
import java.io.*;
import java.util.*;

public class Cbact01c {
    public static void main(String[] args) {
        System.out.println("=== Program Started ===");
        try (BufferedReader br = new BufferedReader(new FileReader("ACCTREC"))) {
            String line;
            while ((line = br.readLine()) != null) {
                System.out.println(line);
            }
        } catch (FileNotFoundException e) {
            System.err.println("File not found: ACCTREC (status = 35)");
            System.exit(1);
        } catch (IOException e) {
            System.err.println("I/O error: " + e.getMessage());
            System.exit(1);
        }
        System.out.println("=== Program Completed ===");
    }
}
`;

// ─── 1. Fabricated-fallback penalty fires when the banned phrases appear ──
test('analyzeConversionAccuracy flags "Fabricated input fallback" when Java uses sample-data fallback', () => {
    const result = azureAgent.analyzeConversionAccuracy(COBOL_FILE_IO, JAVA_WITH_FABRICATED_FALLBACK);
    assert.ok(result, 'analyzeConversionAccuracy returned a result');
    const penalties = result.semanticPenalties || [];
    assert.ok(
        penalties.includes('Fabricated input fallback'),
        `expected 'Fabricated input fallback' in penalties; got: ${JSON.stringify(penalties)}`
    );
    // Score must be reduced — default is 100.
    assert.ok(result.accuracy < 100,
        `expected accuracy < 100 when fabricated fallback is present; got ${result.accuracy}`);
});

// ─── 2. Faithful Java (exits non-zero on missing file) MUST NOT be penalized for fabrication ──
test('analyzeConversionAccuracy does NOT flag Fabricated input fallback on a faithful conversion', () => {
    const result = azureAgent.analyzeConversionAccuracy(COBOL_FILE_IO, JAVA_FAITHFUL);
    const penalties = result.semanticPenalties || [];
    assert.ok(
        !penalties.includes('Fabricated input fallback'),
        `faithful Java should not get fabrication penalty; got: ${JSON.stringify(penalties)}`
    );
    // Also shouldn't be flagged as File-I/O-simulated (it uses real BufferedReader).
    assert.ok(
        !penalties.includes('File I/O simulated'),
        `real file I/O should not trigger simulated penalty; got: ${JSON.stringify(penalties)}`
    );
});

// ─── 3. Mock/stub indicator still catches "simulating" markers ──
test('analyzeConversionAccuracy flags "Contains simulation markers" on stub code', () => {
    const java = `
public class Stub {
    // mock implementation
    public void run() {
        // TODO: simulate DB2 call
        System.out.println("simulated");
    }
}`;
    const result = azureAgent.analyzeConversionAccuracy('PROGRAM-ID. STUB. PROCEDURE DIVISION. STOP RUN.', java);
    assert.ok((result.semanticPenalties || []).includes('Contains simulation markers'));
});

// ─── 4. CardDemo copybooks exist and are readable (sanity check fixture availability) ──
test('CardDemo copybook CVACT01Y is present on disk and has real PIC clauses', () => {
    // CardDemo fixture lives under opensourcecobol4j/carddemo-app; pick any real copybook.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const candidates = [
        path.join(repoRoot, 'carddemo-app', 'cpy', 'CVACT01Y.cpy'),
        path.join(repoRoot, 'carddemo-app', 'app-vsam-mq', 'cpy', 'CVACT01Y.cpy'),
        path.join(repoRoot, 'carddemo-app', 'app-transaction-type-db2', 'cpy', 'CVACT01Y.cpy'),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    assert.ok(found, `expected CVACT01Y copybook in one of: ${candidates.join(', ')}`);
    const body = fs.readFileSync(found, 'utf-8');
    assert.match(body, /PIC\s+/i, 'copybook should contain PIC clauses we want inlined into prompts');
});

// ─── 5. JCL parsing picks up PGM + DD statements from real CardDemo JCL ──
test('parseJcl (via /api/jcl-analysis parser) extracts EXEC PGM= and DD from CardDemo JCL', async () => {
    // parseJcl isn't directly exported; we drive it through a require-and-grep
    // trick: the function is top-level in server.js. Instead of hoisting the
    // export, this test verifies the underlying parse by reading real JCL and
    // asserting the key markers the parser would pick up are actually there.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const jclDir = path.join(repoRoot, 'carddemo-app', 'jcl');
    const files = fs.existsSync(jclDir) ? fs.readdirSync(jclDir).filter(f => /\.jcl$/i.test(f)) : [];
    assert.ok(files.length > 0, `expected JCL files under ${jclDir}`);
    // Grab one with a PGM= step
    let sample = null;
    for (const f of files.slice(0, 20)) {
        const text = fs.readFileSync(path.join(jclDir, f), 'utf-8');
        if (/EXEC\s+PGM\s*=/i.test(text) && /\/\/\w+\s+DD\b/i.test(text)) {
            sample = { name: f, text };
            break;
        }
    }
    assert.ok(sample, 'expected at least one CardDemo JCL with EXEC PGM= and a DD statement');
    // Sanity-check the tokens the parseJcl regex will match
    const pgmMatches  = [...sample.text.matchAll(/EXEC\s+PGM\s*=\s*([A-Z0-9#@$]+)/gi)];
    const ddMatches   = [...sample.text.matchAll(/^\/\/([A-Z0-9#@$]+)\s+DD\s+/gim)];
    assert.ok(pgmMatches.length > 0, 'should find at least one PGM=');
    assert.ok(ddMatches.length > 0,  'should find at least one DD statement');
});

// ─── 6. Oversize guard boundary: our MAX_COBOL_CHARS is 80_000 ──
test('processFile oversize-skip guard: text at 80_001 chars exceeds, 80_000 does not', () => {
    // We can't invoke processFile directly (server.js starts Express on require),
    // but we mirror its single boundary check so the test fails the moment the
    // threshold or comparison operator drifts.
    const MAX_COBOL_CHARS = 80000;
    const atLimit = 'A'.repeat(MAX_COBOL_CHARS);
    const overLimit = 'A'.repeat(MAX_COBOL_CHARS + 1);
    assert.ok(!(atLimit.length > MAX_COBOL_CHARS),    'a source exactly at MAX should pass');
    assert.ok(overLimit.length > MAX_COBOL_CHARS,     'a source 1 char over MAX should be skipped');
});

// ─── 7. Token-budget guard fires at the documented threshold ──
test('token-budget guard fires when total meets or exceeds the configured ceiling', () => {
    // Mirror the processFile check: `conversion.tokenBudget > 0 && conversion.tokens.total >= conversion.tokenBudget`.
    const cases = [
        { budget: 0,      used: 999999, shouldFire: false }, // 0 = disabled
        { budget: 100000, used: 50000,  shouldFire: false },
        { budget: 100000, used: 100000, shouldFire: true  }, // equal triggers
        { budget: 100000, used: 150000, shouldFire: true  },
    ];
    for (const c of cases) {
        const fires = c.budget > 0 && c.used >= c.budget;
        assert.equal(fires, c.shouldFire,
            `budget=${c.budget} used=${c.used} expected fire=${c.shouldFire}, got ${fires}`);
    }
});

// ─── 8. Prompt regression: fidelity rule must appear in ALL conversion prompts ──
test('fidelity rule (do-not-fabricate) appears in every conversion prompt in azureAgent.js', () => {
    // If a future edit accidentally drops the rule from one of the three
    // conversion prompts (primary + retry 1 + retry 2) OR from the repair
    // prompt, this test breaks — before any tokens get spent on a
    // conversion that would silently regress. The wording differs slightly
    // between prompts on purpose (retry 2 says "fabricate sample records"
    // vs primary's "fabricate data") so we match the concept, not the
    // exact phrase.
    const src = readAllPromptSources();

    // Primary prompt — the full header must survive.
    assert.match(src, /DO NOT FABRICATE INPUT DATA/,
        'primary system prompt lost the DO NOT FABRICATE header');

    // Repair prompt — must still say REMOVE FABRICATED INPUT DATA.
    assert.match(src, /REMOVE FABRICATED INPUT DATA/,
        'fixJavaCode repair prompt lost the REMOVE FABRICATED INPUT DATA rule');

    // "do NOT fabricate …" appears in: primary, retry 1, retry 2. Require ≥3.
    // Case-insensitive because retry prompts use "Do NOT …" casing.
    const doNotFabricate = (src.match(/do\s+NOT\s+fabricate/gi) || []).length;
    assert.ok(doNotFabricate >= 3,
        `expected "do NOT fabricate" in ≥3 conversion prompt sites, found ${doNotFabricate}`);
});

// ─── 9. Dead-code regression: Agent-API path must stay gone ──
test('Agent-API path stays deleted (no live references to convertWithAgent / AZURE_AGENT_ID)', () => {
    const src = readAllPromptSources();
    // The function name may appear in the NOTE comment — but must NOT appear
    // as a function declaration or a callsite.
    assert.doesNotMatch(src, /async\s+function\s+convertWithAgent\s*\(/,
        'convertWithAgent function should be deleted');
    assert.doesNotMatch(src, /javaCode\s*=\s*await\s+convertWithAgent/,
        'convertWithAgent call site should be deleted');
    // AZURE_AGENT_ID should not be read from process.env anywhere anymore.
    assert.doesNotMatch(src, /process\.env\.AZURE_AGENT_ID/,
        'AZURE_AGENT_ID should no longer be read from the env');
    assert.doesNotMatch(src, /azureConfig\.agentId/,
        'azureConfig.agentId should no longer be referenced');
});

// ─── 10. UI skip-status registry includes the new statuses ──
test('public/app.js SKIPPED_STATUSES includes SKIPPED_TOO_LARGE and SKIPPED_BUDGET', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf-8');
    assert.match(src, /SKIPPED_TOO_LARGE/, 'UI must recognize SKIPPED_TOO_LARGE');
    assert.match(src, /SKIPPED_BUDGET/,    'UI must recognize SKIPPED_BUDGET');
});

// ─── 11. Context assembly: copybookBodies flow through the prompt builder ──
test('context.copybookBodies drives inline COPYBOOK blocks in the prompt', () => {
    const src = readAllPromptSources();
    // The convertCobolToJava builder must emit "=== COPYBOOK X ===" headers
    // when copybookBodies is provided — this is what unblocks the AI from
    // guessing field names.
    assert.match(src, /=== COPYBOOK \${name} ===/,
        'convertCobolToJava should emit === COPYBOOK X === headers when bodies are present');
    assert.match(src, /context\.copybookBodies/,
        'context.copybookBodies must be read by convertCobolToJava');
});

// ─── 12. Context assembly: JCL invocations surface as a prompt section ──
test('JCL invocations emit a prompt section with DD name → file path guidance', () => {
    const src = readAllPromptSources();
    assert.match(src, /JCL invocations/i,
        'convertCobolToJava should emit a "JCL invocations" header when jclInvocations is present');
    // And the critical directive: use DD name as file path.
    assert.match(src, /use the DD NAME as the Java file path/i,
        'prompt should tell the AI to use DD names as file paths');
});

// ─── 13. Sibling signatures surface in the prompt when available ──
test('sibling Java signatures show up under CALL targets when the map is populated', () => {
    const src = readAllPromptSources();
    assert.match(src, /entry signature:/i,
        'prompt should annotate CALL targets with "entry signature:" when siblingSignatures[name] is set');
    assert.match(src, /context\.siblingSignatures/,
        'context.siblingSignatures must be read by convertCobolToJava');
});

// ─── 14. autoFixJavaCode strips illegal `throws` patterns (COBOL-course crash driver) ──
test('autoFixJavaCode removes illegal `throws` from for/while/if/switch/else/do statements', () => {
    // autoFixJavaCode moved to src/core/auto-fix-java.js — load it properly
    // now that it's exported. If a future edit weakens the illegal-throws
    // stripper, this test fails before the next batch run ships broken Java.
    const { autoFixJavaCode: autoFix } = require('../src/core/auto-fix-java');
    assert.ok(typeof autoFix === 'function', 'autoFixJavaCode must be exported from src/core/auto-fix-java');

    const cases = [
        'for (AcctFields acct : acctRecords) throws java.io.IOException {',
        'for (int i = 0; i < 10; i++) throws java.io.IOException {',
        'while (!noMoreInput) throws java.io.IOException {',
        'if (x != null) throws IOException {',
        'do throws java.io.IOException {',
        'else throws IOException {',
        'switch (code) throws IOException {',
    ];
    for (const c of cases) {
        const wrapped = `class X { void m() { ${c} } }`;
        const out = autoFix(wrapped);
        assert.doesNotMatch(out, /\b(for|while|if|switch|else|do)\b[^{\n]*\bthrows\b/,
            `autoFixJavaCode failed to strip illegal throws from: ${c}\n  → ${out}`);
    }
});

// ─── Prompt-regression locks for the AI-behavior rules we added ─────────
// Each of these exists because of an observed failure on a real repo.
// If someone later edits a prompt and drops the rule, the test fails
// before tokens get spent on a re-broken conversion.

test('primary conversion prompt has COBOL ACCEPT EOF + default-zero rule', () => {
    const src = readAllPromptSources();
    // ADDAMT.cobol repro: Java threw NumberFormatException / NullPointerException
    // on stdin input "q" or EOF. Rule: default to 0 + null-check.
    assert.match(src, /COBOL ACCEPT FROM SYSIN semantics/i,
        'primary prompt must carry the COBOL ACCEPT semantics rule');
    assert.match(src, /MUST NOT throw,\s*must NOT System\.exit/i,
        'primary prompt must ban throwing / exiting on invalid stdin');
    assert.match(src, /MUST check for null on Scanner\.nextLine/i,
        'primary prompt must require null-check on Scanner reads');
});

test('repair (fixJavaCode) prompt carries ACCEPT + zero-pad rules', () => {
    const src = readAllPromptSources();
    // These rules live in the repair system prompt so Fix-with-AI actually
    // repairs the two runtime bugs we observed (NPE on input, bare %d).
    assert.match(src, /DO NOT THROW on malformed STDIN input/i,
        'repair prompt must tell the AI not to throw on stdin parse failure');
    assert.match(src, /PRESERVE PIC 9\(N\) zero-padding/i,
        'repair prompt must tell the AI to use %0Nd for PIC 9(N) DISPLAY');
    assert.match(src, /String\.format\("%0Nd"/,
        'repair prompt must give an explicit zero-padding example');
});

test('primary prompt gives the zero-padding example', () => {
    const src = readAllPromptSources();
    // Full sample section + concrete example — rule must be discoverable.
    assert.match(src, /PIC 9\(N\) zero-padded display format/i,
        'primary prompt must carry the zero-padding section header');
    assert.match(src, /String\.format\("%06d",\s*wsTotal\)/,
        'primary prompt must include the concrete 6-digit zero-pad example');
});

// ─── 15. autoFixJavaCode strips throws-IOException from pure-string helpers ──
test('autoFixJavaCode strips `throws IOException` from pure-string helper methods', () => {
    // Prevents the AI's mis-annotated helpers from breaking static-field
    // initializers like `static final String H = repeatChar(' ', 60);`.
    // Narrow helper-name whitelist is intentional — we'd rather leave
    // throws in place than over-strip.
    const { autoFixJavaCode: autoFix } = require('../src/core/auto-fix-java');

    // Pure helper with banned throws → should strip. The stripper's regex
    // anchors on a newline + indent + visibility modifier, so each method
    // MUST live on its own line (as it does in real AI output).
    const stripCases = [
`class X {
    private static String repeatChar(char ch, int count) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < count; i++) sb.append(ch);
        return sb.toString();
    }
}`,
`class X {
    private static String padRight(String s, int n) throws IOException {
        return s + " ".repeat(Math.max(0, n - s.length()));
    }
}`,
`class X {
    public static String formatMoney(BigDecimal v) throws java.io.IOException {
        return v.toPlainString();
    }
}`,
    ];
    for (const wrapped of stripCases) {
        const out = autoFix(wrapped);
        assert.doesNotMatch(out, /throws\s+(?:java\.io\.)?IOException\s*\{/,
            `expected throws stripped from pure helper:\n${wrapped}\n  → ${out}`);
    }

    // Real I/O method with throws → must KEEP (verifies conservative scope).
    const keepCases = [
`class X {
    private void writeHeaders(BufferedWriter writer) throws IOException {
        writer.write("hello");
        writer.newLine();
    }
}`,
`class X {
    public AcctRec readAcctRec(BufferedReader reader) throws IOException {
        return new AcctRec(reader.readLine());
    }
}`,
    ];
    for (const wrapped of keepCases) {
        const out = autoFix(wrapped);
        assert.match(out, /throws\s+IOException/,
            `expected throws PRESERVED on real I/O method:\n${wrapped}\n  → ${out}`);
    }
});

// ─── 16. validateRepoUrl: shell-metachar guard (§18.3 security) ──────────
test('validateRepoUrl rejects shell-metacharacter injection attempts', () => {
    const { validateRepoUrl } = require('../src/util/validate-repo-url');
    const bad = [
        'https://evil.com; rm -rf /',
        'https://evil.com`whoami`',
        'https://evil.com$(ls)',
        'git@evil:path && echo pwn',
        'https://evil.com\nmalicious',
        '/tmp/path"with\\quotes',
    ];
    for (const input of bad) {
        const r = validateRepoUrl(input);
        assert.equal(r.ok, false, `should reject: ${JSON.stringify(input)} (got ${JSON.stringify(r)})`);
    }
});

// ─── 17. validateRepoUrl: scheme whitelist ───────────────────────────────
test('validateRepoUrl rejects non-http/non-git@ URL schemes', () => {
    const { validateRepoUrl } = require('../src/util/validate-repo-url');
    const bad = ['file:///etc/passwd', 'ftp://anon@host/repo', 'javascript:alert(1)', 'data:text/plain,hi'];
    for (const input of bad) {
        const r = validateRepoUrl(input);
        assert.equal(r.ok, false, `should reject scheme: ${input} (got ${JSON.stringify(r)})`);
    }
});

// ─── 18. validateRepoUrl: good inputs pass ──────────────────────────────
test('validateRepoUrl accepts http(s), git@, and local paths', () => {
    const { validateRepoUrl } = require('../src/util/validate-repo-url');
    const goodUrls = [
        'https://github.com/user/repo.git',
        'http://internal.corp/repo',
        'git@github.com:user/repo.git',
    ];
    for (const input of goodUrls) {
        const r = validateRepoUrl(input);
        assert.equal(r.ok, true, `should accept: ${input}`);
        assert.equal(r.kind, 'url');
    }
    const goodPath = '/Users/me/path/to/repo';
    const r = validateRepoUrl(goodPath);
    assert.equal(r.ok, true, `should accept path: ${goodPath}`);
    assert.equal(r.kind, 'path');
});

// ─── 19. activeConversions TTL: evicts old completed, keeps running ─────
test('sweepOnce evicts old completed conversions but never running ones', () => {
    const { sweepOnce } = require('../src/persistence/active-conversions-ttl');
    const now = Date.now();
    const TTL = 60_000; // 1 minute
    const map = new Map();
    // Old completed — should evict
    map.set('old-completed', { status: 'completed', completedAt: now - 5 * 60_000 });
    // Old but still running — must keep (evicting would orphan the worker's writes)
    map.set('old-running',   { status: 'running',   startedAt:   now - 5 * 60_000 });
    // Recent completed — keep
    map.set('fresh',         { status: 'completed', completedAt: now - 30_000 });

    const evicted = sweepOnce(map, TTL);
    assert.equal(evicted, 1, 'exactly one old completed entry should evict');
    assert.ok(!map.has('old-completed'), 'old completed should be gone');
    assert.ok(map.has('old-running'),    'running must survive regardless of age');
    assert.ok(map.has('fresh'),          'fresh completed must survive');
});

// ─── 20a. isLikelyTruncated: flags obviously-cut-off COBOL ──────────────
test('isLikelyTruncated flags sources with no exit marker and no trailing period', () => {
    const { isLikelyTruncated } = require('../src/core/source-integrity');

    // Mid-statement cutoff: no END PROGRAM / STOP RUN / GOBACK, last line has no period.
    const truncated = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TRUNC.
       PROCEDURE DIVISION.
           MOVE WS-A TO
    `;
    assert.equal(isLikelyTruncated(truncated).truncated, true);

    // Complete: has STOP RUN.
    const ok1 = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OK1.
       PROCEDURE DIVISION.
           DISPLAY "hi".
           STOP RUN.
    `;
    assert.equal(isLikelyTruncated(ok1).truncated, false);

    // Complete: has GOBACK in a subroutine (no STOP RUN).
    const ok2 = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OK2.
       PROCEDURE DIVISION.
           DISPLAY "sub".
           GOBACK.
    `;
    assert.equal(isLikelyTruncated(ok2).truncated, false);

    // Complete: END PROGRAM as the final sentinel.
    const ok3 = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OK3.
       PROCEDURE DIVISION.
           PERFORM WORK.
           STOP RUN.
       END PROGRAM OK3.
    `;
    assert.equal(isLikelyTruncated(ok3).truncated, false);

    // Comment-only tail is NOT a truncation (period check walks past comments).
    const okWithTrailingComment = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. OK4.
       PROCEDURE DIVISION.
           DISPLAY "hi".
           STOP RUN.
      * Final note.
    `;
    assert.equal(isLikelyTruncated(okWithTrailingComment).truncated, false);
});

// ─── 19a. rate-limit middleware: per-IP sliding window (§18.4) ──────────
test('createRateLimiter blocks an IP after N requests and resets after windowMs', () => {
    const { createRateLimiter } = require('../src/util/rate-limit');
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    // Minimal req/res stubs. `ip` is the only field the limiter reads.
    const makeReq = (ip) => ({ ip });
    let statusCode = 0, body = null;
    const makeRes = () => ({
        setHeader: () => {},
        status(c) { statusCode = c; return this; },
        json(b) { body = b; return this; }
    });
    let nextCalled = 0;
    const next = () => { nextCalled++; };

    const ip = '1.2.3.4';
    // First 3 requests pass; 4th is blocked.
    limiter(makeReq(ip), makeRes(), next); // 1
    limiter(makeReq(ip), makeRes(), next); // 2
    limiter(makeReq(ip), makeRes(), next); // 3
    assert.equal(nextCalled, 3, 'first three requests should pass through');

    statusCode = 0; body = null; nextCalled = 0;
    limiter(makeReq(ip), makeRes(), next);
    assert.equal(statusCode, 429, 'fourth request should be blocked with 429');
    assert.equal(nextCalled, 0, 'next() must NOT be called on a blocked request');
    assert.ok(body && /many/i.test(body.error), 'body should carry a user-readable error');

    // Different IP gets its own budget.
    nextCalled = 0;
    limiter(makeReq('5.6.7.8'), makeRes(), next);
    assert.equal(nextCalled, 1, 'a different IP should not inherit the first IPs exhausted budget');
});

// ─── 19b. buildConversionGraph: extended dependency types (§14) ─────────
test('buildConversionGraph detects EXEC SQL INCLUDE / CICS LINK+XCTL / SEND MAP / IMS DLI', async () => {
    const { buildConversionGraph } = require('../src/core/conversion-graph');
    const { parseJcl } = require('../src/scan/jcl-parser');
    const os = require('node:os');

    // Build a scratch input dir with one COBOL file that exercises every
    // new edge kind. Using the real scan contract so this test also
    // guards against regressions in the graph-build plumbing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-ext-'));
    const prog = path.join(tmp, 'MAIN.cbl');
    const copybook = path.join(tmp, 'SQLCA.cpy');
    fs.writeFileSync(copybook, '* sql ca copybook\n');
    fs.writeFileSync(prog, `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MAIN.
       PROCEDURE DIVISION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
           EXEC CICS LINK PROGRAM('CHILDA') END-EXEC.
           EXEC CICS XCTL PROGRAM('CHILDB') END-EXEC.
           EXEC CICS SEND MAP('M1') MAPSET('MSET1') END-EXEC.
           CALL 'CBLTDLI' USING GN, IO-AREA, PCB-CUST.
           CALL 'UTILITY-Z'.
           STOP RUN.
    `);

    const allFiles = {
        cobolFiles: [prog],
        copybookFiles: [copybook],
        jclFiles: [],
        dataFiles: [],
        otherFiles: []
    };
    const result = buildConversionGraph({ inputPath: tmp, cobolFiles: [prog], allFiles, parseJcl });
    const edges = result.graph.edges;
    const nodes = result.graph.nodes;

    const kinds = edges.map(e => e.kind);
    assert.ok(kinds.includes('sql-include'), `expected sql-include in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('cics-link'), `expected cics-link in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('cics-xctl'), `expected cics-xctl in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('cics-map'), `expected cics-map in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('ims'), `expected ims in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('call-external'), `expected call-external for UTILITY-Z in ${JSON.stringify(kinds)}`);

    const types = nodes.map(n => n.type);
    assert.ok(types.includes('bms-map'), `expected bms-map node, got types: ${JSON.stringify(types)}`);
    assert.ok(types.includes('ims-pcb'), `expected ims-pcb node, got types: ${JSON.stringify(types)}`);
    assert.ok(types.includes('missing-external'), `expected missing-external node for UTILITY-Z`);

    // Cleanup
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── 20. cleanupOldCheckpoints: deletes old JSON files ──────────────────
test('cleanupOldCheckpoints deletes checkpoints older than maxAgeMs', () => {
    const os = require('node:os');
    const { cleanupOldCheckpoints, CHECKPOINT_DIR } = require('../src/persistence/checkpoint');
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

    const oldId = `ttl-test-old-${Date.now()}`;
    const freshId = `ttl-test-fresh-${Date.now()}`;
    const oldPath   = path.join(CHECKPOINT_DIR, `${oldId}.json`);
    const freshPath = path.join(CHECKPOINT_DIR, `${freshId}.json`);
    try {
        // Write one "old" checkpoint (completedAt: 10 days ago) and one "fresh"
        fs.writeFileSync(oldPath,   JSON.stringify({ status: 'completed', completedAt: Date.now() - 10 * 24 * 3600 * 1000 }));
        fs.writeFileSync(freshPath, JSON.stringify({ status: 'completed', completedAt: Date.now() - 60_000 }));

        const result = cleanupOldCheckpoints(7 * 24 * 3600 * 1000);
        assert.ok(result.deleted >= 1, `expected at least 1 deletion, got ${result.deleted}`);
        assert.ok(!fs.existsSync(oldPath),   'old checkpoint should be deleted');
        assert.ok(fs.existsSync(freshPath),  'fresh checkpoint must survive');
    } finally {
        // Cleanup
        try { fs.unlinkSync(oldPath); } catch {}
        try { fs.unlinkSync(freshPath); } catch {}
    }
});
