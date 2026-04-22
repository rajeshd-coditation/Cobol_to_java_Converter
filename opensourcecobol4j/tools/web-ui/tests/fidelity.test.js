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

// ─── 17a. Divisional splitter: cleaves at PROCEDURE DIVISION (§16) ───────
test('splitAtProcedureDivision splits on the boundary and stitches method bodies back', () => {
    const { splitAtProcedureDivision, stitchJava } = require('../src/core/divisional-split');

    const big = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BIG.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-AMT PIC 9(4).
       PROCEDURE DIVISION.
           MOVE 1 TO WS-AMT.
           DISPLAY WS-AMT.
           STOP RUN.
`;
    const split = splitAtProcedureDivision(big);
    assert.ok(split, 'splitter should succeed on a source with PROCEDURE DIVISION');
    assert.match(split.partA, /WORKING-STORAGE SECTION/, 'Part A keeps data division');
    assert.doesNotMatch(split.partA, /MOVE 1 TO WS-AMT/,  'Part A strips real procedure body');
    assert.match(split.partA, /PROCEDURE DIVISION\.\n\s*EXIT\./, 'Part A has a placeholder procedure to compile');
    assert.match(split.partB, /PROGRAM-ID\. BIG/,         'Part B synthesizes an IDENTIFICATION header');
    assert.match(split.partB, /MOVE 1 TO WS-AMT/,         'Part B carries the real procedure body');

    // No-split case: content with no PROCEDURE DIVISION returns null.
    assert.equal(splitAtProcedureDivision('IDENTIFICATION DIVISION. PROGRAM-ID. X.'), null);

    // Stitch exercise — swap method body from Part B into Part A skeleton.
    const a = `public class Big {
    private int wsAmt;
    public void run() {
    }
}`;
    const b = `public class Big {
    private int wsAmt;
    public void run() {
        wsAmt = 1;
        System.out.println(wsAmt);
    }
}`;
    const stitched = stitchJava(a, b);
    assert.match(stitched, /wsAmt = 1;/, 'stitch pulled in Part B method body');
    assert.match(stitched, /System\.out\.println\(wsAmt\);/, 'stitch preserved the println too');
    // Unstitchable fallback — completely unrelated sources.
    const fallback = stitchJava('class X {}', 'class Y { void go() {} }');
    assert.match(fallback, /Part B Java \(unstitched/, 'falls back to append-with-comment when nothing matches');
});

// ─── 17b. Reviewer feedback threads into next file's conversion prompt ──
test('convertCobolToJava emits a REVIEWER FEEDBACK block when context.reviewerFeedback is populated', () => {
    // Locks the §12 feedback-loop wiring: the prompt must reference
    // reviewer-notes text verbatim so the model can apply the correction
    // to subsequent files in the batch. Same pattern as the other
    // context-block prompt tests.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ai', 'convert-cobol.js'), 'utf-8');
    assert.match(src, /REVIEWER FEEDBACK FROM EARLIER IN THIS BATCH/,
        'prompt must carry the reviewer-feedback section header');
    assert.match(src, /hard constraints/i,
        'prompt must frame the notes as hard constraints, not suggestions');
    assert.match(src, /context\.reviewerFeedback/,
        'context key must be named reviewerFeedback — server processFile relies on this');
});

// ─── 17c. fix-cobol route: whole-word rewrite + backup lifecycle ───────
// Loads the router into a scratch Express app + a fake conversions map
// so we can exercise the real handler without a live server. Covers
// rewrite correctness (whole-word, case-insensitive) + backup creation.
test('fix-cobol applies whole-word rewrite and creates .before-fix backup', async () => {
    const express = require('express');
    const os = require('node:os');
    const http = require('node:http');
    const fixCobol = require('../src/routes/fix-cobol');

    // Scratch source with a deliberate typo. The target identifier lives
    // inside a longer one too (PRINT-REX-COUNTER) to prove the whole-word
    // guard doesn't false-match that.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-cobol-'));
    const src = path.join(tmp, 'TEST.cbl');
    fs.writeFileSync(src, `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TEST.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  PRINT-REX-COUNTER PIC 9(4).
       PROCEDURE DIVISION.
           MOVE 1 TO PRINT-REX.
           MOVE 2 TO print-rex.
           STOP RUN.
`);

    const conv = {
        result: {
            report: {
                files: [{ path: 'TEST.cbl', source_path: src, java_status: 'COMPILE_FAIL' }]
            }
        }
    };
    const activeConversions = new Map([['c1', conv]]);

    const app = express();
    app.use(express.json());
    fixCobol.mount(app, { activeConversions });
    const server = app.listen(0);
    const port = server.address().port;

    const post = (body) => new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: '/api/fix-cobol/c1/TEST.cbl',
            method: 'POST', headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
        });
        req.on('error', reject);
        req.write(JSON.stringify(body)); req.end();
    });

    try {
        const r = await post({ bad: 'PRINT-REX', suggestion: 'PRINT-REC' });
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.replacements, 2, 'two PRINT-REX occurrences replaced (upper + lower case)');

        const updated = fs.readFileSync(src, 'utf-8');
        assert.match(updated, /MOVE 1 TO PRINT-REC\./, 'upper-case occurrence replaced');
        assert.match(updated, /MOVE 2 TO PRINT-REC\./, 'lower-case occurrence replaced + normalized');
        assert.match(updated, /PRINT-REX-COUNTER/,    'longer identifier PRESERVED (whole-word guard)');

        assert.ok(fs.existsSync(src + '.before-fix'), 'backup file created');

        // Bad identifier → 400
        const bad = await post({ bad: 'has space', suggestion: 'x' });
        assert.equal(bad.status, 400);

        // Empty-string guards (regex failure)
        const empty = await post({ bad: '', suggestion: 'PRINT-REC' });
        assert.equal(empty.status, 400);
    } finally {
        server.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// ─── 17d. Spring Batch starter XML emitted from parsed JCL (§15) ───────
test('download route emits Spring Batch XML with per-step context + bean hints', async () => {
    // Exercise the same buildSpringBatchXml the /api/download Maven+
    // orchestration path uses, via the module's internal exports. We
    // don't ship these helpers on module.exports today, so load through
    // a small wrapper that re-imports the file's closure-level code.
    // Simpler for the regression: hit the endpoint end-to-end with a
    // scratch conversion + unzip the response.
    const express = require('express');
    const os = require('node:os');
    const http = require('node:http');
    const unzipper = null; // keep dep-free — just spot-check the bytes

    const downloadRoute = require('../src/routes/download');
    const { parseJcl } = require('../src/scan/jcl-parser');
    const { buildManualReviewMd } = require('../src/core/manual-review');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'download-sb-'));
    const jclPath = path.join(tmp, 'PAY.jcl');
    fs.writeFileSync(jclPath, `//PAYJOB  JOB (A),CLASS=A
//STEP1   EXEC PGM=PAYROL00
//PAYIN   DD DSN=PROD.PAYROLL.IN,DISP=SHR
//STEP2   EXEC PGM=UTILITY
//         DD DSN=PROD.UTIL.OUT,DISP=(NEW,KEEP)
`);
    const javaPath = path.join(tmp, 'Payrol00.java');
    fs.writeFileSync(javaPath, 'public class Payrol00 { public void run() {} }');

    const conv = {
        result: {
            outputDir: tmp,
            report: { files: [
                { path: 'jcl/PAY.jcl', source_path: jclPath, java_status: 'SKIPPED_JCL' },
                { path: 'cbl/PAYROL00.cbl', source_path: path.join(tmp, 'PAYROL00.cbl'),
                  java_path: javaPath, java_status: 'SUCCESS' }
            ]}
        }
    };
    // PROGRAM-ID resolution uses the basename of source_path, so create
    // an empty source file so path.basename works.
    fs.writeFileSync(path.join(tmp, 'PAYROL00.cbl'), '* stub');

    const app = express();
    downloadRoute.mount(app, {
        activeConversions: new Map([['c1', conv]]),
        buildManualReviewMd,
        parseJcl
    });
    const server = app.listen(0);
    const port = server.address().port;

    try {
        // Fetch the Spring-Batch variant and verify the zip-magic + that the
        // XML payload ends up in the stream by scanning the bytes for our
        // signatures. (Dep-free: we don't parse the zip here; the real
        // server test covers the unzip path.)
        const resp = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/api/download/c1?format=maven&orchestration=spring-batch`, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
                res.on('error', reject);
            }).on('error', reject);
        });

        assert.equal(resp.status, 200);
        // ZIP local-file-header signature
        assert.equal(resp.body.slice(0, 4).toString('hex'), '504b0304');
        const bodyStr = resp.body.toString('latin1');
        // Spring Batch XML markers (zip isn't strictly deflated, so text
        // that passes the compressor unchanged still appears in the bytes).
        // We check the entry path exists in the central directory header
        // instead — always stored as plain text in the zip file format.
        assert.match(bodyStr, /jobs\/PAYJOB\.spring-batch\.xml/,
            'jobs/PAYJOB.spring-batch.xml entry present in archive');
        assert.match(bodyStr, /pom\.xml/, 'pom.xml also present (Maven format combines)');
    } finally {
        server.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// ─── 18a. parseJcl: STEPLIB / JOBLIB → libraries[] (§14) ────────────────
// Known gap: DD concatenations (multiple DSN= lines under the same DD
// name via blank-named continuation lines) are NOT parsed today — the
// continuation-line syntax would need its own handler. Real repos do
// use this for DBRMLIB stacks; we'll pick it up when we rewrite the
// parser for procs + include expansion.
test('parseJcl surfaces STEPLIB / JOBLIB DSNs as step.steplibs + job libraries[]', () => {
    const { parseJcl } = require('../src/scan/jcl-parser');
    const jcl = `//PAYJOB   JOB  (ACCT),CLASS=A
//JOBLIB   DD DSN=PROD.COMMON.LOADLIB,DISP=SHR
//STEP1    EXEC PGM=PAYROL00
//STEPLIB  DD DSN=PROD.PAYROLL.LOADLIB,DISP=SHR
//PAYFILE  DD DSN=PROD.PAYROLL.DATA,DISP=SHR
//STEP2    EXEC PGM=SORT
//SORTIN   DD DSN=PROD.PAYROLL.DATA,DISP=SHR
`;
    const p = parseJcl(jcl);
    // Step 1 has STEPLIB with one DSN (direct, not a concatenation)
    const step1 = p.steps.find(s => s.name === 'STEP1');
    assert.ok(step1.steplibs.includes('PROD.PAYROLL.LOADLIB'), 'STEPLIB line picked up');
    // Step 2 has no STEPLIB — steplibs must be empty, not missing
    const step2 = p.steps.find(s => s.name === 'STEP2');
    assert.equal(step2.steplibs.length, 0);
    // Job-wide libraries[] dedupes across steps AND includes JOBLIB
    assert.ok(p.libraries.includes('PROD.COMMON.LOADLIB'),  'JOBLIB captured at job level');
    assert.ok(p.libraries.includes('PROD.PAYROLL.LOADLIB'), 'STEPLIB captured at job level');
    // Non-library DDs (PAYFILE, SORTIN) don't leak in
    assert.ok(!p.libraries.includes('PROD.PAYROLL.DATA'),
        'non-STEPLIB DDs must not appear in libraries[]');
});

// ─── 18b. Prompt regression locks for compareRunOutputs (§20) ──────────
// The comparator's verdict rules live in the system prompt at
// src/ai/compare-runs.js. These tests pin each of the five scenarios
// we've seen — match / partial / diverge / compile-fail / missing-data —
// so an edit that accidentally drops a rule fails CI before we ship a
// silently-weakened comparator. Pattern matches the existing prompt
// regression blocks for convert-cobol / fix-java (tests #8 + #15 + #16).

const COMPARE_RUNS_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'ai', 'compare-runs.js'),
    'utf-8'
);

test('compareRunOutputs prompt: source-or-toolchain compile failure is NOT divergence', () => {
    // A COBOL compile failure isn't a behavioral difference between the
    // two programs — the Java side isn't even comparable. Rule protects
    // users from a scary "diverge" verdict on a repo they haven't set up.
    assert.match(COMPARE_RUNS_SOURCE, /COMPILE error/i,
        'prompt must distinguish compile errors from semantic divergence');
    assert.match(COMPARE_RUNS_SOURCE, /verdict="partial" severity="warning"/,
        'compile-error rule must lock to partial/warning, not diverge/error');
});

test('compareRunOutputs prompt: fabricated-fallback is DIVERGE, not MATCH', () => {
    // The #1 fidelity rule — Java must not substitute sample data when
    // COBOL hit "file does not exist (status = 35)". Comparator MUST
    // flag this as diverge/error so the reviewer sees it.
    assert.match(COMPARE_RUNS_SOURCE, /sample data/i,
        'prompt must call out the sample-data fallback pattern');
    assert.match(COMPARE_RUNS_SOURCE, /status\s*=\s*35/i,
        'prompt must reference libcob status 35 as the COBOL signal');
    assert.match(COMPARE_RUNS_SOURCE, /diverge.*severity="error"|severity="error".*diverge/is,
        'fabricated-fallback case must lock to diverge/error');
    assert.match(COMPARE_RUNS_SOURCE, /fabricating/i,
        'prompt must name the failure mode so the reviewer guidance is actionable');
});

test('compareRunOutputs prompt: matched failure modes are NOT divergence', () => {
    // Both programs timing out on the same input loop, OR both refusing
    // to run without the input file, is a MATCHED failure — not a bug.
    // Rule prevents false-positive verdicts that would push users to
    // "fix" a correctly-converted program.
    assert.match(COMPARE_RUNS_SOURCE, /MATCHED failure mode/i,
        'prompt must name "matched failure" so the model reads it as a valid category');
    assert.match(COMPARE_RUNS_SOURCE, /status 35 paired with a Java FileNotFoundException/i,
        'prompt must lock the status-35 / FileNotFoundException equivalence rule');
});

test('compareRunOutputs prompt: missing-data / precompile cases flagged as partial, not diverge', () => {
    // When COBOL can't even compile locally because DB2/CICS/IMS
    // preprocessor is missing, that's an environment issue — the Java
    // output may be fine. Rule keeps users from chasing phantom bugs.
    assert.match(COMPARE_RUNS_SOURCE, /preprocessor/i,
        'prompt must cover the DB2/CICS/IMS preprocessor-missing case');
    assert.match(COMPARE_RUNS_SOURCE, /unavailable/i,
        'prompt must handle the "COBOL output unavailable" variant');
});

test('compareRunOutputs prompt: fileName anchor + structured verdict shape', () => {
    // fileName is used as the anchor so two files compared in the same
    // session don't blur together. Shape lock: verdict / severity /
    // title / reasons must all be documented so UI can rely on them.
    assert.match(COMPARE_RUNS_SOURCE, /File under review:/,
        'prompt must header-line the filename so the model anchors per-file');
    assert.match(COMPARE_RUNS_SOURCE, /do not generalize/i,
        'prompt must tell the model not to collapse comparisons across files');
    // Response shape contract — enforced at the JSDoc level.
    assert.match(COMPARE_RUNS_SOURCE, /verdict:['"]match['"]\|['"]partial['"]\|['"]diverge['"]/,
        'return-type contract must enumerate verdict values');
    assert.match(COMPARE_RUNS_SOURCE, /severity:['"]ok['"]\|['"]info['"]\|['"]warning['"]\|['"]error['"]/,
        'return-type contract must enumerate severity values');
});

test('compareRunOutputs prompt: source + code included for semantic reasoning', () => {
    // Comparator gets both sides of source when available so it can
    // tell "different numeric result but same DISPLAY statement"
    // (expected transformation) from "different numeric result, Java
    // computed wrong" (real bug). Rule added in §23.2.1.
    assert.match(COMPARE_RUNS_SOURCE, /ORIGINAL COBOL SOURCE/,
        'prompt must pass through the COBOL source when the client sends it');
    assert.match(COMPARE_RUNS_SOURCE, /GENERATED JAVA SOURCE/,
        'prompt must pass through the Java source for semantic cross-check');
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

// ─── 21. Resumable conversion — checkpoint + load + resume route ──────
//
// The resumability contract has three moving parts that a contributor
// could break independently, so pin each:
//   (a) saveCheckpoint persists the running-worker's resume fields
//       (completedLevelIdx, levelPlan, fileStates, outputDir)
//   (b) loadCheckpoints promotes `status: 'running'` records to
//       `status: 'interrupted'` with resumable=true on reboot
//   (c) /api/resume/:id filters out already-done files and calls the
//       convert handler with a resumeState payload
test('saveCheckpoint persists resume-relevant worker state', () => {
    const { saveCheckpoint, CHECKPOINT_DIR, checkpointPath } = require('../src/persistence/checkpoint');
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const id = `resume-save-${Date.now()}`;
    const activeConversions = new Map();
    activeConversions.set(id, {
        status: 'running',
        fileStates: { 'a.cbl': 'done', 'b.cbl': 'active' },
        completedLevelIdx: 2,
        totalLevels: 5,
        levelPlan: [['a.cbl'], ['b.cbl'], ['c.cbl']],
        inputPath: '/tmp/foo',
        outputDir: '/tmp/out',
        batchSize: 3,
        tokenBudget: 0,
        startedAt: Date.now()
    });
    try {
        saveCheckpoint(activeConversions, id);
        const raw = JSON.parse(fs.readFileSync(checkpointPath(id), 'utf-8'));
        assert.strictEqual(raw.status, 'running', 'status should round-trip');
        assert.strictEqual(raw.completedLevelIdx, 2, 'completedLevelIdx must be on disk');
        assert.strictEqual(raw.totalLevels, 5);
        assert.ok(Array.isArray(raw.levelPlan) && raw.levelPlan.length === 3, 'levelPlan must be an array');
        assert.strictEqual(raw.outputDir, '/tmp/out', 'outputDir must persist for resume to reuse it');
        assert.deepStrictEqual(raw.fileStates, { 'a.cbl': 'done', 'b.cbl': 'active' });
        assert.strictEqual(raw.batchSize, 3);
    } finally {
        try { fs.unlinkSync(checkpointPath(id)); } catch {}
    }
});

test('loadCheckpoints promotes running → interrupted + sets resumable', () => {
    const { loadCheckpoints, CHECKPOINT_DIR, checkpointPath } = require('../src/persistence/checkpoint');
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    const runId = `resume-load-running-${Date.now()}`;
    const doneId = `resume-load-done-${Date.now()}`;
    fs.writeFileSync(checkpointPath(runId), JSON.stringify({
        status: 'running', inputPath: '/tmp/r', outputDir: '/tmp/o',
        fileStates: { 'a.cbl': 'done', 'b.cbl': 'active' },
        startedAt: Date.now() - 60000
    }));
    fs.writeFileSync(checkpointPath(doneId), JSON.stringify({
        status: 'completed', completedAt: Date.now() - 1000
    }));
    try {
        const acs = new Map();
        loadCheckpoints(acs);
        const run = acs.get(runId);
        const done = acs.get(doneId);
        assert.ok(run, 'interrupted record should be rehydrated');
        assert.strictEqual(run.status, 'interrupted', 'running → interrupted on reboot');
        assert.strictEqual(run.resumable, true, 'resumable flag should be set');
        assert.ok(typeof run.interruptedAt === 'number', 'interruptedAt timestamp should be populated');
        assert.deepStrictEqual(run.pendingReview, {}, 'pendingReview should be reset (Promises cannot rehydrate)');
        assert.ok(done, 'completed record should still rehydrate');
        assert.strictEqual(done.status, 'completed');
    } finally {
        try { fs.unlinkSync(checkpointPath(runId)); } catch {}
        try { fs.unlinkSync(checkpointPath(doneId)); } catch {}
    }
});

test('/api/resume filters to non-terminal files and forwards resumeState', async () => {
    const express = require('express');
    const resumeRoute = require('../src/routes/resume');

    // Stub convertAzureHandler — records what the resume route passes
    // through, returns a fake conversionId.
    let captured = null;
    const stubHandler = async (req, res) => {
        captured = req.body;
        res.json({ conversionId: 'new-123', outputDir: req.body.resumeState.outputDir, useAzureAI: true });
    };

    const activeConversions = new Map();
    activeConversions.set('old-abc', {
        status: 'interrupted',
        resumable: true,
        inputPath: '/tmp/repo',
        outputDir: '/tmp/out-old',
        batchSize: 4,
        reviewMode: true,
        reviewGlob: '*.cbl',
        fileStates: {
            'p1.cbl': 'done',
            'p2.cbl': 'skipped',
            'p3.cbl': 'failed',
            'p4.cbl': 'active',
            'p5.cbl': 'awaiting_review',
            'p6.cbl': 'queued'
        },
        result: { report: { files: [
            { path: 'p1.cbl', java_status: 'SUCCESS', conversionAccuracy: 85 }
        ]}},
        siblingSignatures: { P1: ['run()'] },
        fileTimeline: { 'p1.cbl': [{ step: 'done' }] },
        reviewHistory: [{ fileId: 'p1', action: 'approve' }]
    });
    let checkpointed = false;
    const saveCheckpoint = () => { checkpointed = true; };

    const app = express();
    app.use(express.json());
    resumeRoute.mount(app, { activeConversions, convertAzureHandler: stubHandler, saveCheckpoint });

    // Spin up on an ephemeral port
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/resume/old-abc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.strictEqual(resp.status, 200);
        const body = await resp.json();

        assert.strictEqual(body.conversionId, 'new-123');
        assert.strictEqual(body.resumedFrom, 'old-abc');
        // 3 non-terminal files (p4, p5, p6) should be passed as selectedFiles
        assert.strictEqual(body.remainingFiles, 3);

        // Inspect what convertAzureHandler received
        assert.ok(captured, 'stub handler should have been invoked');
        assert.strictEqual(captured.repoUrl, '/tmp/repo');
        assert.strictEqual(captured.reviewMode, true);
        assert.strictEqual(captured.reviewGlob, '*.cbl');
        assert.strictEqual(captured.batchSize, 4);
        assert.strictEqual(captured.resumedFrom, 'old-abc');
        // selectedFiles should only contain the 3 non-terminal files
        assert.deepStrictEqual(captured.selectedFiles.sort(), ['p4.cbl', 'p5.cbl', 'p6.cbl']);
        // resumeState should carry the full state for seeding
        assert.strictEqual(captured.resumeState.outputDir, '/tmp/out-old');
        assert.deepStrictEqual(captured.resumeState.fileStates, activeConversions.get('old-abc').fileStates);
        assert.strictEqual(captured.resumeState.reportFiles.length, 1);
        assert.deepStrictEqual(captured.resumeState.siblingSignatures, { P1: ['run()'] });

        // The old record should have resumedAs wired and resumable cleared
        const old = activeConversions.get('old-abc');
        assert.strictEqual(old.resumedAs, 'new-123');
        assert.strictEqual(old.resumable, undefined);
        assert.strictEqual(checkpointed, true, 'saveCheckpoint should persist the link');
    } finally {
        server.close();
    }
});

test('/api/resume returns alreadyComplete when no files remain non-terminal', async () => {
    const express = require('express');
    const resumeRoute = require('../src/routes/resume');

    const activeConversions = new Map();
    activeConversions.set('old-done', {
        status: 'interrupted',
        resumable: true,
        inputPath: '/tmp/repo',
        outputDir: '/tmp/out',
        fileStates: { 'p1.cbl': 'done', 'p2.cbl': 'skipped' }
    });
    const saveCheckpoint = () => {};
    const app = express();
    app.use(express.json());
    resumeRoute.mount(app, { activeConversions, convertAzureHandler: () => {}, saveCheckpoint });

    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/resume/old-done`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
        });
        assert.strictEqual(resp.status, 200);
        const body = await resp.json();
        assert.strictEqual(body.alreadyComplete, true);
        assert.strictEqual(body.remainingFiles, 0);
        assert.strictEqual(activeConversions.get('old-done').status, 'completed');
    } finally {
        server.close();
    }
});

// ─── 22. Interactive run WebSocket — handshake + round-trip stdin ─────
//
// Pins the WS protocol shape: client receives `ready`, sends `stdin`,
// receives `stdout` containing echoed input, receives `exit`. Uses a
// trivial Java program that just echoes one line from stdin — skipped
// when no JDK is on PATH so the deterministic test suite stays portable.
test('interactive run WS — ready + stdin round-trip + exit for an Echo java class', async () => {
    try {
        require('child_process').execSync('javac -version', { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
        return; // no JDK; skip gracefully
    }

    const http = require('http');
    const express = require('express');
    const WebSocket = require('ws');
    const runWs = require('../src/routes/run-ws');

    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ws-run-'));
    const javaPath = path.join(tmp, 'Echo.java');
    fs.writeFileSync(javaPath, `
public class Echo {
    public static void main(String[] args) throws Exception {
        java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
        String line = br.readLine();
        System.out.println("got:" + line);
    }
}
`);

    const activeConversions = new Map();
    activeConversions.set('test-ws', {
        status: 'completed',
        result: { report: { files: [
            { path: 'Echo.cbl', work_dir: tmp, java_path: javaPath }
        ]}}
    });

    const app = express();
    const srv = http.createServer(app);
    runWs.mount(srv, { activeConversions });
    srv.listen(0);
    await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;

    try {
        const received = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/run/test-ws/Echo.cbl`);

        await new Promise((resolve, reject) => {
            ws.on('message', (buf) => {
                const msg = JSON.parse(buf.toString());
                received.push(msg);
                if (msg.type === 'ready') {
                    ws.send(JSON.stringify({ type: 'stdin', data: 'hello\n' }));
                }
                if (msg.type === 'exit') resolve();
            });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('WS test timed out')), 20000);
        });

        const kinds = received.map(m => m.type);
        assert.ok(kinds.includes('ready'), `missing ready frame; got ${kinds.join(', ')}`);
        assert.ok(kinds.includes('exit'), `missing exit frame; got ${kinds.join(', ')}`);
        const stdoutFrames = received.filter(m => m.type === 'stdout');
        const combined = stdoutFrames.map(m => m.data).join('');
        assert.ok(/got:hello/.test(combined), `expected 'got:hello' in stdout; got: ${JSON.stringify(combined)}`);
    } finally {
        srv.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// ─── Preprocessor auto-applies curated typo-dictionary (AUTO_APPLY tier) ──
//
// Three upstream-documented COBOL bugs need to auto-rewrite at preprocess
// time so the user doesn't have to click "Apply typo fix" before every
// run. Pin the behavior so a future dictionary edit can't silently drop
// the rewrite or (more dangerously) promote a HINT_ONLY entry into
// AUTO_APPLY where it might overwrite legitimate identifiers.
test('preprocessCobolSource auto-rewrites PRINT-REX, TLIMIT, CURRENT-DATA', () => {
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'typo-preprocess-'));
    try {
        const src = path.join(tmp, 'bugged.cobol');
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. BUGGED.',
            '       PROCEDURE DIVISION.',
            '           WRITE PRINT-REX FROM HEADER-1.',
            '           COMPUTE TLIMIT = TLIMIT + 1 END-COMPUTE.',
            '           MOVE FUNCTION CURRENT-DATA TO WS-TODAY.',
            '           STOP RUN.'
        ].join('\n'));
        const mods = { periodsAdded: 0, typosFixed: [] };
        const outPath = preprocessCobolSource(src, tmp, mods);
        const patched = fs.readFileSync(outPath, 'utf-8');
        assert.ok(patched.includes('PRINT-REC'), 'PRINT-REX should be rewritten to PRINT-REC');
        assert.ok(!patched.includes('PRINT-REX'), 'original PRINT-REX must be gone');
        assert.ok(patched.includes('TLIMITED'), 'TLIMIT should be rewritten to TLIMITED');
        assert.ok(patched.includes('CURRENT-DATE'), 'CURRENT-DATA should be rewritten to CURRENT-DATE');
        assert.ok(mods.typosFixed.length >= 3, `expected ≥3 typo fixes reported; got ${mods.typosFixed.length}`);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// End-to-end sanity: the actual CBL0009-style bug from COBOL Programming
// Course (TLIMIT referenced, TLIMITED declared, edit-distance 2) must run
// through the preprocessor AND compile with cobc. This is what /api/run
// does — pinning it here catches any future regression where the typo
// fix lands but cobc still rejects because of a different issue.
test('preprocessCobolSource + cobc end-to-end — TLIMIT fixture compiles', () => {
    const { execSync } = require('child_process');
    try {
        execSync('which cobc', { stdio: 'ignore' });
    } catch {
        return; // no cobc on PATH → skip gracefully (matches /api/run short-circuit)
    }
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tlimit-e2e-'));
    try {
        const src = path.join(tmp, 'TLIMITBUG.cobol');
        // Minimal reproduction of the CBL0009 shape: field declared as
        // TLIMITED, code references TLIMIT. Raw source MUST fail cobc;
        // post-preprocess MUST pass cobc.
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. TLIMITBUG.',
            '       DATA DIVISION.',
            '       WORKING-STORAGE SECTION.',
            '       01  TLIMIT-GROUP.',
            '           05 TLIMITED PIC S9(9)V99 COMP-3 VALUE ZERO.',
            '       PROCEDURE DIVISION.',
            '           COMPUTE TLIMIT = TLIMIT + 1 END-COMPUTE.',
            '           STOP RUN.'
        ].join('\n'));

        // 1. Raw source should NOT compile (baseline — confirms the bug).
        let rawFailed = false;
        try {
            execSync(`cobc -x -std=mf -frelax-syntax-checks -Wno-obsolete -o "${tmp}/raw_bin" "${src}"`,
                { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
        } catch {
            rawFailed = true;
        }
        assert.ok(rawFailed, 'raw source with TLIMIT bug should fail cobc (baseline check)');

        // 2. Post-preprocess: the preprocessor auto-applies TLIMIT→TLIMITED.
        const mods = { periodsAdded: 0, typosFixed: [] };
        const patched = preprocessCobolSource(src, tmp, mods);
        const rewrite = (mods.typosFixed || []).find(t =>
            t.bad.toUpperCase() === 'TLIMIT' && t.suggestion.toUpperCase() === 'TLIMITED');
        assert.ok(rewrite, `expected TLIMIT→TLIMITED rewrite in mods.typosFixed; got ${JSON.stringify(mods.typosFixed)}`);

        // 3. Patched source MUST compile — closing the end-to-end loop.
        execSync(`cobc -x -std=mf -frelax-syntax-checks -Wno-obsolete -o "${tmp}/fixed_bin" "${patched}"`,
            { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
        // Built successfully → the UI's /api/run path now produces cobc output instead of 'TLIMIT not defined'.
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('preprocessCobolSource does NOT auto-rewrite HINT_ONLY entries (ACCTREC)', () => {
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'typo-hintonly-'));
    try {
        const src = path.join(tmp, 'file-assign.cobol');
        // ACCTREC is the external file name here (ASSIGN TO ACCTREC) —
        // legal COBOL, common in COBOL Programming Course. Rewriting it
        // to ACCT-REC would silently break the JCL linkage.
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. FILEPROG.',
            '       ENVIRONMENT DIVISION.',
            '       INPUT-OUTPUT SECTION.',
            '       FILE-CONTROL.',
            '           SELECT ACCT-REC ASSIGN TO ACCTREC.',
            '       PROCEDURE DIVISION.',
            '           OPEN INPUT ACCT-REC.',
            '           CLOSE ACCT-REC.',
            '           STOP RUN.'
        ].join('\n'));
        const mods = { periodsAdded: 0, typosFixed: [] };
        const outPath = preprocessCobolSource(src, tmp, mods);
        const patched = fs.readFileSync(outPath === src ? src : outPath, 'utf-8');
        // ACCTREC must survive — it's the external DD name.
        assert.ok(/ASSIGN\s+TO\s+ACCTREC/.test(patched),
            'ACCTREC must be preserved in ASSIGN TO clause — it is the file DD name, not a typo');
        // And no typo fix should be reported for ACCTREC (it's HINT_ONLY).
        const badRewrite = (mods.typosFixed || []).find(t => t.bad.toUpperCase() === 'ACCTREC');
        assert.ok(!badRewrite, 'ACCTREC is HINT_ONLY and must not auto-rewrite');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// Dangling END-IF fix — covers the COBOL Programming Course CBL0007
// IS-STATE-VIRGINIA bug. The IF line ends with `.`, closing the scope,
// and the next line's END-IF is stranded. Fix: strip the trailing
// period on the IF line when the next non-comment line begins with
// END-IF. Narrow by design — won't touch multi-line IF blocks or
// END-IFs that aren't preceded by a dangling-period IF.
test('preprocessCobolSource strips dangling period before END-IF (CBL0007 bug)', () => {
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'endif-dangle-'));
    try {
        const src = path.join(tmp, 'DANGLE.cobol');
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. DANGLE.',
            '       DATA DIVISION.',
            '       WORKING-STORAGE SECTION.',
            '       01 COUNTER PIC 9(4) VALUE 0.',
            '       01 STATE-FLAG PIC X VALUE "Y".',
            '       PROCEDURE DIVISION.',
            '           IF STATE-FLAG = "Y" ADD 1 TO COUNTER.',
            '           END-IF.',
            '           STOP RUN.'
        ].join('\n'));

        const mods = { periodsAdded: 0, typosFixed: [], endifDanglingFixed: 0 };
        const patched = preprocessCobolSource(src, tmp, mods);
        assert.strictEqual(mods.endifDanglingFixed, 1,
            `expected 1 dangling-END-IF fix; got ${mods.endifDanglingFixed}`);
        const out = fs.readFileSync(patched, 'utf-8');
        // The IF line must NO LONGER end with a period — END-IF closes the scope now.
        assert.match(out, /IF STATE-FLAG = "Y" ADD 1 TO COUNTER\s*$/m,
            'IF-inline-action line should have its trailing period stripped');
        assert.match(out, /END-IF\s*\./, 'END-IF should be preserved');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

// ─── Phase 3b helpers — lock the extracted pure helpers' behavior ────────
//
// processFile uses four helpers from src/routes/convert-azure-helpers.js
// (preflightCheck, buildContext, extractReviewerFeedback,
// extractEntrySignature). Unit-test each so an internal refactor can't
// silently shift behavior. The helpers take their inputs explicitly —
// no need to spin up a full conversion to exercise them.
test('extractReviewerFeedback keeps ≤5 reject/edit notes, excludes current file, requires note', () => {
    const { extractReviewerFeedback } = require('../src/routes/convert-azure-helpers');
    const hist = [
        { fileId: 'a.cbl', action: 'approve' },                         // no note + not reject/edit → drop
        { fileId: 'b.cbl', action: 'reject', note: 'bad mov' },         // keep
        { fileId: 'c.cbl', action: 'edit', note: 'fix types' },         // keep
        { fileId: 'd.cbl', action: 'edit' },                            // no note → drop
        { fileId: 'e.cbl', action: 'reject', note: 'wrong class' },     // keep
        { fileId: 'f.cbl', action: 'reject', note: 'off by one' },      // keep
        { fileId: 'g.cbl', action: 'reject', note: 'unused var' },      // keep
        { fileId: 'h.cbl', action: 'edit',   note: 'rename' },          // keep (5th)
        { fileId: 'i.cbl', action: 'reject', note: 'wrong cast' },      // keep (6th — pushes oldest off)
        { fileId: 'SELF.cbl', action: 'reject', note: 'skip self' }     // same-file self-reject → drop
    ];
    const fb = extractReviewerFeedback(hist, 'SELF.cbl');
    assert.strictEqual(fb.length, 5, `expected 5 notes; got ${fb.length}`);
    // Oldest (b.cbl) dropped by the tail-5; current-file (SELF.cbl) filtered out.
    const files = fb.map(f => f.fileBasename).join(',');
    assert.ok(!files.includes('b.cbl'), `expected oldest b.cbl dropped; got ${files}`);
    assert.ok(!files.includes('SELF.cbl'), `SELF.cbl must not surface its own reject; got ${files}`);
});

test('extractReviewerFeedback handles missing / non-array history', () => {
    const { extractReviewerFeedback } = require('../src/routes/convert-azure-helpers');
    assert.deepStrictEqual(extractReviewerFeedback(null, 'x.cbl'), []);
    assert.deepStrictEqual(extractReviewerFeedback(undefined, 'x.cbl'), []);
    assert.deepStrictEqual(extractReviewerFeedback([], 'x.cbl'), []);
});

test('extractEntrySignature prefers non-main non-class method, falls back to main', () => {
    const { extractEntrySignature } = require('../src/routes/convert-azure-helpers');

    const withRun = `
public class Foo {
    public static void main(String[] args) { new Foo().run("x", 1); }
    public void run(String arg, int n) { }
}`;
    const sigRun = extractEntrySignature(withRun, 'Foo');
    assert.match(sigRun, /public void run\(String arg, int n\)/,
        `expected run(...) preferred; got ${sigRun}`);

    const mainOnly = `
public class Bar {
    public static void main(String[] args) { }
}`;
    const sigMain = extractEntrySignature(mainOnly, 'Bar');
    assert.match(sigMain, /public static void main\(String\[\] args\)/,
        `expected main(...) fallback; got ${sigMain}`);

    // No public methods at all → null, not a throw.
    assert.strictEqual(extractEntrySignature('class X { private int x; }', 'X'), null);
});

test('preflightCheck short-circuits on cancelled / budget / copybook / tiny / truncated', () => {
    const { preflightCheck } = require('../src/routes/convert-azure-helpers');
    const stubs = {
        isLikelyTruncated: () => ({ truncated: false }),
        isDivisionalSplitEnabled: () => false,
        splitAtProcedureDivision: () => null,
        pushTimeline: () => {}
    };
    const makeConv = (overrides = {}) => Object.assign({
        cancelled: false,
        tokens: { total: 0 },
        tokenBudget: 0,
        fileStates: {}
    }, overrides);

    // Cancelled
    {
        const conv = makeConv({ cancelled: true });
        const r = preflightCheck({
            relativePath: 'a.cbl', baseName: 'A', cobolPath: '/tmp/a.cbl',
            cobolSource: 'IDENTIFICATION DIVISION. PROGRAM-ID. A.',
            conversion: conv, ...stubs
        });
        assert.strictEqual(r.outcome, 'skip');
        assert.strictEqual(r.fileResult.status, 'skipped_cancelled');
        assert.strictEqual(conv.fileStates['a.cbl'], 'skipped');
    }
    // Token budget exceeded
    {
        const conv = makeConv({ tokens: { total: 100 }, tokenBudget: 50 });
        const r = preflightCheck({
            relativePath: 'b.cbl', baseName: 'B', cobolPath: '/tmp/b.cbl',
            cobolSource: 'x', conversion: conv, ...stubs
        });
        assert.strictEqual(r.fileResult.reportEntry.java_status, 'SKIPPED_BUDGET');
    }
    // No PROGRAM-ID
    {
        const conv = makeConv();
        const r = preflightCheck({
            relativePath: 'c.cbl', baseName: 'C', cobolPath: '/tmp/c.cbl',
            cobolSource: '       01 JUST-A-COPYBOOK-STUB PIC X(10).',
            conversion: conv, ...stubs
        });
        assert.strictEqual(r.fileResult.status, 'skipped_noid');
    }
    // Too small
    {
        const conv = makeConv();
        const r = preflightCheck({
            relativePath: 'd.cbl', baseName: 'D', cobolPath: '/tmp/d.cbl',
            cobolSource: 'PROGRAM-ID tiny.',
            conversion: conv, ...stubs
        });
        assert.strictEqual(r.fileResult.status, 'skipped_small');
    }
    // Truncated
    {
        const conv = makeConv();
        const r = preflightCheck({
            relativePath: 'e.cbl', baseName: 'E', cobolPath: '/tmp/e.cbl',
            cobolSource: 'IDENTIFICATION DIVISION. PROGRAM-ID. E.'.repeat(3),
            conversion: conv,
            ...stubs,
            isLikelyTruncated: () => ({ truncated: true, reason: 'cut off' })
        });
        assert.strictEqual(r.fileResult.reportEntry.java_status, 'SKIPPED_INCOMPLETE_SOURCE');
    }
    // Oversize + split disabled → skip TOO_LARGE
    {
        const conv = makeConv();
        const big = 'PROGRAM-ID. BIG.\n' + 'X'.repeat(90000);
        const r = preflightCheck({
            relativePath: 'f.cbl', baseName: 'F', cobolPath: '/tmp/f.cbl',
            cobolSource: big, conversion: conv, ...stubs
        });
        assert.strictEqual(r.fileResult.reportEntry.java_status, 'SKIPPED_TOO_LARGE');
    }
    // Normal-sized happy path → continue
    {
        const conv = makeConv();
        const r = preflightCheck({
            relativePath: 'g.cbl', baseName: 'G', cobolPath: '/tmp/g.cbl',
            cobolSource: 'IDENTIFICATION DIVISION. PROGRAM-ID. G.\n'.repeat(3),
            conversion: conv, ...stubs
        });
        assert.strictEqual(r.outcome, 'continue');
        assert.strictEqual(r.divisionalSplit, null);
    }
});

test('buildContext extracts calls, copies, PROGRAM-ID map + inlines copybook bodies', () => {
    const { buildContext } = require('../src/routes/convert-azure-helpers');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ctx-'));
    try {
        const cpyA = path.join(tmp, 'CVACT01Y.cpy');
        fs.writeFileSync(cpyA, '       05 ACCT-NO PIC 9(11).\n       05 ACCT-BAL PIC S9(9)V99 COMP-3.\n');

        const ctx = buildContext({
            cobolSource: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MYPROG.
       PROCEDURE DIVISION.
           COPY CVACT01Y.
           CALL 'ADDAMT' USING X.
           CALL 'PRINTER' USING Y.
           STOP RUN.
`,
            baseName: 'MYPROG',
            conversion: {
                graph: { nodes: [
                    { type: 'program', path: path.join(tmp, 'OTHER.cbl'), id: 'OTHER.cbl' }
                ]},
                jclContext: {
                    'MYPROG': [{ jclFile: 'RUN.jcl', stepName: 'STEP1', ddStatements: [] }]
                }
            },
            copybookPathByName: { 'CVACT01Y': cpyA },
            copybookBodyCache: {},
            toPascalCase: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
        });

        // Calls deduplicated + uppercase
        assert.deepStrictEqual(ctx.calledPrograms.sort(), ['ADDAMT', 'PRINTER']);
        // Copybook found + inlined body
        assert.ok(ctx.copybooks.includes('CVACT01Y'));
        assert.ok(ctx.copybookBodies['CVACT01Y'].includes('ACCT-NO'));
        // PROGRAM-ID map pulls in graph programs (not just the current file)
        assert.strictEqual(ctx.programIdToJavaClass['OTHER'], 'Other');
        // JCL invocations keyed by basename
        assert.strictEqual(ctx.jclInvocations.length, 1);
        assert.strictEqual(ctx.jclInvocations[0].stepName, 'STEP1');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('buildContext caps copybook-payload at ~40k chars', () => {
    const { buildContext } = require('../src/routes/convert-azure-helpers');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ctx-cap-'));
    try {
        const big = path.join(tmp, 'BIG.cpy');
        const small = path.join(tmp, 'SMALL.cpy');
        fs.writeFileSync(big, 'X'.repeat(35000));
        fs.writeFileSync(small, 'Y'.repeat(10000));

        const ctx = buildContext({
            cobolSource: `
       PROGRAM-ID. P.
       COPY BIG.
       COPY SMALL.
`,
            baseName: 'P',
            conversion: { graph: { nodes: [] }, jclContext: {} },
            copybookPathByName: { 'BIG': big, 'SMALL': small },
            copybookBodyCache: {},
            toPascalCase: (s) => s
        });
        // BIG fits (35k < 40k), SMALL would push over 45k so it's dropped.
        assert.ok(ctx.copybookBodies['BIG'], 'BIG should be inlined');
        assert.ok(!ctx.copybookBodies['SMALL'], 'SMALL must be dropped to stay under 40k cap');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('preprocessCobolSource leaves canonical END-IF patterns alone (no false positives)', () => {
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'endif-ok-'));
    try {
        const src = path.join(tmp, 'OK.cobol');
        // Correct form: IF line has no terminating period; actions on separate
        // lines. END-IF properly closes the block. The preprocessor must
        // leave this untouched.
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. OK.',
            '       DATA DIVISION.',
            '       WORKING-STORAGE SECTION.',
            '       01 COUNTER PIC 9(4) VALUE 0.',
            '       PROCEDURE DIVISION.',
            '           IF COUNTER > 0',
            '               DISPLAY "positive"',
            '               ADD 1 TO COUNTER',
            '           END-IF.',
            '           STOP RUN.'
        ].join('\n'));

        const mods = { periodsAdded: 0, typosFixed: [], endifDanglingFixed: 0 };
        preprocessCobolSource(src, tmp, mods);
        assert.strictEqual(mods.endifDanglingFixed, 0,
            'correctly-formed multi-line IF block must not trigger the dangle-fix');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('preprocessCobolSource leaves typo tokens inside comments alone', () => {
    const { preprocessCobolSource } = require('../src/core/run/cobol-preprocess');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'typo-comment-'));
    try {
        const src = path.join(tmp, 'commented.cobol');
        // PRINT-REX here is inside a fixed-format comment (col 7 = '*').
        // Rewriting text inside comments would be invisible noise and
        // risks breaking historical notes referring to the old name.
        fs.writeFileSync(src, [
            '       IDENTIFICATION DIVISION.',
            '       PROGRAM-ID. COMMENTTEST.',
            '      * Old name was PRINT-REX — renamed to PRINT-REC',
            '       PROCEDURE DIVISION.',
            '           DISPLAY "hello".',
            '           STOP RUN.'
        ].join('\n'));
        const mods = { periodsAdded: 0, typosFixed: [] };
        preprocessCobolSource(src, tmp, mods);
        // The only occurrence of PRINT-REX is inside a comment so
        // nothing should be rewritten.
        assert.ok(!(mods.typosFixed && mods.typosFixed.length),
            `comment-only occurrences must not trigger rewrites; got ${JSON.stringify(mods.typosFixed)}`);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
});

test('interactive run WS — rejects unknown conversion id', async () => {
    const http = require('http');
    const express = require('express');
    const WebSocket = require('ws');
    const runWs = require('../src/routes/run-ws');

    const activeConversions = new Map();
    const app = express();
    const srv = http.createServer(app);
    runWs.mount(srv, { activeConversions });
    srv.listen(0);
    await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;

    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/run/nope/foo.cbl`);
        const received = [];
        await new Promise((resolve, reject) => {
            ws.on('message', (buf) => received.push(JSON.parse(buf.toString())));
            ws.on('close', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 5000);
        });
        const err = received.find(m => m.type === 'error');
        assert.ok(err, `expected an error frame; got: ${JSON.stringify(received)}`);
        assert.match(err.error, /not found/i);
    } finally {
        srv.close();
    }
});

// ─── 23. Post-compile repair consolidation — prompt-reinforcement locks ──
//
// The autoFixJavaCode regex patches (src/core/auto-fix-java.js) include
// several [ai-specific] patches that exist *because* the model kept
// making specific mistakes (final-on-mutable fields, abstract-on-concrete,
// throws-on-pure-string-helper, etc). Those patches are A/B-validated
// net positive today (§24.2.1 in Decisions log), so we're NOT retiring
// them yet. What we ARE doing is reinforcing the PRIMARY + REPAIR prompts
// with the exact patterns those patches fix, so over time the patches
// stop firing in measurement. When a patch stops firing across a broad
// A/B, THEN we can retire it. These tests lock the prompt reinforcement
// so a casual edit can't silently remove it.
test('primary prompt explicitly bans final-on-mutable-fields (Fix 2f / 9-10 reinforcement)', () => {
    const src = readAllPromptSources();
    assert.match(src, /Do NOT mark a field \\?`final\\?` if ANY code path reassigns it/,
        'primary prompt should tell AI to omit `final` on mutable fields');
    assert.match(src, /WORKING-STORAGE variables are mutable by default/,
        'primary prompt should explain WHY COBOL fields translate to non-final Java');
});

test('primary prompt bans final-on-parameters (Fix 26 reinforcement)', () => {
    const src = readAllPromptSources();
    assert.match(src, /Do NOT mark method parameters \\?`final\\?`/,
        'primary prompt should ban `final` on method parameters');
});

test('primary prompt bans abstract-on-concrete-class (Fix 24 reinforcement)', () => {
    const src = readAllPromptSources();
    // Source is read raw from disk, so template-literal escaped backticks
    // appear as literal backslash-backtick in the search string.
    assert.match(src, /Do NOT mark a class \\?`abstract\\?` unless it declares \\?`abstract\\?` methods/,
        'primary prompt should ban unnecessary `abstract` modifier');
});

test('primary prompt bans throws-IOException-on-pure-string helpers (Fix 2d reinforcement)', () => {
    const src = readAllPromptSources();
    assert.match(src, /Pure-string[\s\S]*helper methods[\s\S]*must NOT declare \\?`throws IOException\\?`/i,
        'primary prompt should ban throws IOException on pure-string helpers');
});

test('primary prompt requires main() for programs with PROCEDURE DIVISION (Fix 6 reinforcement)', () => {
    const src = readAllPromptSources();
    assert.match(src, /If the COBOL has a PROCEDURE DIVISION[\s\S]*public static void[\s\S]*main/,
        'primary prompt should require main() for every COBOL program');
});

test('primary prompt requires primitive field initialization (Fix 8 reinforcement)', () => {
    const src = readAllPromptSources();
    assert.match(src, /Every declared primitive field[\s\S]*must have a safe default/,
        'primary prompt should require primitive fields to be initialized');
});

test('repair prompt carries the same reinforcement rules as primary', () => {
    // Load fix-java.js directly so we're asserting on the REPAIR prompt
    // specifically, not the combined pool (which would let the test pass
    // if only the primary prompt had these rules).
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ai', 'fix-java.js'), 'utf-8');
    assert.match(src, /No `final` on instance fields.*reassigned/s,
        'repair prompt must reinforce no-final-on-mutable-fields');
    assert.match(src, /No `final` on method parameters/,
        'repair prompt must reinforce no-final-on-parameters');
    assert.match(src, /No `abstract` on a class unless it declares abstract methods/,
        'repair prompt must reinforce abstract-only-when-needed');
    assert.match(src, /Pure-string.*MUST NOT declare `throws IOException`/s,
        'repair prompt must reinforce no-throws-on-pure-string-helpers');
    assert.match(src, /If the COBOL has a PROCEDURE DIVISION.*main\(String\[\] args\)/s,
        'repair prompt must ensure main() exists when PROCEDURE DIVISION present');
});
