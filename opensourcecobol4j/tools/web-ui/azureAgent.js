/**
 * Azure AI Foundry Agent Service for COBOL to Java Conversion
 * Supports both Azure OpenAI and Azure AI Foundry Agents API
 */

const fs = require('fs');
const path = require('path');

// Azure HTTP transport + init + availability accessors → src/ai/azure-client.js
// Owns azureConfig and exports the shared makeOpenAIRequest everything below
// uses.
const {
    initializeAzure,
    isAvailable,
    getConfig,
    makeOpenAIRequest
} = require('./src/ai/azure-client');

// NOTE: the Azure Assistants/Agent API path (convertWithAgent + thread
// helpers) was removed in an earlier cleanup. It had no retry / truncation
// detection, received no conversion context (copybook bodies, sibling
// signatures, JCL invocations — all the layers we added to the chat path),
// and its prompt rules lived in Azure Portal which meant every fidelity-
// rule change had to be reapplied in two places. Chat Completions works
// for both Azure OpenAI AND AI Foundry with the same key + deployment, so
// the dual-path complexity was earning nothing. If Assistants becomes
// useful again (persistent threads, tool-use), reintroduce it through a
// single shared path that also gets retry + context + truncation — or
// wait for Azure's Responses API which supersedes Assistants.

// autoFixJavaCode + detectTruncation → src/core/auto-fix-java.js
const { autoFixJavaCode, detectTruncation } = require("./src/core/auto-fix-java");

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
- On missing input file: print error + System.exit(1). Do NOT fabricate sample records.`
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
            if (calls.length || Object.keys(pidMap).length || copies.length || jclInvs.length) {
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

/**
 * Predict program output using Azure AI
 * Analyzes both COBOL source AND generated Java code for accurate output prediction
 */
async function predictProgramOutput(cobolSource, javaCode) {
    if (!isAvailable()) {
        return {
            success: false,
            error: 'Azure AI not initialized'
        };
    }

    try {
        console.log('    Predicting program output with AI (analyzing both COBOL & Java)...');

        const systemPrompt = `You are an expert COBOL/Java code execution simulator. You will analyze BOTH the original COBOL program AND its converted Java equivalent to produce accurate execution output.

YOUR TASK:
Mentally execute both programs and determine the EXACT output that would be printed to the screen/console.

EXECUTION METHODOLOGY:
1. First, analyze the COBOL program:
   - Identify all WORKING-STORAGE variables and their initial VALUES
   - Trace through PROCEDURE DIVISION statement by statement
   - Note all DISPLAY statements and what they would output

2. Then, cross-reference with the Java code:
   - Verify variable initializations match
   - Trace through main() method and all called methods
   - Note all System.out.println/print statements
   - Confirm the logic flow matches COBOL

3. Derive the final output:
   - Calculate all arithmetic (COMPUTE, ADD, MULTIPLY, etc.)
   - Evaluate all conditions (IF, EVALUATE) with actual values
   - Follow all loops (PERFORM VARYING, for loops) with correct iterations
   - For user input (ACCEPT/Scanner), assume: "Test" for text, "100" for numbers, "Y" for yes/no

OUTPUT RULES:
- Show ONLY the exact text that would appear on screen
- One line per DISPLAY/println statement
- Include the actual computed values, not variable names
- NO explanations, NO "Output:" prefix, NO comments
- If nothing is displayed, respond with: [No output]

EXAMPLE:
COBOL: DISPLAY "Total: " WS-TOTAL (where WS-TOTAL = 250)
Java: System.out.println("Total: " + wsTotal); (where wsTotal = 250)
Your output: Total: 250`;

        // Build user prompt with both COBOL and Java code
        let userPrompt = `Analyze and execute these programs to determine the exact console output:\n\n`;

        userPrompt += `=== ORIGINAL COBOL PROGRAM ===\n${cobolSource}\n\n`;

        if (javaCode && javaCode.length > 50) {
            userPrompt += `=== CONVERTED JAVA PROGRAM ===\n${javaCode}\n\n`;
        }

        userPrompt += `Cross-reference both programs and provide the EXACT execution output. Execute the code step by step, calculating all values, then show only what would be printed.`;

        const response = await makeOpenAIRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], {
            temperature: 0.2,  // Lower temperature for more deterministic output
            maxTokens: 1500
        });

        if (!response || !response.choices || !response.choices[0]) {
            return {
                success: false,
                error: 'Invalid response from Azure AI'
            };
        }

        let predictedOutput = response.choices[0].message?.content || '';
        predictedOutput = predictedOutput.trim();

        // Clean up common AI prefixes and formatting
        predictedOutput = predictedOutput.replace(/^(Output:|The output would be:|Program output:|Expected output:|Console output:)\s*/i, '');
        predictedOutput = predictedOutput.replace(/^```[\w]*\n?/i, '').replace(/\n?```$/i, '');
        predictedOutput = predictedOutput.replace(/^\[Output\]\s*/i, '');

        // Remove any remaining explanation text at the start
        const lines = predictedOutput.split('\n');
        const filteredLines = lines.filter(line => {
            const lowerLine = line.toLowerCase().trim();
            // Filter out common explanation prefixes
            return !lowerLine.startsWith('the program') &&
                !lowerLine.startsWith('this program') &&
                !lowerLine.startsWith('when executed') &&
                !lowerLine.startsWith('the output') &&
                !lowerLine.startsWith('executing');
        });
        predictedOutput = filteredLines.join('\n').trim();

        console.log('   [ok] AI predicted output (cross-referenced):', predictedOutput.substring(0, 100));

        return {
            success: true,
            predictedOutput,
            source: 'azure_ai_cross_reference',
            analyzedBothSources: !!(javaCode && javaCode.length > 50)
        };
    } catch (error) {
        console.error('Output prediction error:', error.message);
        return {
            success: false,
            error: `Prediction failed: ${error.message}`
        };
    }
}

/**
 * Analyze failed conversion using Azure AI
 * @param {string} cobolSource
 * @param {string} errorLog
 * @param {string} errorType
 * @param {object} [context] optional repo-level context so the analyst can
 *        reference real sibling files, copybook bodies, JCL — instead of
 *        giving generic advice based only on the source shown.
 * @param {string[]} [context.calledPrograms]
 * @param {string[]} [context.copybooks]
 * @param {Record<string,string>} [context.programIdToJavaClass]
 * @param {Record<string,string>} [context.copybookBodies] name → .cpy source
 */
async function analyzeConversionFailure(cobolSource, errorLog, errorType, context = {}) {
    if (!isAvailable()) {
        return {
            success: false,
            error: 'Azure AI not initialized. Configure AZURE_OPENAI_* in .env file.'
        };
    }

    // Build an optional context block. Without this, "COPY MISSING-BOOK"
    // failures get generic "add the copybook" advice — with it, the analyst
    // can say "the copybook is named FOO and exists at path X" or "it really
    // is missing from the repo, here are the copybooks that DO exist".
    let contextBlock = '';
    const calls = Array.isArray(context.calledPrograms) ? context.calledPrograms : [];
    const copies = Array.isArray(context.copybooks) ? context.copybooks : [];
    const pidMap = context.programIdToJavaClass || {};
    const cpyBodies = context.copybookBodies || {};
    if (calls.length || copies.length || Object.keys(pidMap).length) {
        contextBlock = '\n\n=== REPO CONTEXT ===\n';
        if (calls.length) {
            contextBlock += 'This COBOL program CALLs:\n';
            for (const name of calls) {
                const key = name.toUpperCase();
                const javaClass = pidMap[key];
                contextBlock += javaClass
                    ? `  - '${name}' → Java class ${javaClass} exists in this conversion\n`
                    : `  - '${name}' → NOT in this conversion (external module)\n`;
            }
        }
        if (copies.length) {
            contextBlock += 'COPY targets referenced:\n';
            for (const name of copies) {
                const key = name.toUpperCase();
                contextBlock += cpyBodies[key]
                    ? `  - ${name} (source available; see below)\n`
                    : `  - ${name} (source NOT in repo — likely cause of a COPY failure)\n`;
            }
            for (const name of copies) {
                const body = cpyBodies[name.toUpperCase()];
                if (body) {
                    contextBlock += `\n=== COPYBOOK ${name} ===\n${body}\n=== END COPYBOOK ${name} ===\n`;
                }
            }
        }
        contextBlock += '===============\n';
    }

    try {
        // Single path: Chat Completions. The Assistants/Agent branch that
        // lived here never received context improvements and duplicated
        // behavior that drifts from the chat path; removed with the rest
        // of the Agent API cleanup.
        const response = await makeOpenAIRequest([
            { role: 'system', content: 'You are an expert COBOL to Java migration specialist. Analyze conversion failures and provide actionable solutions. If REPO CONTEXT is provided, reference specific files / copybooks by name — don\'t give generic advice when the repo state is known.' },
            { role: 'user', content: `Analyze this failure:\nError Type: ${errorType}\nError: ${errorLog}\nCOBOL: ${cobolSource}${contextBlock}` }
        ], { temperature: 0.3, maxTokens: 2000 });

        const analysis = response.choices[0].message.content;
        return {
            success: true,
            analysis
        };
    } catch (error) {
        console.error('Azure Analysis Error:', error.message);
        return {
            success: false,
            error: `Azure analysis failed: ${error.message}`
        };
    }
}

// scanForCobolFiles + scanForAllMainframeFiles → src/scan/cobol-scanner.js
const { scanForCobolFiles, scanForAllMainframeFiles } = require('./src/scan/cobol-scanner');

/**
 * Convert all COBOL files in a directory
 */
async function convertDirectory(inputDir, outputDir, progressCallback) {
    if (!isAvailable()) {
        return { success: false, error: 'Azure AI not initialized' };
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const cobolFiles = scanForCobolFiles(inputDir);

    const results = {
        total: cobolFiles.length,
        converted: 0,
        failed: 0,
        skipped: 0,
        files: []
    };

    for (let i = 0; i < cobolFiles.length; i++) {
        const cobolPath = cobolFiles[i];
        const relativePath = path.relative(inputDir, cobolPath);
        const baseName = path.basename(cobolPath, path.extname(cobolPath));

        if (progressCallback) {
            progressCallback({ current: i + 1, total: cobolFiles.length, file: relativePath, status: 'processing' });
        }

        try {
            const cobolSource = fs.readFileSync(cobolPath, 'utf-8');

            if (cobolSource.trim().length < 50) {
                results.skipped++;
                results.files.push({ source: relativePath, status: 'skipped', reason: 'File too small' });
                continue;
            }

            const conversionResult = await convertCobolToJava(cobolSource);

            if (conversionResult.success) {
                const javaFileName = toPascalCase(baseName) + '.java';
                const javaPath = path.join(outputDir, javaFileName);

                fs.writeFileSync(javaPath, conversionResult.javaCode);

                results.converted++;
                results.files.push({ source: relativePath, output: javaFileName, status: 'success' });
            } else {
                results.failed++;
                results.files.push({ source: relativePath, status: 'failed', error: conversionResult.error });
            }

            // Delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
            results.failed++;
            results.files.push({ source: relativePath, status: 'error', error: error.message });
        }
    }

    return { success: true, results };
}

/**
 * Convert string to PascalCase
 */
// toPascalCase → src/util/pascal-case.js
const { toPascalCase } = require('./src/util/pascal-case');

// analyzeConversionAccuracy → src/core/accuracy-scorer.js
const { analyzeConversionAccuracy } = require("./src/core/accuracy-scorer");

/**
 * Check if Azure AI is available
 */
// isAvailable + getConfig → src/ai/azure-client.js (re-exported below).

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

/**
 * Repair a generated Java file using a separate AI pass. Given:
 *   - the current Java code (that likely has compile errors or wrong behavior)
 *   - the original COBOL source
 *   - compile errors + run output
 *   - known sibling dependencies (class names the caller can use)
 * …produce a better Java file that compiles and behaves closer to COBOL.
 *
 * Returns { success, javaCode, error, usage }
 */
async function fixJavaCode({ javaCode, cobolSource, compileErrors, runOutput, cobolOutput, dependencies }) {
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
        '- No `final` on instance fields\n' +
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
    const userPrompt =
        `=== ORIGINAL COBOL ===\n${cobolSource}\n\n` +
        `=== CURRENT JAVA (needs fixing) ===\n${javaCode}\n\n` +
        (compileErrors ? `=== COMPILE ERRORS ===\n${compileErrors}\n\n` : '') +
        (cobolOutput ? `=== WHAT COBOL OUTPUTS WHEN RUN ===\n${snippet(cobolOutput, 1500)}\n\n` : '') +
        (runOutput   ? `=== WHAT CURRENT JAVA OUTPUTS ===\n${snippet(runOutput, 1500)}\n\n`   : '') +
        `=== DEPENDENCIES ===\n${depBlock}\n\n` +
        `Produce the corrected Java file.`;

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

module.exports = {
    initializeAzure,
    convertCobolToJava,
    predictProgramOutput,
    analyzeConversionFailure,
    analyzeConversionAccuracy,
    scanForCobolFiles,
    scanForAllMainframeFiles,
    convertDirectory,
    compareRunOutputs,
    fixJavaCode,
    isAvailable,
    getConfig
};
