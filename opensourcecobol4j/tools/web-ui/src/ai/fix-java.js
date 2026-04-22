/**
 * AI repair agent for generated Java. Called by /api/fix-java when a file
 * fails to compile or when /api/run's comparator judges the output as
 * divergent from COBOL. Pulls in everything the primary conversion path
 * had PLUS the compile errors and run outputs from the latest attempt, so
 * the AI has the full picture of what broke.
 *
 * Prompt rules (asserted by tests/fidelity.test.js):
 *   - "DO NOT THROW on malformed STDIN input" — mirrors the primary
 *     ACCEPT-FROM-SYSIN semantics so repairs can't silently reintroduce
 *     the NullPointerException / NumberFormatException bugs we banned.
 *   - "PRESERVE PIC 9(N) zero-padding" + `String.format("%0Nd", …)` — same
 *     reasoning, applied to the repair direction.
 *
 * Output runs through autoFixJavaCode() before being returned, for parity
 * with the primary path — otherwise the repair could emit the same
 * illegal-throws / missing-import patterns autoFix exists to catch.
 *
 * Returns { success, javaCode, error, usage } — the caller writes javaCode
 * to disk and re-scores accuracy.
 */

const { isAvailable, makeOpenAIRequest } = require('./azure-client');
const { autoFixJavaCode } = require('../core/auto-fix-java');

async function fixJavaCode({
    javaCode, cobolSource,
    compileErrors, runOutput, cobolOutput,
    cobolError, javaError,
    cobolOutputFiles, javaOutputFiles,
    comparatorVerdict,
    dependencies,
    graphEdges,
    siblingSignatures,
    jclInvocations,
    onPromptReady
}) {
    if (!isAvailable()) {
        return { success: false, error: 'Azure AI not configured' };
    }
    if (!javaCode) {
        return { success: false, error: 'No Java code to fix' };
    }

    // Head+tail snippet helper — used ONLY for runtime stdout capture below.
    // Source code, Java code, and compile errors are sent in FULL so the
    // repair agent has complete context (mid-file bugs are invisible to a
    // head-only snippet; a compile error on line 800 with the source sliced
    // at 4k chars = ~150 lines leaves the repair agent blind).
    const snippet = (s, limit = 3000) => {
        if (!s) return '';
        if (s.length <= limit) return s;
        return s.slice(0, limit * 2 / 3) + `\n…[${s.length - limit} chars elided]…\n` + s.slice(-limit / 3);
    };

    const systemPrompt =
        'You are a Java repair agent specialized in COBOL-to-Java conversions.\n' +
        'You receive an existing Java file that was produced by another AI agent\n' +
        'and probably has bugs (compile errors, type mismatches, missing methods,\n' +
        'invented behavior, or semantic drift from the original COBOL). Return a\n' +
        'repaired version that:\n' +
        '1. COMPILES cleanly with plain javac (no external dependencies).\n' +
        '2. Preserves the business logic expressed in the ORIGINAL COBOL.\n' +
        '3. Uses the listed sibling classes instead of simulating their calls.\n' +
        '4. Does NOT invent behavior (HTTP, JSON, REST, auth) absent from COBOL.\n' +
        '5. `throws` appears ONLY on method signatures. NEVER write `for (...) throws`,\n' +
        '   `while (...) throws`, `if (...) throws`, `switch (...) throws`, `else throws`,\n' +
        '   `do throws` — those are compile errors. A checked exception inside a loop\n' +
        '   either (a) bubbles up via `throws IOException` on the enclosing method, or\n' +
        '   (b) is caught with try/catch inside that loop/conditional.\n' +
        '5b. Properly handles IOException — methods that use File I/O must either\n' +
        '   declare `throws Exception` OR wrap the I/O in try-catch.\n' +
        '6. Every method called must be DEFINED in the same class or standard\n' +
        '   Java library.\n' +
        '7. Generic collections must be type-consistent.\n' +
        '8. REMOVE FABRICATED INPUT DATA. If the current Java has blocks like\n' +
        '   "Input file not found, using sample data for demonstration…" or\n' +
        '   hardcoded account/employee records that substitute for missing\n' +
        '   files, DELETE that fallback. The repaired Java must fail the same\n' +
        '   way the COBOL does when input is missing: print a clear error and\n' +
        '   exit non-zero. No silent sample-data substitution.\n' +
        '9. DO NOT THROW on malformed STDIN input. COBOL ACCEPT silently stores\n' +
        '   zeroes on non-numeric text, and returns blanks forever on EOF. If\n' +
        '   the current Java uses Integer.parseInt / new BigDecimal / similar\n' +
        '   on stdin and the runtime output shows NumberFormatException or\n' +
        '   NullPointerException, wrap the parse in try/catch default-zero\n' +
        '   and null-check the Scanner.nextLine() return (treat null as "").\n' +
        '10. PRESERVE PIC 9(N) zero-padding. COBOL DISPLAY of PIC 9(6) value 8\n' +
        '    prints "000008", not "8". If the current Java prints bare ints\n' +
        '    via System.out.print(x) or "%d", replace with String.format("%0Nd", x)\n' +
        '    where N matches the PIC width declared in the COBOL source.\n' +
        '\n' +
        'Respect the same conventions as the original agent:\n' +
        '- One public class per file, no package declaration\n' +
        '- No `final` on instance fields. If a field is reassigned anywhere\n' +
        '  (constructor, method body, business logic), it MUST be non-final.\n' +
        '  COBOL WORKING-STORAGE is mutable by default — generated fields\n' +
        '  should be too. Remove `final` if a reassignment appears below.\n' +
        '- No `final` on method parameters. It\'s legal but over-constrains.\n' +
        '- No `abstract` on a class unless it declares abstract methods.\n' +
        '  Converted COBOL programs are concrete; abstract-on-concrete is\n' +
        '  a compile error for any caller trying to instantiate.\n' +
        '- Pure-string / computational helper methods (no file, network, or\n' +
        '  system I/O inside) MUST NOT declare `throws IOException`. Only\n' +
        '  methods that actually call something throwing IOException may.\n' +
        '- Initialize EVERY declared primitive / BigDecimal / String field\n' +
        '  at declaration (int=0, double=0.0, boolean=false, BigDecimal.ZERO,\n' +
        '  "" for String). Uninitialized-then-used fields cause NPE at run.\n' +
        '- If the COBOL has a PROCEDURE DIVISION, ensure a `public static\n' +
        '  void main(String[] args)` exists that instantiates the class and\n' +
        '  calls the business-logic method. The class is unusable otherwise.\n' +
        '- No Scanner; no interactive input — use hardcoded demo values\n' +
        '- Initialize ALL variables at declaration\n' +
        '- Include all necessary imports (java.io.*, java.util.*, java.math.*)\n' +
        '- main() wraps in try-catch with Exception handling\n' +
        '- Print "=== Program Started ===" / "=== Program Completed ===" banners\n' +
        '\n' +
        'Output ONLY the complete, corrected Java source. No explanations, no\n' +
        'markdown fences, no commentary — just the raw Java file.';

    const depBlock = (dependencies && Object.keys(dependencies).length > 0)
        ? 'Sibling Java classes available (you CAN call these via `new ClassName().run(...)`):\n'
          + Object.entries(dependencies).map(([pid, cls]) => `  - PROGRAM-ID ${pid} → class ${cls}`).join('\n')
        : 'No sibling Java classes are available for CALL targets — emit // TODO instead of simulating.';

    // Source material is sent FULL — matches the primary convertCobolToJava
    // policy so the repair agent sees every line. Runtime stdout (cobolOutput
    // / runOutput) stays head+tail-snipped because stuck-in-a-loop programs
    // produce megabytes of repetitive text; first+last few KB tell the story.
    // Render comparator verdict + output files + runtime errors when the
    // caller (Run-panel Fix-with-AI) supplied them. These give the repair
    // agent the SPECIFIC divergence the user is looking at, not just
    // generic "Java didn't match COBOL" — e.g. "COBOL wrote 45 rows to
    // PRTLINE totaling $23M; Java printed sample data totaling $10k".
    const verdictBlock = (comparatorVerdict && typeof comparatorVerdict === 'object')
        ? '=== AI COMPARATOR VERDICT (what just went wrong) ===\n' +
          `${comparatorVerdict.title || ''} [verdict=${comparatorVerdict.verdict || ''} severity=${comparatorVerdict.severity || ''}]\n` +
          (Array.isArray(comparatorVerdict.reasons) && comparatorVerdict.reasons.length
              ? comparatorVerdict.reasons.map(r => `- ${r}`).join('\n') + '\n'
              : '') +
          'Use this verdict as your PRIMARY repair target. The generic rules above still apply, but the fix must address what the comparator flagged.\n\n'
        : '';
    const cobolFilesBlock = (Array.isArray(cobolOutputFiles) && cobolOutputFiles.length)
        ? '=== COBOL OUTPUT FILES (canonical output for WRITE-to-file programs) ===\n' +
          cobolOutputFiles.map(f => `--- ${f.name} (${f.bytes} bytes) ---\n${snippet(f.contentPreview || '', 1200)}`).join('\n') + '\n\n'
        : '';
    const javaFilesBlock = (Array.isArray(javaOutputFiles) && javaOutputFiles.length)
        ? '=== CURRENT JAVA OUTPUT FILES ===\n' +
          javaOutputFiles.map(f => `--- ${f.name} (${f.bytes} bytes) ---\n${snippet(f.contentPreview || '', 1200)}`).join('\n') + '\n\n'
        : '';
    const runtimeErrBlock =
        (cobolError ? `=== COBOL RUNTIME / COMPILE ERROR ===\n${snippet(cobolError, 800)}\n\n` : '') +
        (javaError  ? `=== JAVA RUNTIME / COMPILE ERROR ===\n${snippet(javaError, 800)}\n\n`   : '');

    // Graph edges involving this file tell the AI which CALL / COPY /
    // data / JCL targets it depends on — so the repair doesn't lose a
    // relationship the initial conversion got right. Sibling signatures
    // give real method shapes for CALLs the AI might otherwise re-stub.
    // JCL invocations surface DD-name → file-path mappings.
    const edgesBlock = (Array.isArray(graphEdges) && graphEdges.length)
        ? '=== DEPENDENCY GRAPH (edges touching this file) ===\n' +
          graphEdges.slice(0, 40).map(e => `  ${e.source} --${e.kind}--> ${e.target}${e.via ? ' (via ' + e.via + ')' : ''}`).join('\n') + '\n\n'
        : '';
    const sigsBlock = (siblingSignatures && typeof siblingSignatures === 'object' && Object.keys(siblingSignatures).length)
        ? '=== SIBLING CLASS SIGNATURES (use these exact signatures for CALLs) ===\n' +
          Object.entries(siblingSignatures).slice(0, 40).map(([name, sig]) => `  ${name}: ${sig}`).join('\n') + '\n\n'
        : '';
    const jclBlock = (Array.isArray(jclInvocations) && jclInvocations.length)
        ? '=== JCL INVOCATIONS OF THIS PROGRAM ===\n' +
          jclInvocations.slice(0, 10).map(inv => {
              const ddsText = (inv.dds || []).map(d => `${d.name}${d.dsn ? '=' + d.dsn : ''}${d.sysout ? '(SYSOUT)' : ''}`).join(', ');
              return `  ${inv.jclFile} step ${inv.stepName}${ddsText ? ' — DDs: ' + ddsText : ''}`;
          }).join('\n') + '\n\n'
        : '';

    const userPrompt =
        `=== ORIGINAL COBOL ===\n${cobolSource}\n\n` +
        `=== CURRENT JAVA (needs fixing) ===\n${javaCode}\n\n` +
        verdictBlock +
        (compileErrors ? `=== COMPILE ERRORS ===\n${compileErrors}\n\n` : '') +
        runtimeErrBlock +
        (cobolOutput ? `=== WHAT COBOL OUTPUTS WHEN RUN ===\n${snippet(cobolOutput, 1500)}\n\n` : '') +
        (runOutput   ? `=== WHAT CURRENT JAVA OUTPUTS ===\n${snippet(runOutput, 1500)}\n\n`   : '') +
        cobolFilesBlock +
        javaFilesBlock +
        edgesBlock +
        sigsBlock +
        jclBlock +
        `=== DEPENDENCIES ===\n${depBlock}\n\n` +
        `Produce the corrected Java file.`;

    // Fire the caller-supplied prompt-ready callback (e.g. the /api/fix-java
    // SSE emitter) BEFORE the AI call so the UI can render the full prompt
    // as a debugging attachment even if the AI request hangs or times out.
    try {
        if (typeof onPromptReady === 'function') {
            onPromptReady({ systemPrompt, userPrompt });
        }
    } catch { /* non-fatal */ }

    try {
        const response = await makeOpenAIRequest(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ],
            { temperature: 0.15, maxTokens: 16000 }
        );
        let content = response?.choices?.[0]?.message?.content || '';
        content = content.replace(/^```(?:java)?\n?/i, '').replace(/\n?```$/i, '').trim();
        if (!content || content.length < 50 || !/class\s+\w+/.test(content)) {
            return { success: false, error: 'AI did not return valid Java source', usage: response?.usage };
        }
        // Apply existing auto-fixes for consistency
        const finalCode = autoFixJavaCode(content);
        return { success: true, javaCode: finalCode, usage: response?.usage };
    } catch (err) {
        return { success: false, error: err.message || 'AI call failed' };
    }
}

module.exports = { fixJavaCode };
