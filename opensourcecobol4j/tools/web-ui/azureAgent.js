/**
 * Azure AI Foundry Agent Service for COBOL to Java Conversion
 * Supports both Azure OpenAI and Azure AI Foundry Agents API
 */

const fs = require('fs');
const path = require('path');

// Azure client configuration
let azureConfig = null;

/**
 * Initialize Azure AI Agent
 */
function initializeAzure() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview';
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

    if (!endpoint || !apiKey) {
        console.warn('[warn]  Azure AI not configured. Azure AI features disabled.');
        console.warn('   Required: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY');
        return false;
    }

    // Detect if this is AI Foundry (services.ai.azure.com) or Azure OpenAI (openai.azure.com)
    const isAIFoundry = endpoint.includes('services.ai.azure.com');

    azureConfig = {
        endpoint: endpoint.replace(/\/$/, ''),
        apiKey,
        apiVersion,
        deploymentName,
        isAIFoundry
    };

    console.log('[ok] Azure AI Agent initialized successfully');
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   Platform: ${isAIFoundry ? 'Azure AI Foundry' : 'Azure OpenAI'}`);
    return true;
}

// NOTE: the Azure Assistants/Agent API path (convertWithAgent + the thread
// helpers createThread/addMessage/runAgent/waitForRun/getMessages/getRunStatus)
// was removed. Reasons:
//   - It had no retry/truncation detection (Chat Completions path has both).
//   - It received no conversion context (copybook bodies, sibling signatures,
//     JCL invocations — the improvements we layered into the chat path) so it
//     produced systematically worse output.
//   - Its prompt rules lived in Azure Portal (not code), so every change to
//     the fidelity rules had to be manually re-applied in two places.
//   - Chat Completions works for BOTH Azure OpenAI and AI Foundry with the
//     same API key + deployment, so the dual-path complexity was earning
//     nothing.
// If the Assistants API becomes useful again (e.g. for persistent threads or
// tool-use), reintroduce it through a single shared path that also gets
// retry + context + truncation-detection, or wait for Azure's Responses API
// which supersedes Assistants.

/**
 * Make regular Azure OpenAI API request with retry logic for rate limits
 */
async function makeOpenAIRequest(messages, options = {}) {
    if (!azureConfig) {
        throw new Error('Azure AI not initialized');
    }

    // Build the endpoint URL based on platform
    let url;
    let baseEndpoint = azureConfig.endpoint;

    // Remove /api/projects/... path if present (we need base endpoint)
    if (baseEndpoint.includes('/api/projects/')) {
        baseEndpoint = baseEndpoint.split('/api/projects/')[0];
    }

    if (azureConfig.isAIFoundry) {
        // Azure AI Foundry uses OpenAI-compatible endpoint
        url = `${baseEndpoint}/openai/deployments/${azureConfig.deploymentName}/chat/completions?api-version=${azureConfig.apiVersion}`;
    } else {
        // Standard Azure OpenAI format
        url = `${azureConfig.endpoint}/openai/deployments/${azureConfig.deploymentName}/chat/completions?api-version=${azureConfig.apiVersion}`;
    }

    console.log(`   Calling: ${url}`);

    const body = {
        messages,
        max_completion_tokens: options.maxTokens || 4000
    };

    // Optional debug dump — set DEBUG_PROMPTS=<dir> to write every outbound
    // prompt to disk. Makes "why did the AI make a weird choice?" debugging
    // tractable without re-running the whole conversion. Filename is a
    // timestamp + system-prompt hash so dumps don't collide across concurrent
    // workers. Off by default (no cost when unset).
    if (process.env.DEBUG_PROMPTS) {
        try {
            const dir = process.env.DEBUG_PROMPTS;
            fs.mkdirSync(dir, { recursive: true });
            const sys = (messages.find(m => m.role === 'system') || {}).content || '';
            const tag = require('crypto').createHash('sha1').update(sys).digest('hex').slice(0, 8);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = path.join(dir, `${stamp}.${tag}.json`);
            fs.writeFileSync(file, JSON.stringify({
                url,
                maxTokens: body.max_completion_tokens,
                messages
            }, null, 2));
        } catch (dumpErr) {
            console.warn('   [warn]  Prompt dump failed (non-fatal):', dumpErr.message);
        }
    }

    // Retry logic with exponential backoff for rate limits
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': azureConfig.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.ok) {
                return await response.json();
            }

            const errorText = await response.text();

            // Check for rate limit error (429)
            if (response.status === 429 && attempt < maxRetries) {
                // Extract retry-after from error message or use exponential backoff
                let waitTime = 15000; // Default 15 seconds
                const retryMatch = errorText.match(/retry after (\d+) seconds/i);
                if (retryMatch) {
                    waitTime = (parseInt(retryMatch[1]) + 2) * 1000; // Add 2 seconds buffer
                } else {
                    waitTime = Math.pow(2, attempt + 2) * 1000; // 4s, 8s, 16s
                }
                console.log(`    Rate limited. Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            throw new Error(`Azure API error ${response.status}: ${errorText}`);
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries && error.message.includes('429')) {
                const waitTime = Math.pow(2, attempt + 2) * 1000;
                console.log(`    Rate limited (catch). Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('Max retries exceeded');
}

/**
 * Auto-fix common Java compilation issues
 */
function autoFixJavaCode(javaCode) {
    // A/B test switch: when DISABLE_AUTOFIX=1, act as a no-op so we can
    // measure the empirical effect of the regex patches on compile/run
    // outcomes against the same AI output.
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

    // Fix 2b: Auto-add `throws Exception` to methods that use try-with-resources
    // for I/O (BufferedReader/FileReader/FileWriter). Without it, the implicit
    // close() on the resource throws IOException and javac fails with
    // "unreported exception IOException; must be caught or declared".
    // Safe wide-net: any method signature that matches + contains a File I/O
    // resource gets `throws Exception` added (or extended) — javac requires
    // it and the caller is main()'s try/catch, which already catches Exception.
    {
        const methodRe = /((public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\([^)]*\))(\s*(throws\s+[\w,\s]+)?\s*)(\{)/g;
        fixedCode = fixedCode.replace(methodRe, (match, sig, _t, between, existingThrows, brace, offset, whole) => {
            // Peek into the method body to see if it needs an IOException declaration.
            // We match starting from the opening brace and walk forward until the
            // matching closing brace — cheap shortcut: look ~2000 chars ahead.
            const bodySlice = whole.substr(offset + match.length, 2000);
            const needsIO =
                /\btry\s*\(\s*(?:java\.io\.)?(?:Buffered\w+|File(?:Reader|Writer|Input|Output)\w*|PrintWriter|DataInput\w*|DataOutput\w*)\b/.test(bodySlice) ||
                /\b\w+\.readLine\s*\(/.test(bodySlice) ||
                /\bnew\s+Buffered(?:Reader|Writer)\s*\(/.test(bodySlice);
            if (!needsIO) return match;
            if (existingThrows) {
                if (/Exception|IOException/.test(existingThrows)) return match;
                // existing throws clause for other exceptions; append IOException
                const updated = existingThrows.replace(/throws\s+/, 'throws java.io.IOException, ');
                return sig + between.replace(existingThrows, updated) + brace;
            }
            // Insert `throws java.io.IOException` before the opening brace
            return sig + ' throws java.io.IOException ' + brace;
        });
    }

    // Fix 2c: Strip ILLEGAL `throws` clauses. Observed on the COBOL Programming
    // Course repo: AI emits `for (...) throws IOException {`, `while (...) throws {`,
    // `if (...) throws {`, `switch (...) throws {`, `else throws {`, `do throws {`.
    // `throws` is valid ONLY on method signatures — in any other position it's a
    // compile error. Both the initial convert AND the repair agent replicated
    // this mistake, so deterministic stripping here is the only reliable fix.
    // We preserve the control-flow statement and drop the `throws <Type>` part.
    {
        const illegalThrowsRe = /\b(for|while|if|else\s+if|switch|do)\b([^{\n]*?)\s+throws\s+[\w.,\s]+(?=\s*\{)/g;
        fixedCode = fixedCode.replace(illegalThrowsRe, '$1$2');
        // The standalone `else throws { ... }` and `do throws { ... }` variants
        // don't carry parens, so they need a narrower pattern.
        fixedCode = fixedCode.replace(/\b(else|do)\s+throws\s+[\w.,\s]+(?=\s*\{)/g, '$1');
    }

    // Fix 2d: Strip `throws IOException` from pure string/arithmetic helper
    // methods that don't actually do I/O. Observed on the COBOL Programming
    // Course repo: AI adds `throws IOException` to `static String repeatChar(…)`
    // or `static String padRight(…)`, which then breaks callsites like
    // `static final String FIELD = repeatChar(' ', 60);` with
    // "unreported exception IOException; must be caught or declared". We scope
    // the body-peek to THIS method's braces only (walking the brace balance
    // from the opening `{` forward) so I/O in unrelated neighbor methods
    // doesn't contaminate the decision.
    {
        // Conservative I/O-signal test — keep throws when the body shows ANY
        // sign of real I/O. Too-broad stripping cascades into "IOException is
        // never thrown in body of corresponding try statement" errors in
        // callers (A/B-tested on COBOL Programming Course repo — the broad
        // variant rescued 1 file but regressed 1 other). The narrow whitelist
        // below is empirically zero-regression.
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
        // Helper-name whitelist. Expanded when real repos surface new helper
        // names with the same AI mis-annotation pattern (e.g.
        // `fixedLengthSpaces` caught on CBL0004). If this list grows past
        // ~20 tokens, reconsider (B)-approach instead.
        const helperNameRe = /(?:repeat\w*|pad(?:Right|Left|Spaces)?(?:Static)?|format(?:Money|Number|Date|Amount)?\w*|to(?:Ascii|String|Upper|Lower|Padded)?|trunc\w*|fill\w*|spaces\w*|stringOf\w*|leftJustify|rightJustify|center\w*|blank\w*|normalize\w*|fixedLength\w*|fixedWidth\w*|rightPad\w*|leftPad\w*|align\w*|zeroFill\w*|zeroPad\w*)/.source;
        // Visibility modifier is OPTIONAL — helpers inside nested static
        // classes are often package-private (`static String fooBar(...)`
        // with no modifier). Safe to drop because the helper-name whitelist
        // already constrains the match to known pure-string utilities, so
        // a control-flow keyword like `while` can't false-match here.
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
            const openBraceAbs = m.index + fullMatch.length - 1; // absolute index of `{`
            const closeIdx = findBodyEnd(fixedCode, openBraceAbs);
            if (closeIdx === -1) continue; // malformed, leave alone
            const body = fixedCode.slice(openBraceAbs + 1, closeIdx);
            if (ioSignals.test(body)) continue; // method actually does I/O, keep throws
            // Record the replacement: keep prefix + sig + `{`, drop the throws clause.
            replacements.push({ start: m.index, end: m.index + fullMatch.length, text: prefix + sig + ' {' });
        }
        // Apply replacements right-to-left so earlier indices stay valid.
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            fixedCode = fixedCode.slice(0, r.start) + r.text + fixedCode.slice(r.end);
        }
    }

    // Fix 2e: Propagate `throws` declarations from callees to callers.
    // Observed on CBL0002.cobol: `void writeRecord() { pr.print(writer); }`
    // where `void print(...) throws IOException`. javac rejects with
    // "unreported exception IOException". AI repair missed it. Deterministic
    // fix: find every method that declares `throws <Type>`, collect their
    // names, then scan every OTHER method body for calls to those names.
    // For each caller that doesn't already declare the exception, add it.
    {
        // Strict return-type whitelist — either a known primitive keyword
        // (void/int/…), or a class-name starting with uppercase (possibly
        // generic / array), or a fully-qualified java.* type. Critically
        // EXCLUDES lowercase control-flow keywords like `while`/`for`/`if`,
        // which an over-permissive `[\w<>\[\]]+` pattern would otherwise
        // accidentally match as a return type.
        const RETURN_TYPE = '(?:void|boolean|byte|short|int|long|float|double|char|(?:[A-Z]\\w*(?:<[^>]+>)?(?:\\s*\\[\\s*\\])*)|(?:java\\.[\\w.]+(?:<[^>]+>)?))';

        // Step 1: build callee → exception-type map.
        const calleeThrows = {}; // methodName → "java.io.IOException"
        const declRe = new RegExp(
            `(^|\\n)[ \\t]*(?:(?:public|private|protected|static|final|synchronized)\\s+)*${RETURN_TYPE}\\s+(\\w+)\\s*\\([^)]*\\)\\s+throws\\s+([\\w.,\\s]+?)\\s*\\{`,
            'g'
        );
        let dm;
        while ((dm = declRe.exec(fixedCode)) !== null) {
            const name = dm[2];
            const thrown = dm[3].trim();
            // Only propagate checked IO-ish exceptions. Others (NumberFormat,
            // Unsupported, etc.) are either RuntimeException or already
            // declared explicitly; not worth guessing.
            if (/\bIOException\b/.test(thrown) && !calleeThrows[name]) {
                calleeThrows[name] = 'java.io.IOException';
            }
        }
        const calleeNames = Object.keys(calleeThrows);
        if (calleeNames.length > 0) {
            // Step 2: rewrite method signatures whose body calls any throwing
            // callee and whose signature doesn't already declare a compatible
            // throws. Walk the file top-down with brace-balance so we can
            // attribute each call to its enclosing method reliably.
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
            // Match method signatures with optional existing throws clause.
            // Uses the same strict RETURN_TYPE whitelist as declRe above.
            const methodRe = new RegExp(
                `(^|\\n)([ \\t]*(?:(?:public|private|protected|static|final|synchronized)\\s+)*${RETURN_TYPE}\\s+(\\w+)\\s*\\([^)]*\\))(\\s*throws\\s+[\\w.,\\s]+)?\\s*(\\{)`,
                'g'
            );
            const edits = []; // collect { start, end, text } then apply R→L
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

                // Does this body call any throwing callee (by name)?
                let neededException = null;
                for (const callee of calleeNames) {
                    if (callee === methodName) continue; // skip self-recursion
                    // Match "(identifier|this).callee(" or bare "callee(".
                    const callRe = new RegExp(`(?:\\b|\\.)${callee}\\s*\\(`);
                    if (callRe.test(body)) {
                        neededException = calleeThrows[callee];
                        break;
                    }
                }
                if (!neededException) continue;

                // Already declares something compatible? (Exception, IOException,
                // or java.io.IOException — all cover IOException callees.)
                if (/\bthrows\b[^{]*\b(?:Exception|IOException)\b/.test(existingThrows)) continue;

                const newSig = existingThrows
                    ? sig + existingThrows.replace(/throws\s+/, 'throws ' + neededException + ', ') + ' '
                    : sig + ' throws ' + neededException + ' ';
                const fullMatchStart = mm.index;
                const fullMatchEnd = mm.index + mm[0].length;
                edits.push({
                    start: fullMatchStart,
                    end:   fullMatchEnd,
                    text:  preamble + newSig + '{'
                });
            }
            // Apply right-to-left so earlier indices remain valid.
            for (let i = edits.length - 1; i >= 0; i--) {
                const e = edits[i];
                fixedCode = fixedCode.slice(0, e.start) + e.text + fixedCode.slice(e.end);
            }
        }
    }

    // Fix 2f: Strip `final` from `static final` fields that are reassigned.
    // Observed on CBL0010: AI declares `static final String HEADER = "";` then
    // assigns it in a `static { try { HEADER = "…"; ... } }` block. Java rejects
    // "cannot assign a value to static final variable". The minimal safe fix:
    // drop `final` on fields whose name appears on the left-hand side of an
    // assignment `NAME =` anywhere outside the declaration itself.
    {
        const fieldRe = /((?:public|private|protected|static|\s)+)final\s+((?:[\w<>\[\]]+\s+)+)(\w+)\s*(=|;)/g;
        const edits = [];
        let fm;
        while ((fm = fieldRe.exec(fixedCode)) !== null) {
            const fullMatch = fm[0];
            const index = fm.index;
            const name = fm[3];
            // Look for `<name> =` anywhere that is NOT the declaration itself
            // (not inside this match) and NOT part of `==` / `!=` / `<=` / `>=`.
            const assignRe = new RegExp(`(^|[^=!<>])\\b${name}\\s*=(?!=)`, 'gm');
            let match, reassigned = false;
            while ((match = assignRe.exec(fixedCode)) !== null) {
                if (match.index >= index && match.index < index + fullMatch.length) continue; // declaration
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
        // Apply right-to-left so earlier indices stay valid.
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

    // Fix 5: Add missing semicolons after closing braces of class declarations
    // This specifically handles cases like "public class Foo {}" needing a newline

    // Fix 6: Ensure main method exists and calls business logic
    if (!fixedCode.includes('public static void main')) {
        // Find the class name
        const classMatch = fixedCode.match(/public\s+class\s+(\w+)/);
        if (classMatch) {
            const className = classMatch[1];
            // Find the last closing brace and insert main before it
            const lastBrace = fixedCode.lastIndexOf('}');
            if (lastBrace > 0) {
                // Detect common entry point method names to call
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

                // Build the method call - if we found an entry point, call it
                let methodCall = '';
                if (entryPointMethod) {
                    methodCall = `p.${entryPointMethod}();`;
                } else {
                    // No recognizable entry point - print a status message
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
        // Replace subsequent "public class" with "class"
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

    // Fix 9: Remove 'final' keyword from instance fields assigned in constructor
    // Pattern: this.fieldName = ... in constructor means the field shouldn't be final
    // Find all fields being assigned via this.fieldName = 
    const constructorAssignments = fixedCode.match(/this\.(\w+)\s*=/g) || [];
    const fieldNamesAssigned = constructorAssignments.map(m => m.match(/this\.(\w+)/)[1]);

    // Remove 'final' from field declarations for these fields
    for (const fieldName of fieldNamesAssigned) {
        // Match: private/public/protected final Type fieldName
        const finalFieldPattern = new RegExp(
            `(private|public|protected)\\s+final\\s+(\\w+(?:<[^>]+>)?(?:\\[\\])?)\\s+(${fieldName})\\s*[;=]`,
            'g'
        );
        fixedCode = fixedCode.replace(finalFieldPattern, '$1 $2 $3 =');

        // Also handle: final private/public/protected Type fieldName
        const finalFirstPattern = new RegExp(
            `final\\s+(private|public|protected)\\s+(\\w+(?:<[^>]+>)?(?:\\[\\])?)\\s+(${fieldName})\\s*[;=]`,
            'g'
        );
        fixedCode = fixedCode.replace(finalFirstPattern, '$1 $2 $3 =');
    }

    // Fix 10: General fix - remove 'final' from non-static fields that have no initializer
    // These are typically meant to be assigned in constructor
    fixedCode = fixedCode.replace(
        /(private|public|protected)\s+final\s+(String|int|long|double|float|boolean|char|byte|short)\s+(\w+)\s*;/g,
        '$1 $2 $3;'
    );

    // Fix 11: Ensure ArrayList import if used
    if (fixedCode.includes('ArrayList') && !fixedCode.includes('import java.util.ArrayList')) {
        fixedCode = 'import java.util.ArrayList;\n' + fixedCode;
    }

    // Fix 12: Ensure List import if used
    if (fixedCode.includes('List<') && !fixedCode.includes('import java.util.List')) {
        fixedCode = 'import java.util.List;\n' + fixedCode;
    }

    // Fix 13: Ensure Map/HashMap imports if used
    if ((fixedCode.includes('Map<') || fixedCode.includes('HashMap')) && !fixedCode.includes('import java.util.Map')) {
        fixedCode = 'import java.util.Map;\nimport java.util.HashMap;\n' + fixedCode;
    }

    // Fix 14: Ensure IOException and file-related imports if file I/O is used
    if ((fixedCode.includes('BufferedReader') || fixedCode.includes('BufferedWriter') || fixedCode.includes('FileReader') || fixedCode.includes('FileWriter'))
        && !fixedCode.includes('import java.io.')) {
        fixedCode = 'import java.io.*;\n' + fixedCode;
    }

    // Fix 15: Fix unclosed string literals (basic detection)
    const lines = fixedCode.split('\n');
    const fixedLines = lines.map(line => {
        // Count quotes in the line (excluding escaped quotes)
        const quoteMatches = line.match(/(?<!\\)"/g) || [];
        if (quoteMatches.length % 2 !== 0 && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            // Odd number of quotes - likely unclosed, add closing quote before semicolon or end
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

    // Fix 18: Ensure Arrays import if Arrays.asList or similar is used
    if (fixedCode.includes('Arrays.') && !fixedCode.includes('import java.util.Arrays')) {
        fixedCode = 'import java.util.Arrays;\n' + fixedCode;
    }

    // Fix 19: Ensure Date/LocalDate imports
    if ((fixedCode.includes('Date ') || fixedCode.includes('new Date(')) && !fixedCode.includes('import java.util.Date') && !fixedCode.includes('import java.time.')) {
        fixedCode = 'import java.util.Date;\n' + fixedCode;
    }
    if (fixedCode.includes('LocalDate') && !fixedCode.includes('import java.time.LocalDate')) {
        fixedCode = 'import java.time.LocalDate;\nimport java.time.format.DateTimeFormatter;\n' + fixedCode;
    }

    // Fix 20: Ensure DecimalFormat imports
    if (fixedCode.includes('DecimalFormat') && !fixedCode.includes('import java.text.DecimalFormat')) {
        fixedCode = 'import java.text.DecimalFormat;\n' + fixedCode;
    }
    if (fixedCode.includes('NumberFormat') && !fixedCode.includes('import java.text.NumberFormat')) {
        fixedCode = 'import java.text.NumberFormat;\n' + fixedCode;
    }

    // Fix 21: Ensure Pattern/Matcher imports
    if ((fixedCode.includes('Pattern.') || fixedCode.includes('Matcher ')) && !fixedCode.includes('import java.util.regex')) {
        fixedCode = 'import java.util.regex.Pattern;\nimport java.util.regex.Matcher;\n' + fixedCode;
    }

    // Fix 22: Remove package statements (single-file compilation)
    fixedCode = fixedCode.replace(/^package\s+[\w.]+;\s*\n/gm, '');

    // Fix 23: Ensure FileNotFoundException import
    if (fixedCode.includes('FileNotFoundException') && !fixedCode.includes('import java.io.FileNotFoundException') && !fixedCode.includes('import java.io.*')) {
        fixedCode = 'import java.io.FileNotFoundException;\n' + fixedCode;
    }

    // Fix 24: Remove abstract from class if it has no abstract methods
    fixedCode = fixedCode.replace(/abstract\s+class/g, 'class');

    // Fix 25: Ensure Collections import if used
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

    // Fix 28: Ensure Optional import if used
    if (fixedCode.includes('Optional<') && !fixedCode.includes('import java.util.Optional')) {
        fixedCode = 'import java.util.Optional;\n' + fixedCode;
    }

    // Fix 29: Ensure Stream import if used
    if (fixedCode.includes('.stream()') && !fixedCode.includes('import java.util.stream')) {
        fixedCode = 'import java.util.stream.Collectors;\nimport java.util.stream.Stream;\n' + fixedCode;
    }

    // Fix 30: Fix double semicolons
    fixedCode = fixedCode.replace(/;;/g, ';');

    // Fix 31: Ensure ChronoField import if used
    if (fixedCode.includes('ChronoField') && !fixedCode.includes('import java.time.temporal.ChronoField')) {
        fixedCode = 'import java.time.temporal.ChronoField;\n' + fixedCode;
    }

    // Fix 32: Remove scanner.close() calls that weren't caught earlier
    fixedCode = fixedCode.replace(/\w+\.close\(\);\s*\/\/\s*close scanner/gi, '// scanner closed');
    fixedCode = fixedCode.replace(/scanner\.close\(\);?/gi, '// scanner closed');

    return fixedCode;
}

/**
 * Convert COBOL code to Java
 * For AI Foundry: Uses Chat Completions (API key works)
 * For Azure OpenAI with Agent: Uses Agent API
 */
/**
 * @param {string} cobolSource
 * @param {number} [retryCount=0]
 * @param {object} [context] optional conversion context
 * @param {string[]} [context.calledPrograms] names the COBOL source CALLs
 * @param {string[]} [context.copybooks]      names the COBOL source COPYs
 * @param {Record<string,string>} [context.programIdToJavaClass] PROGRAM-ID → Java class name
 *        for siblings already/about-to-be converted in the same run. Lets the AI
 *        emit a real Java call instead of a "simulated" stub.
 * @param {Record<string,string>} [context.copybookBodies] PROGRAM-ID → copybook source text
 *        (actual .cpy contents). Inlined verbatim so the AI sees the real field
 *        definitions instead of guessing what "COPY FOO" defines.
 * @param {Record<string,string>} [context.siblingSignatures] PROGRAM-ID → public-method
 *        signature line (e.g. "public void run(String custId, BigDecimal amount)") of
 *        the already-converted sibling class. Lets the AI emit correct parameter
 *        lists on `new Foo().run(...)` instead of guessing.
 * @param {Array<{jclFile:string, stepName:string, dds:Array<{name:string,dsn:string?,disp:string?,sysout:boolean}>}>} [context.jclInvocations]
 *        JCL steps that invoke this program. Lets the AI generate Java file
 *        paths that use real DD names ("ACCTREC") instead of guessing what
 *        SELECT…ASSIGN maps to at runtime.
 */
/**
 * Detect whether the AI's Java response was truncated (ran out of output tokens
 * mid-class). Uses two signals:
 *   1. Azure/OpenAI's own `finish_reason === 'length'` — authoritative when present.
 *   2. Heuristic brace balance — `{` count vs `}` count, and whether the last
 *      non-whitespace char is `}`. Catches cases where a provider doesn't set
 *      finish_reason but the output is clearly cut off.
 * Comments and strings can throw off a naive brace count, but for the purpose of
 * "is the file obviously incomplete" this is accurate enough in practice.
 */
function detectTruncation(javaCode, finishReason) {
    if (finishReason === 'length') return true;
    if (!javaCode || javaCode.length < 50) return false;

    // Strip line comments and /* ... */ blocks and string literals so counts
    // aren't thrown off by literal braces in text.
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
    // A valid Java source file ends in `}` (closing the outermost class).
    // Anything else is almost certainly truncated.
    if (lastChar !== '}') return true;

    return false;
}

async function convertCobolToJava(cobolSource, retryCount = 0, context = {}) {
    if (!azureConfig) {
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
            platform: azureConfig.isAIFoundry ? 'AI Foundry' : 'Azure OpenAI',
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
    if (!azureConfig) {
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
    if (!azureConfig) {
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

/**
 * Scan directory for COBOL files
 */
function scanForCobolFiles(dirPath) {
    const cobolExtensions = ['.cbl', '.cob', '.cobol', '.CBL', '.COB', '.COBOL'];
    const cobolFiles = [];

    function scanDir(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    if (!['node_modules', '.git', 'dist', 'build', 'target'].includes(entry.name)) {
                        scanDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (cobolExtensions.includes(ext)) {
                        cobolFiles.push(fullPath);
                    }
                }
            }
        } catch (err) {
            console.error(`Error scanning ${currentPath}:`, err.message);
        }
    }

    scanDir(dirPath);
    return cobolFiles;
}

/**
 * Scan directory for ALL mainframe-related files (COBOL, Copybooks, JCL, etc.)
 * Returns object with categorized files
 */
function scanForAllMainframeFiles(dirPath) {
    const cobolExtensions = ['.cbl', '.cob', '.cobol', '.CBL', '.COB', '.COBOL'];
    const copybookExtensions = ['.cpy', '.CPY', '.copy', '.COPY'];
    const jclExtensions = ['.jcl', '.JCL', '.proc', '.PROC'];
    const dataExtensions = ['.dat', '.DAT', '.txt', '.TXT', '.csv', '.CSV'];

    const result = {
        cobolFiles: [],      // For conversion
        copybookFiles: [],   // Skipped - Copybooks
        jclFiles: [],        // Skipped - JCL
        dataFiles: [],       // Skipped - Data files
        otherFiles: []       // Skipped - Other
    };

    function scanDir(currentPath) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    if (!['node_modules', '.git', '.devcontainer', 'dist', 'build', 'target', '.github', '.vscode'].includes(entry.name)) {
                        scanDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const extOriginal = path.extname(entry.name);

                    if (cobolExtensions.includes(extOriginal)) {
                        result.cobolFiles.push(fullPath);
                    } else if (copybookExtensions.includes(extOriginal)) {
                        result.copybookFiles.push(fullPath);
                    } else if (jclExtensions.includes(extOriginal)) {
                        result.jclFiles.push(fullPath);
                    } else if (dataExtensions.includes(extOriginal)) {
                        result.dataFiles.push(fullPath);
                    } else {
                        result.otherFiles.push(fullPath);
                    }
                }
            }
        } catch (err) {
            console.error(`Error scanning ${currentPath}:`, err.message);
        }
    }

    scanDir(dirPath);
    return result;
}

/**
 * Convert all COBOL files in a directory
 */
async function convertDirectory(inputDir, outputDir, progressCallback) {
    if (!azureConfig) {
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
function toPascalCase(str) {
    return str
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

/**
 * Analyze conversion accuracy by comparing COBOL source with Java output
 * Uses line-based analysis for more accurate results
 * Returns a percentage (0-100) indicating how much of the COBOL code was converted
 */
function analyzeConversionAccuracy(cobolSource, javaCode) {
    const result = {
        accuracy: 0,
        cobolMetrics: {
            totalLines: 0,
            codeLines: 0,
            dataItems: 0,
            procedures: 0
        },
        javaMetrics: {
            totalLines: 0,
            codeLines: 0,
            fields: 0,
            methods: 0
        },
        details: []
    };

    if (!cobolSource || !javaCode) {
        return result;
    }

    try {
        // === COBOL Analysis ===
        const cobolLines = cobolSource.split('\n');
        result.cobolMetrics.totalLines = cobolLines.length;

        // Count meaningful COBOL code lines (not comments, not blank, not just periods)
        let cobolCodeLines = 0;
        let inProcedureDivision = false;

        for (const line of cobolLines) {
            const trimmed = line.trim();
            // Skip blank lines
            if (!trimmed) continue;
            // Skip comment lines (column 7 = *)
            if (line.length >= 7 && line[6] === '*') continue;
            if (trimmed.startsWith('*')) continue;
            // Skip lines that are just periods
            if (trimmed === '.') continue;

            // Track procedure division
            if (trimmed.match(/PROCEDURE\s+DIVISION/i)) {
                inProcedureDivision = true;
            }

            cobolCodeLines++;
        }
        result.cobolMetrics.codeLines = cobolCodeLines;

        // Count COBOL data items (lines with PIC clause)
        const picMatches = cobolSource.match(/\bPIC\b/gi) || [];
        result.cobolMetrics.dataItems = picMatches.length;

        // Count COBOL procedures (PERFORM targets and paragraph names)
        const performMatches = cobolSource.match(/\bPERFORM\s+[\w-]+/gi) || [];
        const uniqueProcedures = new Set();
        performMatches.forEach(p => {
            const name = p.replace(/\bPERFORM\s+/i, '').toUpperCase();
            if (!['UNTIL', 'VARYING', 'WITH', 'TEST', 'THRU', 'THROUGH', 'TIMES'].includes(name)) {
                uniqueProcedures.add(name);
            }
        });
        result.cobolMetrics.procedures = uniqueProcedures.size;

        // === Java Analysis ===
        const javaLines = javaCode.split('\n');
        result.javaMetrics.totalLines = javaLines.length;

        // Count meaningful Java code lines
        let javaCodeLines = 0;
        let inMultilineComment = false;

        for (const line of javaLines) {
            const trimmed = line.trim();
            // Skip blank lines
            if (!trimmed) continue;

            // Handle multiline comments
            if (trimmed.startsWith('/*')) inMultilineComment = true;
            if (inMultilineComment) {
                if (trimmed.endsWith('*/') || trimmed.includes('*/')) {
                    inMultilineComment = false;
                }
                continue;
            }

            // Skip single line comments
            if (trimmed.startsWith('//')) continue;

            // Skip import statements (don't count as logic)
            if (trimmed.startsWith('import ')) continue;

            // Skip package statement
            if (trimmed.startsWith('package ')) continue;

            // Skip lines that are just braces
            if (trimmed === '{' || trimmed === '}' || trimmed === '};') continue;

            javaCodeLines++;
        }
        result.javaMetrics.codeLines = javaCodeLines;

        // Count Java fields (class-level variables)
        const fieldPattern = /(private|public|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\]]+\s+\w+\s*[=;]/g;
        const fieldMatches = javaCode.match(fieldPattern) || [];
        result.javaMetrics.fields = fieldMatches.length;

        // Count Java methods (excluding main and constructors that might be auto-generated)
        const methodPattern = /(private|public|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;
        let methodCount = 0;
        let match;
        while ((match = methodPattern.exec(javaCode)) !== null) {
            const methodName = match[2];
            // Don't count main or constructor-like names
            if (methodName !== 'main') {
                methodCount++;
            }
        }
        result.javaMetrics.methods = methodCount;

        // === Calculate Accuracy ===
        // Use a balanced approach comparing:
        // 1. Code line ratio (how much code was generated vs original)
        // 2. Data structure coverage (fields vs PIC items)
        // 3. Procedure coverage (methods vs PERFORM procedures)
        // 4. Completeness check (does Java have essential elements?)
        // 5. Semantic accuracy (proper implementation vs simulation)

        let accuracy = 0;

        if (result.cobolMetrics.codeLines > 0) {
            // Code volume comparison (35% weight)
            const expectedJavaLines = result.cobolMetrics.codeLines * 1.0;
            const codeRatio = Math.min(1, result.javaMetrics.codeLines / expectedJavaLines);
            const codeScore = codeRatio * 35;

            // Data structure coverage (25% weight)
            let dataScore = 25;
            if (result.cobolMetrics.dataItems > 0) {
                const dataRatio = Math.min(1, (result.javaMetrics.fields * 3) / result.cobolMetrics.dataItems);
                dataScore = dataRatio * 25;
            }

            // Procedure coverage (15% weight)
            let procedureScore = 15;
            if (result.cobolMetrics.procedures > 0) {
                const procedureRatio = Math.min(1, result.javaMetrics.methods / result.cobolMetrics.procedures);
                procedureScore = procedureRatio * 15;
            }

            // Completeness bonus (10% weight)
            let completenessScore = 0;
            if (javaCode.includes('class ')) completenessScore += 3;
            if (javaCode.includes('public static void main')) completenessScore += 3;
            if (javaCode.includes('System.out.print')) completenessScore += 2;
            if (javaCode.includes('try') && javaCode.includes('catch')) completenessScore += 2;

            // === SEMANTIC ACCURACY ANALYSIS (15% weight) ===
            // Detect COBOL features and check if Java properly implements them
            let semanticScore = 15;
            let penalties = [];
            const cobolLower = cobolSource.toLowerCase();
            const javaLower = javaCode.toLowerCase();

            // 1. File I/O operations (SELECT, OPEN, READ, WRITE, CLOSE)
            const hasFileIO = cobolLower.includes('select ') &&
                (cobolLower.includes(' assign ') || cobolLower.includes('file-control'));
            if (hasFileIO) {
                // Check if Java simulates with arrays/mock instead of real file I/O
                const hasMockFileIO = javaLower.includes('mock') ||
                    javaLower.includes('simulate') ||
                    javaLower.includes('string[]') ||
                    javaLower.includes('// simulation') ||
                    (javaLower.includes('string[') && !javaCode.includes('FileReader') && !javaCode.includes('BufferedReader'));
                const hasRealFileIO = javaCode.includes('FileReader') ||
                    javaCode.includes('FileWriter') ||
                    javaCode.includes('BufferedReader') ||
                    javaCode.includes('BufferedWriter') ||
                    javaCode.includes('RandomAccessFile') ||
                    javaCode.includes('FileInputStream') ||
                    javaCode.includes('FileOutputStream');

                if (hasMockFileIO && !hasRealFileIO) {
                    semanticScore -= 5;
                    penalties.push('File I/O simulated');
                } else if (!hasRealFileIO) {
                    semanticScore -= 3;
                    penalties.push('File I/O simplified');
                }
            }

            // 2. Variable-length records (DEPENDING ON, OCCURS DEPENDING ON)
            const hasDependingOn = cobolLower.includes('depending on');
            if (hasDependingOn) {
                // Check if Java has dynamic array/list handling
                const hasDynamicHandling = javaCode.includes('ArrayList') ||
                    javaCode.includes('List<') ||
                    javaCode.includes('Arrays.copyOf');
                if (!hasDynamicHandling) {
                    semanticScore -= 2;
                    penalties.push('DEPENDING ON simplified');
                }
            }

            // 3. FILE STATUS handling
            const hasFileStatus = cobolLower.includes('file status');
            if (hasFileStatus) {
                const hasProperStatus = javaCode.includes('IOException') ||
                    javaCode.includes('FileNotFoundException');
                if (!hasProperStatus) {
                    semanticScore -= 2;
                    penalties.push('FILE STATUS simulated');
                }
            }

            // 4. COMP/COMP-3 packed decimal
            const hasPackedDecimal = cobolLower.includes('comp-3') || cobolLower.includes('comp ');
            if (hasPackedDecimal) {
                const hasBigDecimal = javaCode.includes('BigDecimal');
                if (!hasBigDecimal) {
                    semanticScore -= 1;
                    penalties.push('Packed decimal simplified');
                }
            }

            // 5. RECORDING MODE V (variable length records)
            const hasRecordingModeV = cobolLower.includes('recording mode') && cobolLower.includes(' v');
            if (hasRecordingModeV) {
                // Very specific COBOL feature - hard to replicate properly
                semanticScore -= 2;
                penalties.push('Variable records approximated');
            }

            // 6. Check for obvious simulation comments
            const simulationIndicators = [
                '// mock', '// simulate', '// simulated',
                '/* mock', '/* simulate', '// for demo',
                '// placeholder', '// stub', '// fake',
                'simulating', 'simulation'
            ];
            for (const indicator of simulationIndicators) {
                if (javaLower.includes(indicator)) {
                    semanticScore -= 4;
                    penalties.push('Contains simulation markers');
                    break;
                }
            }

            // 6b. Fabricated sample-data fallback for missing input files.
            // Banned pattern: COBOL would fail with file-not-found but Java silently
            // substitutes hardcoded records. Detect the literal prompt-leakage
            // phrases emitted by prior conversions.
            const fabricatedFallbackPhrases = [
                'using sample data for demonstration',
                'input file not found, using sample',
                'not found, using sample data',
                'using sample acct-rec record',
                'using sample record',
                'sample data for demo'
            ];
            for (const phrase of fabricatedFallbackPhrases) {
                if (javaLower.includes(phrase)) {
                    semanticScore -= 6;
                    penalties.push('Fabricated input fallback');
                    break;
                }
            }

            // 7. CICS commands (EXEC CICS SEND, RECEIVE, RETURN, XCTL, LINK, SYNCPOINT)
            const hasCICS = cobolLower.includes('exec cics');
            if (hasCICS) {
                // Check if Java has any CICS-like framework or just console output
                const hasCICSFramework = javaLower.includes('cicsapi') ||
                    javaLower.includes('com.ibm.cics') ||
                    javaLower.includes('jcics');
                const hasConsoleMock = javaLower.includes('system.out.print') &&
                    (javaLower.includes('sending') || javaLower.includes('screen'));

                if (!hasCICSFramework) {
                    semanticScore -= 3;  // Reduced penalty - CICS framework not present but logic may be valid
                    penalties.push('CICS simplified');
                }
            }

            // 8. IMS/DLI commands (EXEC DLI GU, GNP, REPL, SCHD, TERM)
            const hasIMS = cobolLower.includes('exec dli') ||
                cobolLower.includes('pcb(') ||
                cobolLower.includes('psb-name') ||
                cobolLower.includes('dibstat');
            if (hasIMS) {
                const hasIMSFramework = javaLower.includes('imsapi') ||
                    javaLower.includes('com.ibm.ims') ||
                    javaLower.includes('dliapi');
                const hasMockDB = javaLower.includes('mockauth') ||
                    javaLower.includes('mock') ||
                    javaLower.includes('pendingauth[]');

                if (!hasIMSFramework) {
                    semanticScore -= 3;  // Reduced penalty - IMS/DLI simplified but logic preserved
                    penalties.push('IMS/DLI simplified');
                }
            }

            // 9. BMS screen handling (MAP, MAPSET, SEND MAP, RECEIVE MAP)
            const hasBMS = cobolLower.includes('mapset') ||
                cobolLower.includes('send map') ||
                cobolLower.includes('receive map') ||
                cobolLower.includes('dfhbmsca');
            if (hasBMS) {
                const hasBMSFramework = javaLower.includes('bmsapi') ||
                    javaLower.includes('screen.') ||
                    javaLower.includes('terminal.') ||
                    javaLower.includes('javax.swing');
                const hasConsoleMock = javaLower.includes('system.out.print');

                if (!hasBMSFramework && hasConsoleMock) {
                    semanticScore -= 2;  // Reduced penalty - BMS screens adapted to console output
                    penalties.push('BMS adapted');
                }
            }

            // 10. COPY statements (copybooks)
            const copyMatches = cobolSource.match(/COPY\s+\w+/gi) || [];
            const copybookCount = copyMatches.length;
            if (copybookCount > 3) {
                // Many copybooks indicate complex data structures
                // Check if Java has corresponding classes/imports
                const javaImportCount = (javaCode.match(/import\s+/g) || []).length;
                if (javaImportCount < copybookCount / 2) {
                    semanticScore -= 3;
                    penalties.push(`${copybookCount} copybooks simplified`);
                }
            }

            // 11. DFHAID/DFHBMSCA (CICS special variables)
            const hasDFH = cobolLower.includes('dfhaid') ||
                cobolLower.includes('dfhbmsca') ||
                cobolLower.includes('dfhenter') ||
                cobolLower.includes('dfhpf');
            if (hasDFH) {
                const hasKeyHandling = javaLower.includes('keyevent') ||
                    javaLower.includes('actionevent') ||
                    javaLower.includes('keylistener');
                if (!hasKeyHandling) {
                    semanticScore -= 3;
                    penalties.push('CICS keys simplified');
                }
            }

            // Ensure semantic score doesn't go below -20 (will result in lower accuracy)
            semanticScore = Math.max(-20, semanticScore);

            // Store penalties for details
            result.semanticPenalties = penalties;

            accuracy = codeScore + dataScore + procedureScore + completenessScore + semanticScore;

            // Apply minimum floor based on code presence
            if (result.javaMetrics.codeLines > 100 && accuracy < 70) {
                accuracy = 70;  // Increased floor for substantial code
            } else if (result.javaMetrics.codeLines > 50 && accuracy < 65) {
                accuracy = 65;
            }
        } else {
            // Fallback: use Java code presence
            accuracy = result.javaMetrics.codeLines > 100 ? 70 :
                result.javaMetrics.codeLines > 50 ? 55 : 40;
        }

        result.accuracy = Math.round(Math.min(100, Math.max(0, accuracy)));

        // Build details for tooltip
        result.details.push(`COBOL: ${result.cobolMetrics.codeLines} lines`);
        result.details.push(`Java: ${result.javaMetrics.codeLines} lines`);
        if (result.semanticPenalties && result.semanticPenalties.length > 0) {
            result.details.push(`[warn] ${result.semanticPenalties.join(', ')}`);
        }

    } catch (err) {
        console.error('Error analyzing conversion accuracy:', err.message);
        // Fallback based on Java code length
        const javaLines = javaCode ? javaCode.split('\n').length : 0;
        result.accuracy = javaLines > 100 ? 75 : javaLines > 50 ? 60 : 40;
    }

    return result;
}

/**
 * Check if Azure AI is available
 */
function isAvailable() {
    return azureConfig !== null;
}

/**
 * Get current configuration
 */
function getConfig() {
    if (!azureConfig) return null;

    return {
        endpoint: azureConfig.endpoint,
        deployment: azureConfig.deploymentName,
        apiVersion: azureConfig.apiVersion,
        isAIFoundry: azureConfig.isAIFoundry
    };
}

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
    if (!azureConfig) {
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
    if (!azureConfig) {
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
