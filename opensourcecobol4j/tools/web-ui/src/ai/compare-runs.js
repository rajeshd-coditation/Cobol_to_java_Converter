/**
 * AI-backed comparison of COBOL-native vs generated-Java runtime output.
 *
 * Regex-based diff is too brittle for this — the outputs can legitimately
 * differ in formatting (e.g. trailing-space padding from COBOL's PIC X vs
 * Java's trim(), or numeric formatting drift) while still representing
 * the same business behavior. And conversely a failure mode can match in
 * structure but mean different things depending on context.
 *
 * The comparator takes:
 *   - both raw stdout/stderr captures
 *   - exit codes + timeout flags
 *   - OPTIONAL original sources (cobolSource, javaCode) — when provided
 *     it can reason about which DISPLAY produced which line, catching
 *     "different numeric result" as expected transformation vs real bug.
 *
 * Returns a structured verdict:
 *   { verdict: 'match' | 'partial' | 'diverge',
 *     severity: 'ok' | 'info' | 'warning' | 'error',
 *     title: string,
 *     reasons: string[] }
 *
 * Fidelity rule enforced here: a COBOL run that exits with libcob
 * "status 35" (missing input file) vs a Java run that prints "Input
 * file not found, using sample data for demonstration" MUST be classed
 * as `diverge` / severity='error' — that's the banned fabricated-
 * fallback we reject at conversion time, and we can't let the
 * comparator pretend it's a match.
 */

const { isAvailable, makeOpenAIRequest } = require('./azure-client');

/**
 * Ask the AI to compare the runtime output of the original COBOL vs the
 * generated Java and render a human-readable verdict. Used by the "Run and
 * compare" panel to replace brittle regex heuristics with a semantic check.
 *
 * @param {object} p
 * @param {string} p.cobolOutput - captured stdout/stderr from the COBOL run
 * @param {string} p.javaOutput  - captured stdout/stderr from the Java run
 * @param {number|null} [p.cobolExit]
 * @param {number|null} [p.javaExit]
 * @param {boolean} [p.cobolTimedOut]
 * @param {boolean} [p.javaTimedOut]
 * @param {string} [p.fileName]
 * @param {string} [p.cobolSource] - optional original COBOL source. When provided,
 *        the comparator can reason about which DISPLAY statement produced which
 *        line, catching "different numeric result" as expected transformation
 *        vs real divergence.
 * @param {string} [p.javaCode] - optional generated Java source. Same rationale
 *        as cobolSource — lets the comparator verify the Java actually implements
 *        what the COBOL intended, not just that both produced similar strings.
 * @returns {Promise<{verdict:'match'|'partial'|'diverge', severity:'ok'|'info'|'warning'|'error', title:string, reasons:string[]}>}
 */
async function compareRunOutputs(p) {
    if (!isAvailable()) {
        return {
            verdict: 'unknown', severity: 'info',
            title: 'AI unavailable',
            reasons: ['Azure AI is not configured — output comparison is skipped.']
        };
    }

    // Keep the payload bounded to avoid token bloat; outputs from stuck programs
    // can be 10MB. Take head+tail so we see both the start AND whether it ended.
    const snippet = (s) => {
        if (!s) return '(empty)';
        if (s.length <= 4000) return s;
        return s.slice(0, 2000) + `\n…[${s.length - 4000} chars elided]…\n` + s.slice(-2000);
    };

    const systemPrompt =
        'You are a mainframe-modernization reviewer. You receive the runtime' +
        ' output of a COBOL program and the runtime output of the Java conversion' +
        ' of that same program, run with identical input. Decide whether they' +
        ' represent EQUIVALENT program behavior or meaningfully DIVERGE.\n\n' +
        'CRITICAL: distinguish source/toolchain issues from semantic divergence.\n' +
        'If the COBOL side reports a COMPILE error (text like "compile failed",' +
        '"error:", "is not defined", "unexpected", "syntax error"), that is a' +
        ' source-code or toolchain issue — NOT a behavioral divergence between' +
        ' the two programs. Label it verdict="partial" severity="warning" with' +
        ' title "COBOL source will not compile" and explain the compile error' +
        ' briefly. The Java output in that case is not comparable.\n' +
        'Similarly if Java fails to compile while COBOL runs — source issue, not' +
        ' divergence.\n\n' +
        'Be pragmatic about the actual behavior comparison:\n' +
        '- Different amounts of padded whitespace, minor formatting, or extra' +
        '  debug lines on one side are NOT divergence if the business outcome' +
        '  matches.\n' +
        '- Both programs getting stuck in the same input-waiting loop (truncated' +
        '  output, killed by timeout) is a *matched* failure mode — NOT divergence.\n' +
        '- COBOL "file does not exist (status = 35)" paired with Java "using' +
        '  sample data for demonstration" is DIVERGENT: the Java is fabricating' +
        '  input the COBOL did not have. Verdict="diverge" severity="error"' +
        '  with a reason that the Java conversion must be regenerated to fail' +
        '  on missing input (print error + non-zero exit), not substitute data.\n' +
        '- COBOL status 35 paired with a Java FileNotFoundException /' +
        '  non-zero exit on the same file is a MATCHED failure mode — both' +
        '  programs correctly refused to run without the input. Label "match"' +
        '  (or "partial" if output formatting differs) with a hint to stage' +
        '  the data file before re-running.\n' +
        '- COBOL output "unavailable" + "requires DB2/CICS/IMS preprocessor"' +
        '  means COBOL could not compile or run in this local environment —' +
        '  NOT a behavioral difference with Java. If the Java side exits' +
        '  correctly on missing input (status = 35, FileNotFoundException,' +
        '  System.exit(1)), that is FAITHFUL behavior matching what COBOL' +
        '  would do on a real mainframe. Do NOT label this "divergence" and' +
        '  do NOT call Java "fabricating" — Java is doing exactly what the' +
        '  fidelity rule requires. Verdict="partial" severity="info" title' +
        '  "COBOL unrunnable locally — Java behavior acceptable" with a' +
        '  reason that a DB2/CICS/IMS-capable environment is needed for a' +
        '  true runtime comparison.\n' +
        '- Treat as DIVERGENT: different numeric results, different control flow' +
        '  where BOTH actually ran, one side simulating (mock/sample/stub) while' +
        '  the other is real business logic, one side loading an external module' +
        '  that the other does not, or the Java inventing behavior (HTTP, JSON,' +
        '  auth) absent from the COBOL.\n\n' +
        'Respond in JSON only. Shape:\n' +
        '{\n' +
        '  "verdict":  "match" | "partial" | "diverge",\n' +
        '  "severity": "ok" | "info" | "warning" | "error",\n' +
        '  "title":    "<5-10 word summary>",\n' +
        '  "reasons":  ["<concise reason>", "..."]\n' +
        '}\n' +
        'Keep reasons <= 3 and each one actionable.';

    // Source is sent in full when available so the comparator can cite specific
    // DISPLAY statements / computations. Outputs stay head+tail-snippet because
    // stuck programs can produce megabytes of repetitive text.
    const userPrompt =
        `File: ${p.fileName || 'unknown'}\n` +
        `COBOL exit code: ${p.cobolExit ?? 'unknown'} (timedOut=${!!p.cobolTimedOut})\n` +
        `Java  exit code: ${p.javaExit ?? 'unknown'} (timedOut=${!!p.javaTimedOut})\n` +
        (p.cobolSource ? `\n=== ORIGINAL COBOL SOURCE ===\n${p.cobolSource}\n` : '') +
        (p.javaCode    ? `\n=== GENERATED JAVA SOURCE ===\n${p.javaCode}\n`    : '') +
        (p.cobolError ? `\n=== COBOL TOOLCHAIN ERROR (compile/run side) ===\n${snippet(p.cobolError)}\n` : '') +
        (p.javaError  ? `\n=== JAVA TOOLCHAIN ERROR (compile/run side) ===\n${snippet(p.javaError)}\n`  : '') +
        `\n=== COBOL OUTPUT ===\n${snippet(p.cobolOutput)}\n\n` +
        `=== JAVA OUTPUT ===\n${snippet(p.javaOutput)}\n`;

    try {
        const response = await makeOpenAIRequest(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ],
            { temperature: 0.1, maxTokens: 500 }
        );
        let content = response?.choices?.[0]?.message?.content || '';
        // Strip code fences if present
        content = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        let parsed;
        try { parsed = JSON.parse(content); }
        catch {
            // Recover: try to find the first {...} block
            const m = content.match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
        }
        if (!parsed || typeof parsed !== 'object') {
            return {
                verdict: 'unknown', severity: 'info',
                title: 'AI response unparseable',
                reasons: [String(content).slice(0, 300) || 'Empty response']
            };
        }
        // Clamp to known shape / defaults
        const verdict = ['match', 'partial', 'diverge'].includes(parsed.verdict) ? parsed.verdict : 'unknown';
        const severity = ['ok', 'info', 'warning', 'error'].includes(parsed.severity)
            ? parsed.severity
            : (verdict === 'match' ? 'ok' : verdict === 'partial' ? 'info' : 'warning');
        return {
            verdict,
            severity,
            title: String(parsed.title || (verdict === 'match' ? 'Outputs match' : verdict === 'partial' ? 'Outputs mostly match' : 'Outputs diverge')).slice(0, 120),
            reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5).map(r => String(r).slice(0, 300)) : []
        };
    } catch (err) {
        return {
            verdict: 'unknown', severity: 'info',
            title: 'Comparison unavailable',
            reasons: [err.message || 'AI call failed']
        };
    }
}
module.exports = { compareRunOutputs };
