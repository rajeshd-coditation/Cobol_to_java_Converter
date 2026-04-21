/**
 * Regex-based Java post-processing that the converter runs on every AI
 * response before writing to disk. Fixes common mistakes the model makes
 * that would otherwise cascade into compile errors the user has to chase
 * down through /api/run or /api/fix-java.
 *
 * Two public functions:
 *
 *   autoFixJavaCode(javaCode) → javaCode
 *     A flat chain of ~32 small patches. Each is narrowly scoped — most
 *     add a missing import when a symbol is referenced but not imported.
 *     A few are more invasive (Fixes 2b–2f) and are documented inline.
 *     Set DISABLE_AUTOFIX=1 to turn the whole chain off (for A/B tests
 *     that measure the net effect on compile/run outcomes).
 *
 *   detectTruncation(javaCode, finishReason) → bool
 *     Catches "the AI ran out of tokens mid-class" using two signals:
 *     finish_reason === 'length' (authoritative when Azure sets it) +
 *     brace-balance + "last non-whitespace char is }". Naive brace count
 *     works after stripping comments and string literals.
 *
 * Why this lives in core (not ai): no API calls, no azureConfig, purely
 * text-in/text-out. That also makes it unit-testable deterministically —
 * the fidelity test suite asserts that Fixes 2c/2d behave correctly on
 * the adversarial inputs that motivated them (illegal `throws` on control
 * flow, helper-name whitelist throws stripping). Tests in tests/fidelity.test.js.
 *
 * Why regex and not "just ask the AI"? Three reasons: (1) the fidelity
 * rules are deterministic — a regex pass is instant and can't disagree
 * with itself across calls; (2) repair loops spend tokens, so catching
 * the easy mistakes here saves cost and latency; (3) A/B tested on a
 * CardDemo subset — arm A (patches ON) got 9/10 SUCCESS vs 0/10 with
 * the patches disabled. The patches are net-positive despite the "too
 * much regex" feel. Revisit when repair convergence improves enough to
 * amortize the retry cost.
 *
 * ───── Audit matrix (2026-04-21) ─────────────────────────────────────
 * Every fix is tagged inline with one of these categories so future
 * maintainers know whether it's safe to retire:
 *
 *   [universal]    — JDK-level correctness. Stays regardless of which
 *                    model emits the code. Example: import java.math.BigDecimal;
 *                    when BigDecimal is referenced. Safe to keep forever.
 *   [ai-specific]  — Patches a mistake a specific model class kept making.
 *                    Candidate for retirement if prompt tightening makes
 *                    the mistake stop. Verify with a DISABLE_AUTOFIX A/B
 *                    before removing.
 *   [safety]       — Defensive removal / neutering of unsupported
 *                    constructs (Scanner, package statements) that the
 *                    single-file compile gate can't handle. Stays as
 *                    long as the single-file compile path does.
 *   [locked]       — Has an explicit regression test in fidelity.test.js
 *                    (test numbers noted). Changes here need the test
 *                    updated or deleted.
 *
 *   Fix  1–2   [universal]  BigDecimal / RoundingMode imports
 *   Fix  2b    [ai-specific] auto-add throws Exception on try-with-resources I/O methods
 *   Fix  2c    [ai-specific][locked #14] strip illegal throws on for/while/if/switch/do
 *   Fix  2d    [ai-specific][locked #15] strip throws IOException from pure-string helpers
 *   Fix  2e    [ai-specific] propagate throws from callee to caller
 *   Fix  2f    [ai-specific] strip final from static fields that are later reassigned
 *   Fix  3–4   [safety]     strip Scanner — single-file compile can't handle stdin
 *   Fix  6     [ai-specific] synthesize a main() that calls business logic
 *   Fix  7     [safety]     demote duplicate `public class` to `class`
 *   Fix  8     [ai-specific] initialize declared-but-unset primitives
 *   Fix  9–10  [ai-specific] strip final from instance fields assigned later
 *   Fix 11–14  [universal]  ArrayList/List/Map/HashMap/File I/O imports
 *   Fix 15     [ai-specific] fix unclosed string literals (basic detection)
 *   Fix 16     [safety]     pad unbalanced braces at EOF
 *   Fix 17     [universal]  dedup import statements
 *   Fix 18–21  [universal]  Arrays/Date/LocalDate/DecimalFormat/NumberFormat/Pattern/Matcher imports
 *   Fix 22     [safety]     strip package statements (single-file compile)
 *   Fix 23     [universal]  FileNotFoundException import
 *   Fix 24     [ai-specific] strip `abstract` on concrete classes
 *   Fix 25     [universal]  Collections import
 *   Fix 26     [ai-specific] strip `final` on method parameters
 *   Fix 27     [universal]  repair common typos (pubic → public, etc.)
 *   Fix 28–29  [universal]  Optional / Stream imports
 *   Fix 30     [safety]     collapse ;; → ;
 *   Fix 31     [universal]  ChronoField import
 *   Fix 32     [safety]     strip stale Scanner.close() calls (pairs with Fix 3/4)
 *
 * Retirement candidates (if future prompt work makes the AI stop emitting
 * the pattern): 2b, 2e, 2f, 6, 8, 9-10, 24, 26. Keep universal + safety +
 * locked indefinitely.
 *
 * ───── Prompt reinforcement (2026-04-21) ─────────────────────────────
 * The PRIMARY conversion prompt (src/ai/convert-cobol.js) and the REPAIR
 * prompt (src/ai/fix-java.js) both now carry explicit bans for the
 * patterns 2d/2f/6/8/9-10/11/24/26 fix (final-on-mutable-fields,
 * final-on-parameters, abstract-on-concrete-class, throws-on-pure-string,
 * missing-main, unset-primitives). These rules are locked via fidelity
 * tests — see `primary prompt explicitly bans…` tests in §23 of the
 * test file. The patches stay active as a belt-and-suspenders; when a
 * future A/B (DISABLE_AUTOFIX=1) shows a particular [ai-specific] patch
 * never fires across ≥ 20 representative files, retire it one at a time.
 */

function autoFixJavaCode(javaCode) {
    // A/B switch: set DISABLE_AUTOFIX=1 to bypass the whole chain so
    // experiments can measure the raw AI output without patches.
    if (process.env.DISABLE_AUTOFIX === '1') return javaCode;
    let fixedCode = javaCode;

    // Fix 1: Ensure BigDecimal import if used
    if (fixedCode.includes('BigDecimal') && !fixedCode.includes('import java.math.BigDecimal')) {
        fixedCode = 'import java.math.BigDecimal;\nimport java.math.RoundingMode;\n' + fixedCode;
    }

    // Fix 2: Ensure RoundingMode import if used
    if (fixedCode.includes('RoundingMode') && !fixedCode.includes('import java.math.RoundingMode')) {
        if (!fixedCode.includes('import java.math.RoundingMode')) {
            fixedCode = fixedCode.replace('import java.math.BigDecimal;',
                'import java.math.BigDecimal;\nimport java.math.RoundingMode;');
        }
    }

    // Fix 2b [ai-specific]: auto-add `throws Exception` to methods that
    // use try-with-resources for I/O. The implicit close() on BufferedReader etc.
    // throws IOException; without the declaration javac fails with
    // "unreported exception IOException; must be caught or declared".
    // Wide-net by design: main()'s try/catch already catches Exception
    // so over-declaring here is strictly safe.
    {
        const methodRe = /((public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\([^)]*\))(\s*(throws\s+[\w,\s]+)?\s*)(\{)/g;
        fixedCode = fixedCode.replace(methodRe, (match, sig, _t, between, existingThrows, brace, offset, whole) => {
            // Peek ~2000 chars into the body to see if it needs IOException.
            // Cheap shortcut — don't walk brace balance for this one.
            const bodySlice = whole.substr(offset + match.length, 2000);
            const needsIO =
                /\btry\s*\(\s*(?:java\.io\.)?(?:Buffered\w+|File(?:Reader|Writer|Input|Output)\w*|PrintWriter|DataInput\w*|DataOutput\w*)\b/.test(bodySlice) ||
                /\b\w+\.readLine\s*\(/.test(bodySlice) ||
                /\bnew\s+Buffered(?:Reader|Writer)\s*\(/.test(bodySlice);
            if (!needsIO) return match;
            if (existingThrows) {
                if (/Exception|IOException/.test(existingThrows)) return match;
                const updated = existingThrows.replace(/throws\s+/, 'throws java.io.IOException, ');
                return sig + between.replace(existingThrows, updated) + brace;
            }
            return sig + ' throws java.io.IOException ' + brace;
        });
    }

    // Fix 2c [ai-specific][locked: test #14]: strip ILLEGAL `throws` clauses. AI sometimes emits
    // `for (...) throws IOException {`, `while (...) throws {`, etc.
    // `throws` is only legal on method signatures. Both the initial
    // converter and the repair agent replicated this mistake, so
    // deterministic stripping is the only reliable fix.
    {
        const illegalThrowsRe = /\b(for|while|if|else\s+if|switch|do)\b([^{\n]*?)\s+throws\s+[\w.,\s]+(?=\s*\{)/g;
        fixedCode = fixedCode.replace(illegalThrowsRe, '$1$2');
        // Standalone `else throws { ... }` / `do throws { ... }` — no parens.
        fixedCode = fixedCode.replace(/\b(else|do)\s+throws\s+[\w.,\s]+(?=\s*\{)/g, '$1');
    }

    // Fix 2d [ai-specific][locked: test #15]: strip `throws IOException` from pure-string helper methods
    // that don't do I/O. AI sometimes decorates `static String repeatChar`
    // with `throws IOException` and then callsites like
    // `static final String FIELD = repeatChar(' ', 60);` fail with
    // "unreported exception IOException". Body-peek is scoped to THIS
    // method's brace balance so neighbor-method I/O can't leak in.
    //
    // Narrow helper-name whitelist — A/B tested on CBL0011: the wider
    // "body-signal only" variant rescued 1 file but regressed another.
    // Expand the whitelist when real repos surface new names.
    {
        const ioSignals = /\b(?:Buffered(?:Reader|Writer)|FileReader|FileWriter|FileInputStream|FileOutputStream|PrintWriter|DataInputStream|DataOutputStream|RandomAccessFile|InputStream|OutputStream)\b|\bIOException\b|\.(?:readLine|newLine|flush|write|writeBytes|writeChars)\s*\(|Files\.(?:read|write|lines|newBufferedReader|newBufferedWriter|delete|copy|move|exists|createFile|createDirectory)|Paths\.get|\bthrow\s+new\s+/;
        const findBodyEnd = (code, openBraceIdx) => {
            let depth = 1;
            for (let i = openBraceIdx + 1; i < code.length; i++) {
                const ch = code[i];
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) return i;
                }
            }
            return -1;
        };
        const helperNameRe = /(?:repeat\w*|pad(?:Right|Left|Spaces)?(?:Static)?|format(?:Money|Number|Date|Amount)?\w*|to(?:Ascii|String|Upper|Lower|Padded)?|trunc\w*|fill\w*|spaces\w*|stringOf\w*|leftJustify|rightJustify|center\w*|blank\w*|normalize\w*|fixedLength\w*|fixedWidth\w*|rightPad\w*|leftPad\w*|align\w*|zeroFill\w*|zeroPad\w*)/.source;
        // Visibility modifier optional — helpers inside nested static classes
        // are often package-private. The helper-name whitelist already
        // constrains the match enough that a control-flow keyword can't
        // false-match here.
        const methodRe = new RegExp(
            `(^|\\n)([ \\t]*(?:(?:public|private|protected|static|final|synchronized)\\s+)*[\\w<>\\[\\]]+\\s+${helperNameRe}\\s*\\([^)]*\\))\\s*throws\\s+(?:java\\.io\\.)?IOException\\s*(\\{)`,
            'g'
        );
        let m;
        const replacements = [];
        while ((m = methodRe.exec(fixedCode)) !== null) {
            const fullMatch = m[0];
            const prefix = m[1];
            const sig = m[2];
            const openBraceAbs = m.index + fullMatch.length - 1;
            const closeIdx = findBodyEnd(fixedCode, openBraceAbs);
            if (closeIdx === -1) continue;
            const body = fixedCode.slice(openBraceAbs + 1, closeIdx);
            if (ioSignals.test(body)) continue;
            replacements.push({ start: m.index, end: m.index + fullMatch.length, text: prefix + sig + ' {' });
        }
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            fixedCode = fixedCode.slice(0, r.start) + r.text + fixedCode.slice(r.end);
        }
    }

    // Fix 2e: propagate `throws` from callees to callers. Observed on
    // CBL0002: `void writeRecord() { pr.print(writer); }` where
    // `void print(...) throws IOException`. javac rejects the caller
    // with "unreported exception IOException". We scan every method
    // declaration, collect names that declare `throws IOException`,
    // then walk every OTHER method body for calls to those names and
    // add a compatible throws clause where missing.
    {
        // Strict return-type whitelist — primitive keyword, uppercase
        // class name (possibly generic/array), or java.* qualified type.
        // Excludes lowercase control-flow keywords so patterns like
        // `while (...) foo() {` can't match as a method declaration.
        const RETURN_TYPE = '(?:void|boolean|byte|short|int|long|float|double|char|(?:[A-Z]\\w*(?:<[^>]+>)?(?:\\s*\\[\\s*\\])*)|(?:java\\.[\\w.]+(?:<[^>]+>)?))';

        // Step 1: callee → exception-type map.
        const calleeThrows = {};
        const declRe = new RegExp(
            `(^|\\n)[ \\t]*(?:(?:public|private|protected|static|final|synchronized)\\s+)*${RETURN_TYPE}\\s+(\\w+)\\s*\\([^)]*\\)\\s+throws\\s+([\\w.,\\s]+?)\\s*\\{`,
            'g'
        );
        let dm;
        while ((dm = declRe.exec(fixedCode)) !== null) {
            const name = dm[2];
            const thrown = dm[3].trim();
            // Propagate only IO-ish checked exceptions. NumberFormat etc.
            // are RuntimeException; anything else the user declared
            // explicitly is out-of-scope.
            if (/\bIOException\b/.test(thrown) && !calleeThrows[name]) {
                calleeThrows[name] = 'java.io.IOException';
            }
        }
        const calleeNames = Object.keys(calleeThrows);
        if (calleeNames.length > 0) {
            const findBodyEnd = (code, openBraceIdx) => {
                let depth = 1;
                for (let i = openBraceIdx + 1; i < code.length; i++) {
                    const ch = code[i];
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) return i;
                    }
                }
                return -1;
            };
            const methodRe = new RegExp(
                `(^|\\n)([ \\t]*(?:(?:public|private|protected|static|final|synchronized)\\s+)*${RETURN_TYPE}\\s+(\\w+)\\s*\\([^)]*\\))(\\s*throws\\s+[\\w.,\\s]+)?\\s*(\\{)`,
                'g'
            );
            const edits = [];
            let mm;
            while ((mm = methodRe.exec(fixedCode)) !== null) {
                const preamble = mm[1];
                const sig = mm[2];
                const methodName = mm[3];
                const existingThrows = mm[4] || '';
                const openBraceAbs = mm.index + mm[0].length - 1;
                const closeIdx = findBodyEnd(fixedCode, openBraceAbs);
                if (closeIdx === -1) continue;
                const body = fixedCode.slice(openBraceAbs + 1, closeIdx);

                // Does this body call any throwing callee?
                let neededException = null;
                for (const callee of calleeNames) {
                    if (callee === methodName) continue;
                    const callRe = new RegExp(`(?:\\b|\\.)${callee}\\s*\\(`);
                    if (callRe.test(body)) {
                        neededException = calleeThrows[callee];
                        break;
                    }
                }
                if (!neededException) continue;

                // Already declares something compatible?
                if (/\bthrows\b[^{]*\b(?:Exception|IOException)\b/.test(existingThrows)) continue;

                const newSig = existingThrows
                    ? sig + existingThrows.replace(/throws\s+/, 'throws ' + neededException + ', ') + ' '
                    : sig + ' throws ' + neededException + ' ';
                edits.push({
                    start: mm.index,
                    end:   mm.index + mm[0].length,
                    text:  preamble + newSig + '{'
                });
            }
            for (let i = edits.length - 1; i >= 0; i--) {
                const e = edits[i];
                fixedCode = fixedCode.slice(0, e.start) + e.text + fixedCode.slice(e.end);
            }
        }
    }

    // Fix 2f: strip `final` from static fields that are reassigned.
    // Observed on CBL0010: AI declares `static final String HEADER = "";`
    // then assigns it in a `static { try { HEADER = "…"; } }` block.
    // javac rejects "cannot assign a value to static final variable".
    // Minimal safe fix: drop `final` on fields whose name appears on
    // the LHS of an assignment somewhere other than the declaration.
    {
        const fieldRe = /((?:public|private|protected|static|\s)+)final\s+((?:[\w<>\[\]]+\s+)+)(\w+)\s*(=|;)/g;
        const edits = [];
        let fm;
        while ((fm = fieldRe.exec(fixedCode)) !== null) {
            const fullMatch = fm[0];
            const index = fm.index;
            const name = fm[3];
            // `<name> =` outside this match, not part of `==`/`!=`/`<=`/`>=`.
            const assignRe = new RegExp(`(^|[^=!<>])\\b${name}\\s*=(?!=)`, 'gm');
            let match, reassigned = false;
            while ((match = assignRe.exec(fixedCode)) !== null) {
                if (match.index >= index && match.index < index + fullMatch.length) continue;
                reassigned = true;
                break;
            }
            if (!reassigned) continue;
            edits.push({
                start: index,
                end:   index + fullMatch.length,
                text:  fullMatch.replace(/\bfinal\s+/, '')
            });
        }
        for (let i = edits.length - 1; i >= 0; i--) {
            const e = edits[i];
            fixedCode = fixedCode.slice(0, e.start) + e.text + fixedCode.slice(e.end);
        }
    }

    // Fix 3: Remove Scanner imports (we don't use Scanner)
    fixedCode = fixedCode.replace(/import java\.util\.Scanner;\n?/g, '');

    // Fix 4: Fix Scanner usage - replace with hardcoded values
    fixedCode = fixedCode.replace(/Scanner\s+\w+\s*=\s*new\s+Scanner[^;]+;/g, '// Scanner removed');
    fixedCode = fixedCode.replace(/\w+\.nextLine\(\)/g, '"TEST"');
    fixedCode = fixedCode.replace(/\w+\.nextInt\(\)/g, '100');
    fixedCode = fixedCode.replace(/\w+\.nextDouble\(\)/g, '100.0');

    // Fix 6: Ensure main method exists and calls business logic
    if (!fixedCode.includes('public static void main')) {
        const classMatch = fixedCode.match(/public\s+class\s+(\w+)/);
        if (classMatch) {
            const className = classMatch[1];
            const lastBrace = fixedCode.lastIndexOf('}');
            if (lastBrace > 0) {
                const entryPointPatterns = [
                    /public\s+void\s+(run)\s*\(/,
                    /public\s+void\s+(runProgram)\s*\(/,
                    /public\s+void\s+(mainProcessing)\s*\(/,
                    /public\s+void\s+(execute)\s*\(/,
                    /public\s+void\s+(process)\s*\(/,
                    /public\s+void\s+(performMainLogic)\s*\(/,
                    /public\s+void\s+(startProgram)\s*\(/,
                    /public\s+void\s+(mainProcedure)\s*\(/,
                    /public\s+void\s+(procedureDivision)\s*\(/,
                    /private\s+void\s+(run)\s*\(/,
                    /private\s+void\s+(runProgram)\s*\(/,
                    /private\s+void\s+(mainProcessing)\s*\(/,
                    /private\s+void\s+(execute)\s*\(/,
                    /private\s+void\s+(process)\s*\(/,
                ];

                let entryPointMethod = null;
                for (const pattern of entryPointPatterns) {
                    const match = fixedCode.match(pattern);
                    if (match) {
                        entryPointMethod = match[1];
                        break;
                    }
                }

                let methodCall = '';
                if (entryPointMethod) {
                    methodCall = `p.${entryPointMethod}();`;
                } else {
                    methodCall = `System.out.println("=== ${className} Initialized ===");`;
                }

                const mainMethod = `
    public static void main(String[] args) {
        try {
            ${className} p = new ${className}();
            System.out.println("=== ${className} Started ===");
            ${methodCall}
            System.out.println("=== ${className} Completed ===");
        } catch (Exception e) {
            System.out.println("Error: " + e.getMessage());
            e.printStackTrace();
        }
    }
`;
                fixedCode = fixedCode.substring(0, lastBrace) + mainMethod + fixedCode.substring(lastBrace);
            }
        }
    }

    // Fix 7: Remove multiple public class declarations (keep only the first)
    const publicClassCount = (fixedCode.match(/public\s+class\s+\w+/g) || []).length;
    if (publicClassCount > 1) {
        let isFirst = true;
        fixedCode = fixedCode.replace(/public\s+class\s+(\w+)/g, (match, className) => {
            if (isFirst) {
                isFirst = false;
                return match;
            }
            return `class ${className}`;
        });
    }

    // Fix 8: Ensure all variables are initialized
    fixedCode = fixedCode.replace(/(\s+)(String\s+\w+)(\s*;)/g, '$1$2 = ""$3');
    fixedCode = fixedCode.replace(/(\s+)(int\s+\w+)(\s*;)/g, '$1$2 = 0$3');
    fixedCode = fixedCode.replace(/(\s+)(double\s+\w+)(\s*;)/g, '$1$2 = 0.0$3');
    fixedCode = fixedCode.replace(/(\s+)(boolean\s+\w+)(\s*;)/g, '$1$2 = false$3');

    // Fix 9: Remove 'final' from instance fields assigned in constructor
    const constructorAssignments = fixedCode.match(/this\.(\w+)\s*=/g) || [];
    const fieldNamesAssigned = constructorAssignments.map(m => m.match(/this\.(\w+)/)[1]);

    for (const fieldName of fieldNamesAssigned) {
        const finalFieldPattern = new RegExp(
            `(private|public|protected)\\s+final\\s+(\\w+(?:<[^>]+>)?(?:\\[\\])?)\\s+(${fieldName})\\s*[;=]`,
            'g'
        );
        fixedCode = fixedCode.replace(finalFieldPattern, '$1 $2 $3 =');

        const finalFirstPattern = new RegExp(
            `final\\s+(private|public|protected)\\s+(\\w+(?:<[^>]+>)?(?:\\[\\])?)\\s+(${fieldName})\\s*[;=]`,
            'g'
        );
        fixedCode = fixedCode.replace(finalFirstPattern, '$1 $2 $3 =');
    }

    // Fix 10: Remove 'final' from non-static primitive fields with no initializer
    // (typically meant to be assigned in constructor)
    fixedCode = fixedCode.replace(
        /(private|public|protected)\s+final\s+(String|int|long|double|float|boolean|char|byte|short)\s+(\w+)\s*;/g,
        '$1 $2 $3;'
    );

    // Fixes 11-14: collection / IO imports
    if (fixedCode.includes('ArrayList') && !fixedCode.includes('import java.util.ArrayList')) {
        fixedCode = 'import java.util.ArrayList;\n' + fixedCode;
    }
    if (fixedCode.includes('List<') && !fixedCode.includes('import java.util.List')) {
        fixedCode = 'import java.util.List;\n' + fixedCode;
    }
    if ((fixedCode.includes('Map<') || fixedCode.includes('HashMap')) && !fixedCode.includes('import java.util.Map')) {
        fixedCode = 'import java.util.Map;\nimport java.util.HashMap;\n' + fixedCode;
    }
    if ((fixedCode.includes('BufferedReader') || fixedCode.includes('BufferedWriter') || fixedCode.includes('FileReader') || fixedCode.includes('FileWriter'))
        && !fixedCode.includes('import java.io.')) {
        fixedCode = 'import java.io.*;\n' + fixedCode;
    }

    // Fix 15: Fix unclosed string literals (basic detection)
    const lines = fixedCode.split('\n');
    const fixedLines = lines.map(line => {
        const quoteMatches = line.match(/(?<!\\)"/g) || [];
        if (quoteMatches.length % 2 !== 0 && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            if (line.includes(';')) {
                return line.replace(/;([^;]*)$/, '";$1');
            }
        }
        return line;
    });
    fixedCode = fixedLines.join('\n');

    // Fix 16: Ensure balanced braces (add closing brace if missing)
    const openBraces = (fixedCode.match(/{/g) || []).length;
    const closeBraces = (fixedCode.match(/}/g) || []).length;
    if (openBraces > closeBraces) {
        const missingBraces = openBraces - closeBraces;
        for (let i = 0; i < missingBraces; i++) {
            fixedCode += '\n}';
        }
    }

    // Fix 17: Remove duplicate import statements
    const importLines = [];
    const nonImportLines = [];
    fixedCode.split('\n').forEach(line => {
        if (line.trim().startsWith('import ')) {
            if (!importLines.includes(line.trim())) {
                importLines.push(line.trim());
            }
        } else {
            nonImportLines.push(line);
        }
    });
    fixedCode = importLines.join('\n') + '\n' + nonImportLines.join('\n');

    // Fixes 18-21: more imports
    if (fixedCode.includes('Arrays.') && !fixedCode.includes('import java.util.Arrays')) {
        fixedCode = 'import java.util.Arrays;\n' + fixedCode;
    }
    if ((fixedCode.includes('Date ') || fixedCode.includes('new Date(')) && !fixedCode.includes('import java.util.Date') && !fixedCode.includes('import java.time.')) {
        fixedCode = 'import java.util.Date;\n' + fixedCode;
    }
    if (fixedCode.includes('LocalDate') && !fixedCode.includes('import java.time.LocalDate')) {
        fixedCode = 'import java.time.LocalDate;\nimport java.time.format.DateTimeFormatter;\n' + fixedCode;
    }
    if (fixedCode.includes('DecimalFormat') && !fixedCode.includes('import java.text.DecimalFormat')) {
        fixedCode = 'import java.text.DecimalFormat;\n' + fixedCode;
    }
    if (fixedCode.includes('NumberFormat') && !fixedCode.includes('import java.text.NumberFormat')) {
        fixedCode = 'import java.text.NumberFormat;\n' + fixedCode;
    }
    if ((fixedCode.includes('Pattern.') || fixedCode.includes('Matcher ')) && !fixedCode.includes('import java.util.regex')) {
        fixedCode = 'import java.util.regex.Pattern;\nimport java.util.regex.Matcher;\n' + fixedCode;
    }

    // Fix 22: Remove package statements (single-file compilation).
    fixedCode = fixedCode.replace(/^package\s+[\w.]+;\s*\n/gm, '');

    // Fix 23: FileNotFoundException import if referenced
    if (fixedCode.includes('FileNotFoundException') && !fixedCode.includes('import java.io.FileNotFoundException') && !fixedCode.includes('import java.io.*')) {
        fixedCode = 'import java.io.FileNotFoundException;\n' + fixedCode;
    }

    // Fix 24: Remove abstract from class if it has no abstract methods
    fixedCode = fixedCode.replace(/abstract\s+class/g, 'class');

    // Fix 25: Collections import
    if (fixedCode.includes('Collections.') && !fixedCode.includes('import java.util.Collections')) {
        fixedCode = 'import java.util.Collections;\n' + fixedCode;
    }

    // Fix 26: Remove 'final' from method parameters
    fixedCode = fixedCode.replace(/\(\s*final\s+/g, '(');
    fixedCode = fixedCode.replace(/,\s*final\s+/g, ', ');

    // Fix 27: Fix common typos
    fixedCode = fixedCode.replace(/pubic\s+/g, 'public ');
    fixedCode = fixedCode.replace(/privte\s+/g, 'private ');
    fixedCode = fixedCode.replace(/retrun\s+/g, 'return ');

    // Fixes 28-29: Optional + Stream imports
    if (fixedCode.includes('Optional<') && !fixedCode.includes('import java.util.Optional')) {
        fixedCode = 'import java.util.Optional;\n' + fixedCode;
    }
    if (fixedCode.includes('.stream()') && !fixedCode.includes('import java.util.stream')) {
        fixedCode = 'import java.util.stream.Collectors;\nimport java.util.stream.Stream;\n' + fixedCode;
    }

    // Fix 30: Fix double semicolons
    fixedCode = fixedCode.replace(/;;/g, ';');

    // Fix 31: ChronoField import
    if (fixedCode.includes('ChronoField') && !fixedCode.includes('import java.time.temporal.ChronoField')) {
        fixedCode = 'import java.time.temporal.ChronoField;\n' + fixedCode;
    }

    // Fix 32: Remove lingering scanner.close() calls
    fixedCode = fixedCode.replace(/\w+\.close\(\);\s*\/\/\s*close scanner/gi, '// scanner closed');
    fixedCode = fixedCode.replace(/scanner\.close\(\);?/gi, '// scanner closed');

    return fixedCode;
}

function detectTruncation(javaCode, finishReason) {
    if (finishReason === 'length') return true;
    if (!javaCode || javaCode.length < 50) return false;

    // Strip comments / string / char literals so literal braces in text
    // don't skew the count.
    const stripped = javaCode
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");

    let open = 0, close = 0;
    for (const ch of stripped) {
        if (ch === '{') open++;
        else if (ch === '}') close++;
    }
    if (open !== close) return true;

    const trimmed = javaCode.trimEnd();
    const lastChar = trimmed[trimmed.length - 1];
    // Valid Java files end in `}` (closing the outer class).
    return lastChar !== '}';
}

module.exports = { autoFixJavaCode, detectTruncation };
