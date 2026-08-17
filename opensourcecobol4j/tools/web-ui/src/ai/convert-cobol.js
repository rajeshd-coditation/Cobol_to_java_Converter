/**
 * Primary COBOL → Java conversion prompt path.
 *
 * One Chat Completions call per invocation. The system prompt is the source
 * of truth for the fidelity rules that came out of §22 / §23:
 *   - FAITHFUL CONVERSION: no fabricated-fallback data, fail the way the
 *     COBOL fails when inputs are missing.
 *   - ACCEPT FROM SYSIN: lossy/forgiving — Java must NOT throw on bad input,
 *     must default to 0 on NumberFormatException, must null-check Scanner.
 *   - PIC 9(N) DISPLAY: zero-padded width — use String.format("%0Nd", v).
 *
 * Every rule here has a matching string-match test in tests/fidelity.test.js
 * so a prompt edit that silently drops a rule fails CI before it ships.
 *
 * Retry policy: up to 2 retries (3 attempts total). Each attempt uses a
 * different system prompt (primary → simplified → minimal); if all three
 * produce Java that detectTruncation() flags or that's shorter than 100
 * bytes, we return { success: false, error } and the caller decides whether
 * to move on or repair via /api/fix-java.
 *
 * Optional `context` block — when present the caller passes:
 *   calledPrograms        names the COBOL source CALLs
 *   copybooks             names the COBOL source COPYs
 *   programIdToJavaClass  PROGRAM-ID → Java class name for siblings in the
 *                         same run. Lets the AI emit real calls instead of
 *                         "simulated" stubs.
 *   copybookBodies        PROGRAM-ID → copybook source text (actual .cpy).
 *                         Inlined verbatim so the AI sees real field
 *                         definitions instead of guessing.
 *   siblingSignatures     PROGRAM-ID → public-method signature line of the
 *                         already-converted sibling. Lets the AI emit
 *                         correct parameter lists on `new Foo().run(...)`.
 *   jclInvocations        JCL steps that invoke this program. Lets the AI
 *                         generate Java file paths that use real DD names
 *                         instead of guessing what SELECT…ASSIGN maps to.
 *
 * Output goes through autoFixJavaCode() before returning — adds missing
 * imports, strips illegal `throws` patterns, propagates throws to callers.
 * See src/core/auto-fix-java.js for the full patch list.
 */

const { isAvailable, getConfig, makeOpenAIRequest } = require('./azure-client');
const { autoFixJavaCode, detectTruncation } = require('../core/auto-fix-java');

async function convertCobolToJava(cobolSource, retryCount = 0, context = {}) {
    if (!isAvailable()) {
        return {
            success: false,
            error: 'Azure AI not initialized. Configure AZURE_OPENAI_* in .env file.'
        };
    }

    const MAX_RETRIES = 2; // Will try 3 times total

    try {
        let javaCode;
        let capturedUsage = null;

        // Single path: Chat Completions. The Assistants/Agent API branch that
        // lived here was removed — it had no retry/truncation detection, no
        // conversion context, and duplicated prompt rules that leaked out of
        // sync. Chat Completions works identically for Azure OpenAI + Foundry.
        {
            console.log('   Using Azure AI Chat Completions...');

            // Use different prompts for retries to improve success chance
            const systemPrompts = [
                // Primary prompt - detailed instructions for HIGH QUALITY conversion
                `You are an expert COBOL to Java modernization agent. Generate PRODUCTION-QUALITY, COMPILABLE, RUNNABLE Java 8+ code.

CRITICAL: FAITHFUL CONVERSION — DO NOT FABRICATE INPUT DATA
The converted Java must faithfully reproduce what the ORIGINAL COBOL does.
Do NOT invent fallback behavior the COBOL doesn't have:
- If the COBOL opens a file and fails when it's missing, Java must ALSO fail
  when the file is missing (throw the exception, exit non-zero).
- Do NOT add "if file not found, use sample data" fallbacks — that hides real
  errors and produces output that looks successful but isn't comparable to
  the COBOL run.
- Do NOT embed hardcoded sample records. If the input is not available, the
  Java run should surface that the same way the COBOL does.
- The only acceptable "demo-friendly" behavior is printing a clear error
  message BEFORE exiting non-zero — never silently substituting data.

Example CORRECT file handling:
\`\`\`java
List<String> data = new ArrayList<>();
try (BufferedReader reader = new BufferedReader(new FileReader("ACCTREC"))) {
    String line;
    while ((line = reader.readLine()) != null) {
        data.add(line);
    }
} catch (FileNotFoundException e) {
    System.err.println("File not found: ACCTREC (status = 35)");
    System.exit(1);          // match COBOL's non-zero exit
}
// Process 'data' only if we got this far
\`\`\`

CRITICAL: FIXED-LENGTH BINARY RECORDS — DO NOT USE BufferedReader/readLine
If an FD says \`RECORDING MODE F\` and/or its 01 record contains COMP-3 / COMP /
binary fields, the data set is a stream of FIXED-SIZE BYTE RECORDS with NO
newlines. \`BufferedReader.readLine()\` on such a file returns one giant "line"
(or null) — the program then reads 0 records and still exits 0, which looks
like success and is the single worst failure mode in this converter.
For those files you MUST:
- Read bytes, not lines: open with \`new FileInputStream(name)\` and pull exactly
  RECORD-LENGTH bytes per record (\`in.readNBytes(len)\`, loop until short read).
  RECORD-LENGTH is the sum of the 01 field sizes.
- Slice each field by OFFSET and LENGTH out of that byte[].
- Decode PIC X fields with \`new String(buf, off, len, StandardCharsets.ISO_8859_1)\`
  so byte values survive unchanged.
- Decode COMP-3 (packed decimal) by nibbles: each byte holds two digits, the
  LAST nibble is the sign (0xC/0xF positive, 0xD negative). Scale by the V in
  the PIC (e.g. S9(7)V99 → divide by 100) and build a BigDecimal.
Example for \`05 ACCT-LIMIT PIC S9(7)V99 COMP-3.\` (5 bytes at offset 8):
\`\`\`java
static BigDecimal unpack(byte[] b, int off, int len, int scale) {
    StringBuilder d = new StringBuilder();
    for (int i = 0; i < len; i++) {
        d.append((b[off + i] >> 4) & 0x0F);
        if (i < len - 1) d.append(b[off + i] & 0x0F);
    }
    int sign = b[off + len - 1] & 0x0F;
    BigDecimal v = new BigDecimal(d.toString()).movePointLeft(scale);
    return (sign == 0x0D) ? v.negate() : v;
}
\`\`\`

WRITING a RECORDING MODE F file — fixed width, NO newlines
The same applies on output. A \`WRITE\` to a RECORDING MODE F FD appends exactly
RECORD-LENGTH bytes with NO line separator. Do NOT use PrintWriter.println or
append "\\n" — build each record as a fixed-width string and write its bytes.
Every field keeps its declared PIC width, so the file size must come out as
(record length x record count).

Numeric-edited PIC widths (these are exact, and RIGHT-justified):
- \`PIC $$,$$$,$$9.99\` is 13 characters. The floating \`$\` sits immediately left
  of the first significant digit and the whole field is RIGHT-justified with
  LEADING spaces — 10000.00 renders as \`"   $10,000.00"\`, 188.74 as
  \`"      $188.74"\`. In Java: \`String.format("%13s", "$" + new DecimalFormat("#,##0.00").format(v))\`.
  Never left-justify and pad on the right.
- \`PIC 9(N)\` on DISPLAY stays zero-padded to width N (\`String.format("%0Nd", v)\`).
- \`PIC X(N)\` is space-padded on the RIGHT to width N.

CRITICAL: DO NOT SILENTLY REPAIR DEFECTIVE COBOL
Some source files contain defects a COBOL compiler would REJECT outright —
an arithmetic target declared PIC X, a MOVE between incompatible types, a
reference to an identifier that is never defined. Do NOT quietly "fix" these
by inferring the type the code looks like it wanted. A silent repair produces
Java that runs cleanly when the original program cannot even be compiled,
which hides a real defect and makes the COBOL-vs-Java comparison meaningless.
Instead, for each such construct:
- Convert it as literally as Java allows (still emit COMPILABLE Java), AND
- Mark the exact line with a comment: // TODO[SOURCE-DEFECT]: <what is wrong>
Example — COBOL declares \`77 GROSS-PAY PIC X(5).\` then does
\`COMPUTE GROSS-PAY = HOURS * RATE\`:
\`\`\`java
// TODO[SOURCE-DEFECT]: GROSS-PAY is PIC X(5) (alphanumeric) but is the target
// of a COMPUTE — a COBOL compiler rejects this. Represented as a String here.
String grossPay = String.valueOf(hours * rate);
\`\`\`

CRITICAL: COBOL ACCEPT FROM SYSIN semantics — DO NOT THROW on invalid input
COBOL's \`ACCEPT WS-VAR FROM SYSIN\` is LOSSY and FORGIVING, not strict:
  - Non-numeric text into a PIC 9(N) field → silently stored as zeroes (or garbled
    bytes). COBOL does NOT throw, does NOT exit, does NOT print "invalid input".
  - End-of-stream on SYSIN → most runtimes return blanks/zeroes forever;
    COBOL keeps looping. It does NOT throw NoSuchElementException.
Therefore Java conversions that use Integer.parseInt / BigDecimal(...) on
Scanner.nextLine() input MUST wrap the parse in try/catch and default to 0
on NumberFormatException. They MUST check for null on Scanner.nextLine()
returns and treat null as an empty string (mimicking COBOL reading blanks).
They MUST NOT throw, must NOT System.exit on invalid input, must NOT print
"invalid numeric input" — COBOL prints no such message.

Example CORRECT stdin handling (match COBOL ACCEPT behavior):
\`\`\`java
BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in));
String rawAmount = stdin.readLine();
if (rawAmount == null) rawAmount = "";           // EOF — COBOL would see blanks
int amount = 0;
try { amount = Integer.parseInt(rawAmount.trim()); }
catch (NumberFormatException e) { amount = 0; }  // COBOL would see zeroes
\`\`\`

CRITICAL: PIC 9(N) zero-padded display format
COBOL DISPLAY on a \`PIC 9(N)\` field ALWAYS prints N digits with leading
zeroes (e.g. amount=8, PIC 9(6) → "000008"). Java's \`System.out.print(x)\`
prints a variable-width integer ("8") which breaks any downstream diff
against the COBOL output. Every numeric DISPLAY MUST use
\`String.format("%0Nd", value)\` where N matches the COBOL PIC width.
Examples:
  COBOL: DISPLAY WS-TOTAL            (WS-TOTAL PIC 9(6), value 8)
  Java:  System.out.print(String.format("%06d", wsTotal));   // "000008"
  COBOL: DISPLAY "Line " WS-LINE-NO  (WS-LINE-NO PIC 9(3), value 42)
  Java:  System.out.print("Line " + String.format("%03d", wsLineNo));  // "Line 042"
For signed COBOL fields (\`PIC S9(N) … SIGN IS TRAILING SEPARATE\`) match
the trailing-sign convention the original program emits.

QUALITY REQUIREMENTS:
1. Use REAL file I/O with BufferedReader/BufferedWriter for COBOL FILE operations
2. On missing files: print an error and exit non-zero — do NOT fabricate data
3. Use ArrayList<> for OCCURS DEPENDING ON / variable arrays
4. Implement proper exception handling with specific exception types
5. ALWAYS print processing results and summaries based on REAL inputs

CICS/IMS PROGRAMS (if present):
- Convert EXEC CICS commands to method calls that demonstrate the logic flow
- SEND MAP → printScreen() method showing field values with sample data
- RECEIVE MAP → method to process sample input values
- XCTL/LINK → method calls with printed transitions
- Print what each CICS command WOULD do

DATA MAPPING:
- PIC X/A → String = ""
- PIC 9(1-9) → int = 0
- PIC 9(10+) → long = 0L
- COMP/COMP-3 → BigDecimal = BigDecimal.ZERO
- OCCURS n TIMES → ArrayList<> or fixed array
- DEPENDING ON → ArrayList<> (dynamic sizing)

STRUCTURE:
1. ONE public class per file
2. Include main() method that runs the business logic
3. WRAP in try-catch with proper exception handling
4. Use System.out.println() for DISPLAY statements
5. ALWAYS call the main business logic method from main()
6. Initialize ALL fields at declaration
7. Do NOT use 'final' keyword for instance fields
8. Always include ALL necessary imports at the top
9. Ensure all braces { } are properly balanced

CRITICAL - PRODUCE OUTPUT:
- ALWAYS print "=== Program Started ===" at beginning
- Print processing steps as they happen
- Print summaries (records read, processed, written) — based on REAL input only
- ALWAYS print "=== Program Completed ===" at end
- NEVER substitute sample/placeholder records for missing input files. If the
  input file is absent, print an error and exit non-zero (same as COBOL status 35).

BANNED:
- Scanner (hardcode test inputs instead)
- final keyword for instance fields
- JDBC/database connections
- Incomplete code or truncated output
- Unterminated strings or unclosed braces
- package statements (no package declaration)
- Inventing behavior NOT present in the COBOL source (do not add HTTP handling,
  JSON parsing, auth flows, REST calls, etc. unless the COBOL explicitly does it)
- Calling methods that are not defined in the same class (do NOT call
  closeCursor(), executeSQL(), openFile() etc. unless you ALSO define them)

COMPILE-SAFE RULES (CRITICAL — the code MUST compile with plain javac):
1. Every method that uses File I/O (BufferedReader, FileReader, FileWriter,
   readLine, etc.) MUST wrap the I/O in a try-catch that catches IOException
   explicitly — OR declare \`throws IOException\` on the method signature.
   If you use try-with-resources \`try (BufferedReader br = ...)\`, the
   enclosing method MUST still catch IOException — the implicit close() call
   throws it. main() should catch ALL Exceptions at the outer level.
2. \`throws\` is ONLY valid on a method signature. NEVER write \`for (...) throws\`,
   \`while (...) throws\`, \`if (...) throws\`, \`switch (...) throws\`,
   \`else throws\`, or \`do throws\` — those are COMPILE ERRORS. If a loop or
   conditional body calls something that throws a checked exception, either:
     (a) add \`throws IOException\` (or the relevant type) to the ENCLOSING
         METHOD signature, or
     (b) wrap the loop/conditional body in \`try { ... } catch (...) { ... }\`.
3. Generic collections must be type-consistent. If you declare
   \`List<AcctRec> sampleData\`, every \`.add(...)\` call must pass an
   AcctRec — not raw strings. Build a helper that returns AcctRec (not
   String) before calling \`.add()\`.
4. Every method you CALL must be DEFINED in the same class (or be a
   standard Java library method). Do not reference helper methods like
   \`closeCursor()\`, \`openDb()\`, \`fetchRow()\` unless you also define them.
5. When emulating SQL cursors: define concrete methods like
   \`int closeCursor(String name) { ... return 0; }\` before using them.
6. Every \`try-with-resources\` block must close cleanly: the enclosing
   method signature declares \`throws IOException\` OR the block is wrapped
   in an outer \`try { ... } catch (IOException e) { ... }\`.
7. Do NOT mark a field \`final\` if ANY code path reassigns it. COBOL
   WORKING-STORAGE variables are mutable by default — translate them as
   plain (non-final) fields. Only use \`final\` on constants declared in the
   COBOL source via \`88\`-level condition names or \`VALUE\` clauses that
   are never MOVEd to later. When in doubt, omit \`final\`.
8. Do NOT mark method parameters \`final\`. It's legal but over-constrains
   the generated code and prevents in-place updates the converter often
   needs. Parameters should be plain types.
9. If the COBOL has a PROCEDURE DIVISION, generate a \`public static void
   main(String[] args)\` that creates an instance of the class and calls
   the business-logic method. The class is not useful without an entry
   point — even single-procedure programs get a main().
10. Do NOT mark a class \`abstract\` unless it declares \`abstract\` methods.
    Converted COBOL programs are concrete — abstract on a class with all
    concrete methods is a compile error in any caller that tries to
    instantiate it.
11. Pure-string / computational helper methods (no file / network / system
    I/O inside) must NOT declare \`throws IOException\`. Only methods that
    actually call something that throws IOException may declare it.
12. Every declared primitive field (\`int\`, \`long\`, \`double\`, \`boolean\`,
    \`BigDecimal\`) must have a safe default — \`0\`, \`0.0\`, \`false\`, or
    \`BigDecimal.ZERO\`. Uninitialized BigDecimal / String fields cause
    NullPointerException when used before assignment.

CALL RESOLUTION (CRITICAL):
- If a sibling Java class is listed in CONTEXT below for a COBOL PROGRAM-ID,
  generate a REAL Java call like \`new ClassName().run(...)\` — NOT a simulation
  with print-only fake data. The sibling class exists.
- If no sibling class is listed for a CALL target, emit a // TODO comment
  explaining the call is to an external program, then fall through. Do NOT
  invent data for it.
- Do NOT write \`// Since original program CALLs an external program...\` and
  fabricate behavior. Either call the real converted class or TODO.

IMPORTS TO ALWAYS INCLUDE:
- import java.io.*;
- import java.util.ArrayList;
- import java.util.List;
- import java.math.BigDecimal;

Output ONLY the complete Java code, no explanations.`,

                // Retry prompt 1 - simpler, focus on working code
                `You are a COBOL to Java converter. Generate WORKING, COMPILABLE Java code.

FIDELITY RULE (non-negotiable):
Do NOT fabricate input data. If the COBOL opens a file and fails when it's
missing, the Java MUST also fail when the file is missing — print a clear
error (e.g. "File not found: ACCTREC (status = 35)") and call System.exit(1).
Never substitute hardcoded sample records for a missing input file.
Do NOT silently repair COBOL a compiler would reject (e.g. a PIC X field used
as a COMPUTE target). Convert it literally and mark the line with a
// TODO[SOURCE-DEFECT]: <what is wrong> comment instead.
If an FD is RECORDING MODE F or holds COMP-3/COMP fields, the file has NO
newlines: read fixed-size byte records via FileInputStream.readNBytes(len) and
slice fields by offset. Never BufferedReader.readLine() on such a file.

CRITICAL RULES:
1. ONE public class only with main() method
2. NO package statement at top
3. NO final keyword for fields
4. Initialize ALL variables at declaration
5. Include ALL imports (java.io.*, java.util.*, java.math.*)
6. Use System.out.println() for all output
7. Wrap in try-catch with Exception handling
8. Complete all braces {} properly

Output ONLY the Java code, no explanations.`,

                // Retry prompt 2 - minimal, skeleton-focused
                `Convert COBOL to Java. Output ONLY compilable Java code.
MUST:
- One public class with main() - no package statement
- import java.io.*; import java.util.*; import java.math.*;
- Initialize ALL variables (String = "", int = 0)
- No final keyword
- System.out.println() for output
- try-catch for all operations
- Complete, balanced braces
- On missing input file: print error + System.exit(1). Do NOT fabricate sample records.
- Do NOT silently repair COBOL a compiler would reject; convert it literally and
  mark the line // TODO[SOURCE-DEFECT]: <what is wrong>
- RECORDING MODE F / COMP-3 files have no newlines: read fixed-size byte records
  with FileInputStream.readNBytes(len), never BufferedReader.readLine()`
            ];

            const systemPrompt = systemPrompts[Math.min(retryCount, systemPrompts.length - 1)];

            // Build a context block so the AI knows which CALL targets it can
            // resolve to real sibling Java classes (vs simulating them), and
            // can see the actual copybook contents instead of guessing fields.
            let contextBlock = '';
            const pidMap   = (context && context.programIdToJavaClass) || {};
            const sigMap   = (context && context.siblingSignatures) || {};
            const cpyBodies = (context && context.copybookBodies) || {};
            const calls    = (context && Array.isArray(context.calledPrograms)) ? context.calledPrograms : [];
            const copies   = (context && Array.isArray(context.copybooks)) ? context.copybooks : [];
            const jclInvs  = (context && Array.isArray(context.jclInvocations)) ? context.jclInvocations : [];
            const feedback = (context && Array.isArray(context.reviewerFeedback)) ? context.reviewerFeedback : [];
            if (calls.length || Object.keys(pidMap).length || copies.length || jclInvs.length || feedback.length) {
                contextBlock = '\n\n=== CONTEXT ===\n';
                if (calls.length) {
                    contextBlock += 'This COBOL program CALLs:\n';
                    for (const name of calls) {
                        const key = name.toUpperCase();
                        const javaClass = pidMap[key];
                        if (javaClass) {
                            contextBlock += `  - '${name}' → Java class \`${javaClass}\` (exists — use \`new ${javaClass}().<entry>(...)\`)\n`;
                            // If we extracted the sibling's public method signature
                            // during an earlier conversion wave, surface it so the
                            // AI matches its argument list instead of guessing.
                            const sig = sigMap[key];
                            if (sig) {
                                contextBlock += `      entry signature: ${sig}\n`;
                            }
                        } else {
                            contextBlock += `  - '${name}' → NOT IN THIS CONVERSION (emit a // TODO, do not simulate)\n`;
                        }
                    }
                }
                if (copies.length) {
                    // If we have the copybook content, inline it verbatim — the AI
                    // needs the real PIC clauses to generate correct Java field
                    // types. Name-only hints lead to guessed field names that the
                    // compile-gate then rejects.
                    const withBodies = copies.filter(n => cpyBodies[n.toUpperCase()]);
                    const withoutBodies = copies.filter(n => !cpyBodies[n.toUpperCase()]);
                    if (withBodies.length) {
                        contextBlock += 'COPY targets — FULL COPYBOOK SOURCE BELOW. Use these field definitions exactly (preserve COBOL names via PascalCase/camelCase):\n';
                        for (const name of withBodies) {
                            contextBlock += `  - ${name}\n`;
                        }
                    }
                    if (withoutBodies.length) {
                        contextBlock += 'COPY targets (source not available — infer from usage):\n';
                        for (const name of withoutBodies) contextBlock += `  - ${name}\n`;
                    }
                    for (const name of withBodies) {
                        const body = cpyBodies[name.toUpperCase()];
                        contextBlock += `\n=== COPYBOOK ${name} ===\n${body}\n=== END COPYBOOK ${name} ===\n`;
                    }
                }
                if (jclInvs.length) {
                    // This program is invoked from at least one JCL. Surface the
                    // staged DD names + DSNs so the AI emits Java file paths that
                    // match the mainframe runtime. A COBOL `SELECT ACCT-REC ASSIGN
                    // TO ACCTREC` should map to a Java path of "ACCTREC" (the DD
                    // name) — NOT a guessed filename like "accounts.txt".
                    contextBlock += '\nJCL invocations (use the DD NAME as the file path — this is how mainframe staging works):\n';
                    for (const inv of jclInvs) {
                        contextBlock += `  - Step ${inv.stepName} in ${inv.jclFile}:\n`;
                        for (const dd of inv.dds || []) {
                            const parts = [`DD ${dd.name}`];
                            if (dd.dsn)    parts.push(`DSN=${dd.dsn}`);
                            if (dd.disp)   parts.push(`DISP=${dd.disp}`);
                            if (dd.sysout) parts.push('SYSOUT');
                            contextBlock += `      ${parts.join(' ')}\n`;
                        }
                    }
                    contextBlock += '  → For each SELECT/ASSIGN in the COBOL, use the DD NAME as the Java file path (e.g. `new FileReader("ACCTREC")`). Leave the DSN in a brief comment so the reader sees the mainframe origin.\n';
                }
                if (feedback.length) {
                    // Reviewer-feedback threading — earlier files in this
                    // batch were rejected or edited with notes. Surface the
                    // notes so the model can avoid repeating the same
                    // mistake. The reviewer note IS the target behavior
                    // ("don't emit sample data", "match the fixed-width
                    // output", "use BufferedReader not Files.lines") —
                    // priming the model with it cheaply steers subsequent
                    // conversions without a prompt rewrite.
                    contextBlock += '\nREVIEWER FEEDBACK FROM EARLIER IN THIS BATCH — apply these corrections to THIS file:\n';
                    for (const f of feedback) {
                        const verb = f.action === 'reject' ? 'rejected' : 'edited after';
                        contextBlock += `  - ${f.fileBasename} (${verb}): ${String(f.note).slice(0, 400)}\n`;
                    }
                    contextBlock += '  → Take these as hard constraints. Don\'t repeat the same mistake just because the reviewer didn\'t spell it out for this specific file.\n';
                }
                contextBlock += '===============\n';
            }

            const response = await makeOpenAIRequest([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Convert this COBOL program to production-quality Java:${contextBlock}\n\n${cobolSource}` }
            ], {
                temperature: retryCount === 0 ? 0.2 : 0.3, // Slightly higher temp on retry
                maxTokens: 16000  // Headroom for large COBOL programs; watch `finish_reason` for truncation
            });

            // Check if response is valid
            if (!response || !response.choices || !response.choices[0]) {
                console.error('   [error] Invalid Azure AI response:', JSON.stringify(response).substring(0, 200));

                // Retry if we haven't exceeded max retries
                if (retryCount < MAX_RETRIES) {
                    console.log(`    Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return convertCobolToJava(cobolSource, retryCount + 1, context);
                }

                return {
                    success: false,
                    error: 'Invalid response from Azure AI'
                };
            }

            javaCode = response.choices[0].message?.content || '';
            capturedUsage = response.usage || null;
            const finishReason = response.choices[0].finish_reason || null;

            // Clean up markdown code blocks if present
            javaCode = javaCode.replace(/^```java\n?/i, '').replace(/\n?```$/i, '');
            javaCode = javaCode.replace(/^```\n?/, '').replace(/\n?```$/i, '');
            javaCode = javaCode.trim();

            // --- Truncation detection ------------------------------------
            // Two signals that the model ran out of output tokens mid-class:
            //   1. Azure/OpenAI reports finish_reason === 'length'
            //   2. Heuristic: unbalanced braces, or the file doesn't end with '}'
            // Either means we should retry; if we've exhausted retries, surface a
            // specific error so the UI explains "too large for one pass" instead
            // of showing half-broken Java.
            const isTruncated = detectTruncation(javaCode, finishReason);
            if (isTruncated) {
                console.warn(`   [warn]  Response appears truncated (finish_reason=${finishReason}, length=${javaCode.length})`);
                if (retryCount < MAX_RETRIES) {
                    console.log(`    Retrying with fresh prompt (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return convertCobolToJava(cobolSource, retryCount + 1, context);
                }
                return {
                    success: false,
                    error: `AI response truncated (${javaCode.length} chars, finish_reason=${finishReason || 'unknown'}). This COBOL file is likely too large for a single conversion pass — consider splitting it or raising the output token budget.`,
                    usage: capturedUsage
                };
            }
        }

        // Validate that we got actual Java code
        if (!javaCode || javaCode.length < 50) {
            console.error('   [error] Azure AI returned empty or too short response');

            // Retry if we haven't exceeded max retries
            if (retryCount < MAX_RETRIES) {
                console.log(`    Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return convertCobolToJava(cobolSource, retryCount + 1, context);
            }

            return {
                success: false,
                error: 'Azure AI returned empty or insufficient Java code'
            };
        }

        // Check for common Java patterns to validate it's real code
        const hasJavaPattern =
            javaCode.includes('class ') ||
            javaCode.includes('public ') ||
            javaCode.includes('import ') ||
            javaCode.includes('void ') ||
            javaCode.includes('String ');

        if (!hasJavaPattern) {
            console.error('   [error] Azure AI response does not look like Java code');
            console.error('   Response preview:', javaCode.substring(0, 200));

            // Retry if we haven't exceeded max retries
            if (retryCount < MAX_RETRIES) {
                console.log(`    Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return convertCobolToJava(cobolSource, retryCount + 1, context);
            }

            return {
                success: false,
                error: 'Azure AI response does not appear to be valid Java code'
            };
        }

        // Apply auto-fixes to improve compilation success
        javaCode = autoFixJavaCode(javaCode);

        console.log('   [ok] Got Java code:', javaCode.length, 'characters');

        return {
            success: true,
            javaCode,
            method: 'chat',
            platform: (getConfig() && getConfig().isAIFoundry) ? 'AI Foundry' : 'Azure OpenAI',
            usage: capturedUsage
        };
    } catch (error) {
        console.error('Azure Conversion Error:', error.message);

        // Retry on transient errors
        if (retryCount < MAX_RETRIES && (error.message.includes('fetch failed') || error.message.includes('timeout'))) {
            console.log(`    Retrying after error (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return convertCobolToJava(cobolSource, retryCount + 1, context);
        }

        return {
            success: false,
            error: `Azure conversion failed: ${error.message}`
        };
    }
}

module.exports = { convertCobolToJava };
