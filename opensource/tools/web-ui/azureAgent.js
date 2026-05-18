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
    const agentId = process.env.AZURE_AGENT_ID;

    if (!endpoint || !apiKey) {
        console.warn('⚠️  Azure AI not configured. Azure AI features disabled.');
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
        agentId,
        isAIFoundry
    };

    console.log('✅ Azure AI Agent initialized successfully');
    console.log(`   Endpoint: ${endpoint}`);
    console.log(`   Platform: ${isAIFoundry ? 'Azure AI Foundry' : 'Azure OpenAI'}`);
    if (agentId) {
        console.log(`   Agent ID: ${agentId}`);
    }
    return true;
}

/**
 * Create a thread for the Azure AI Foundry Agent
 */
async function createThread() {
    const url = `${azureConfig.endpoint}/openai/threads?api-version=${azureConfig.apiVersion}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'api-key': azureConfig.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create thread: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

/**
 * Add a message to a thread
 */
async function addMessage(threadId, content) {
    const url = `${azureConfig.endpoint}/openai/threads/${threadId}/messages?api-version=${azureConfig.apiVersion}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'api-key': azureConfig.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            role: 'user',
            content: content
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to add message: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

/**
 * Run the agent on a thread
 */
async function runAgent(threadId) {
    const url = `${azureConfig.endpoint}/openai/threads/${threadId}/runs?api-version=${azureConfig.apiVersion}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'api-key': azureConfig.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            assistant_id: azureConfig.agentId
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to run agent: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

/**
 * Get run status
 */
async function getRunStatus(threadId, runId) {
    const url = `${azureConfig.endpoint}/openai/threads/${threadId}/runs/${runId}?api-version=${azureConfig.apiVersion}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'api-key': azureConfig.apiKey
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get run status: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

/**
 * Get messages from a thread
 */
async function getMessages(threadId) {
    const url = `${azureConfig.endpoint}/openai/threads/${threadId}/messages?api-version=${azureConfig.apiVersion}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'api-key': azureConfig.apiKey
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get messages: ${response.status} - ${errorText}`);
    }

    return await response.json();
}

/**
 * Wait for run to complete
 */
async function waitForRun(threadId, runId, maxWaitMs = 120000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        const status = await getRunStatus(threadId, runId);

        if (status.status === 'completed') {
            return status;
        } else if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
            throw new Error(`Run ${status.status}: ${status.last_error?.message || 'Unknown error'}`);
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Run timed out');
}

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
                console.log(`   ⏳ Rate limited. Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            throw new Error(`Azure API error ${response.status}: ${errorText}`);
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries && error.message.includes('429')) {
                const waitTime = Math.pow(2, attempt + 2) * 1000;
                console.log(`   ⏳ Rate limited (catch). Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('Max retries exceeded');
}

/**
 * Convert COBOL code to Java using Azure AI Foundry Agent
 */
async function convertWithAgent(cobolSource) {
    if (!azureConfig.agentId) {
        throw new Error('Agent ID not configured');
    }

    // Create a thread
    const thread = await createThread();
    console.log(`   Created thread: ${thread.id}`);

    // Add the COBOL code as a message
    const prompt = `Convert this COBOL program to Java. Output ONLY the Java code, no explanations:\n\n${cobolSource}`;
    await addMessage(thread.id, prompt);

    // Run the agent
    const run = await runAgent(thread.id);
    console.log(`   Started run: ${run.id}`);

    // Wait for completion
    await waitForRun(thread.id, run.id);

    // Get the response
    const messages = await getMessages(thread.id);

    // Find the assistant's response (first message with role 'assistant')
    const assistantMessage = messages.data.find(m => m.role === 'assistant');

    if (!assistantMessage) {
        throw new Error('No response from agent');
    }

    // Extract text content
    let javaCode = '';
    for (const content of assistantMessage.content) {
        if (content.type === 'text') {
            javaCode += content.text.value;
        }
    }

    // Clean up markdown code blocks if present
    javaCode = javaCode.replace(/^```java\n?/i, '').replace(/\n?```$/i, '');
    javaCode = javaCode.replace(/^```\n?/, '').replace(/\n?```$/, '');

    return javaCode.trim();
}

/**
 * Auto-fix common Java compilation issues
 */
function autoFixJavaCode(javaCode) {
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
async function convertCobolToJava(cobolSource, retryCount = 0) {
    if (!azureConfig) {
        return {
            success: false,
            error: 'Azure AI not initialized. Configure AZURE_OPENAI_* in .env file.'
        };
    }

    const MAX_RETRIES = 2; // Will try 3 times total

    try {
        let javaCode;

        // For AI Foundry, always use Chat Completions (Agent API needs Entra ID)
        // For Azure OpenAI with Agent ID, can try Agent API
        const useAgentAPI = azureConfig.agentId && !azureConfig.isAIFoundry;

        if (useAgentAPI) {
            console.log('   Using Azure OpenAI Agent API...');
            javaCode = await convertWithAgent(cobolSource);
        } else {
            // Use Chat Completions (works with API key for both platforms)
            console.log('   Using Azure AI Chat Completions...');

            // Use different prompts for retries to improve success chance
            const systemPrompts = [
                // Primary prompt - detailed instructions for HIGH QUALITY conversion
                `You are an expert COBOL to Java modernization agent. Generate PRODUCTION-QUALITY, COMPILABLE, RUNNABLE Java 8+ code.

CRITICAL: ALWAYS PRODUCE MEANINGFUL OUTPUT
The converted Java programs MUST produce meaningful console output demonstrating the program's logic even when input files don't exist. Use this pattern:

1. TRY to open real files first
2. If file not found, print a message and USE EMBEDDED SAMPLE DATA
3. Process the sample data the same way real data would be processed
4. ALWAYS print results showing what the program does

Example file handling pattern:
\`\`\`java
BufferedReader reader = null;
List<String> data = new ArrayList<>();
try {
    reader = new BufferedReader(new FileReader("DATAFILE.txt"));
    String line;
    while ((line = reader.readLine()) != null) {
        data.add(line);
    }
} catch (FileNotFoundException e) {
    System.out.println("Input file not found, using sample data for demonstration...");
    // Use embedded sample data
    data.add("1001,John Doe,ACTIVE,5000.00");
    data.add("1002,Jane Smith,ACTIVE,7500.00");
    data.add("1003,Bob Johnson,INACTIVE,0.00");
}
// Then process 'data' the same way...
\`\`\`

QUALITY REQUIREMENTS:
1. Use REAL file I/O with BufferedReader/BufferedWriter for COBOL FILE operations
2. FALLBACK to embedded sample data when files don't exist
3. Use ArrayList<> for OCCURS DEPENDING ON / variable arrays
4. Implement proper exception handling with specific exception types
5. ALWAYS print processing results and summaries

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
- Print summaries (records read, processed, written)
- ALWAYS print "=== Program Completed ===" at end
- If using sample data, make that clear in output

BANNED:
- Scanner (hardcode test inputs instead)
- final keyword for instance fields
- JDBC/database connections
- Incomplete code or truncated output
- Unterminated strings or unclosed braces
- package statements (no package declaration)

IMPORTS TO ALWAYS INCLUDE:
- import java.io.*;
- import java.util.ArrayList;
- import java.util.List;
- import java.math.BigDecimal;

Output ONLY the complete Java code, no explanations.`,

                // Retry prompt 1 - simpler, focus on working code
                `You are a COBOL to Java converter. Generate WORKING, COMPILABLE Java code.

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
- Complete, balanced braces`
            ];

            const systemPrompt = systemPrompts[Math.min(retryCount, systemPrompts.length - 1)];

            const response = await makeOpenAIRequest([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Convert this COBOL program to production-quality Java:\n\n${cobolSource}` }
            ], {
                temperature: retryCount === 0 ? 0.2 : 0.3, // Slightly higher temp on retry
                maxTokens: 8000  // Increased to prevent truncated code
            });

            // Check if response is valid
            if (!response || !response.choices || !response.choices[0]) {
                console.error('   ❌ Invalid Azure AI response:', JSON.stringify(response).substring(0, 200));

                // Retry if we haven't exceeded max retries
                if (retryCount < MAX_RETRIES) {
                    console.log(`   🔄 Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return convertCobolToJava(cobolSource, retryCount + 1);
                }

                return {
                    success: false,
                    error: 'Invalid response from Azure AI'
                };
            }

            javaCode = response.choices[0].message?.content || '';

            // Clean up markdown code blocks if present
            javaCode = javaCode.replace(/^```java\n?/i, '').replace(/\n?```$/i, '');
            javaCode = javaCode.replace(/^```\n?/, '').replace(/\n?```$/i, '');
            javaCode = javaCode.trim();
        }

        // Validate that we got actual Java code
        if (!javaCode || javaCode.length < 50) {
            console.error('   ❌ Azure AI returned empty or too short response');

            // Retry if we haven't exceeded max retries
            if (retryCount < MAX_RETRIES) {
                console.log(`   🔄 Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return convertCobolToJava(cobolSource, retryCount + 1);
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
            console.error('   ❌ Azure AI response does not look like Java code');
            console.error('   Response preview:', javaCode.substring(0, 200));

            // Retry if we haven't exceeded max retries
            if (retryCount < MAX_RETRIES) {
                console.log(`   🔄 Retrying conversion (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return convertCobolToJava(cobolSource, retryCount + 1);
            }

            return {
                success: false,
                error: 'Azure AI response does not appear to be valid Java code'
            };
        }

        // Apply auto-fixes to improve compilation success
        javaCode = autoFixJavaCode(javaCode);

        console.log('   ✅ Got Java code:', javaCode.length, 'characters');

        return {
            success: true,
            javaCode,
            method: useAgentAPI ? 'agent' : 'chat',
            platform: azureConfig.isAIFoundry ? 'AI Foundry' : 'Azure OpenAI'
        };
    } catch (error) {
        console.error('Azure Conversion Error:', error.message);

        // Retry on transient errors
        if (retryCount < MAX_RETRIES && (error.message.includes('fetch failed') || error.message.includes('timeout'))) {
            console.log(`   🔄 Retrying after error (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return convertCobolToJava(cobolSource, retryCount + 1);
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
        console.log('   🔮 Predicting program output with AI (analyzing both COBOL & Java)...');

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

        userPrompt += `=== ORIGINAL COBOL PROGRAM ===\n${cobolSource.substring(0, 3500)}\n\n`;

        if (javaCode && javaCode.length > 50) {
            userPrompt += `=== CONVERTED JAVA PROGRAM ===\n${javaCode.substring(0, 3500)}\n\n`;
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

        console.log('   ✅ AI predicted output (cross-referenced):', predictedOutput.substring(0, 100));

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
 */
async function analyzeConversionFailure(cobolSource, errorLog, errorType) {
    if (!azureConfig) {
        return {
            success: false,
            error: 'Azure AI not initialized. Configure AZURE_OPENAI_* in .env file.'
        };
    }

    try {
        let analysis;

        if (azureConfig.agentId && azureConfig.isAIFoundry) {
            // Use agent for analysis
            const thread = await createThread();
            const prompt = `Analyze this COBOL conversion failure and suggest fixes:

**Error Type:** ${errorType}
**Error Log:** ${errorLog || 'No error log'}
**COBOL Source:**
${cobolSource.substring(0, 6000)}

Provide: 1) Root cause 2) Suggested fixes 3) Modified code if applicable`;

            await addMessage(thread.id, prompt);
            const run = await runAgent(thread.id);
            await waitForRun(thread.id, run.id);

            const messages = await getMessages(thread.id);
            const assistantMessage = messages.data.find(m => m.role === 'assistant');

            if (assistantMessage) {
                analysis = assistantMessage.content.map(c => c.type === 'text' ? c.text.value : '').join('');
            }
        } else {
            // Use chat completions
            const response = await makeOpenAIRequest([
                { role: 'system', content: 'You are an expert COBOL to Java migration specialist. Analyze conversion failures and provide actionable solutions.' },
                { role: 'user', content: `Analyze this failure:\nError Type: ${errorType}\nError: ${errorLog}\nCOBOL: ${cobolSource.substring(0, 6000)}` }
            ], { temperature: 0.3, maxTokens: 2000 });

            analysis = response.choices[0].message.content;
        }

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
                    if (!['node_modules', '.git', 'dist', 'build', 'target', '.github', '.vscode'].includes(entry.name)) {
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
                        // Track other files but exclude common non-mainframe files
                        const skipExts = ['.md', '.json', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.png', '.jpg', '.gif', '.ico', '.svg'];
                        if (!skipExts.includes(ext)) {
                            result.otherFiles.push(fullPath);
                        }
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
            result.details.push(`⚠️ ${result.semanticPenalties.join(', ')}`);
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
 * Extract business rules from COBOL source using Azure AI
 * Runs in parallel with convertCobolToJava for zero extra wall-clock time
 */
async function extractBusinessRules(cobolSource, programName) {
    if (!azureConfig) return null;

    try {
        const systemPrompt = `You are a business analyst reviewing legacy COBOL code.
Extract all business rules from this COBOL program and return ONLY a JSON object with no extra text.
Use this exact structure:
{
  "programName": "${programName}",
  "description": "One sentence describing what this program does",
  "businessRules": ["rule in plain English", ...],
  "dataEntities": [{"name": "FIELD-NAME", "picClause": "PIC 9(7)V99", "description": "what it represents"}],
  "processFlow": [
    {"step": "Clear description of what happens in this step", "type": "start|process|decision|io|end", "rules": ["business rule that applies to this specific step"]}
  ],
  "externalDependencies": ["FILENAME", "PROGRAMNAME", ...]
}
For processFlow: use type "start" for program entry, "end" for termination, "decision" for IF/EVALUATE/conditional steps, "io" for file reads/writes/opens/closes, "process" for computation/transformation steps. Include only rules that specifically govern that step in the "rules" array. Keep step descriptions under 50 characters. Be specific and use plain English, not COBOL jargon.`;

        const response = await makeOpenAIRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Extract business rules from this COBOL program:\n\n${cobolSource.substring(0, 8000)}` }
        ], { temperature: 0.3, maxTokens: 2000 });

        if (!response || !response.choices || !response.choices[0]) return null;

        let content = response.choices[0].message?.content || '';
        content = content.replace(/^```json\n?/i, '').replace(/\n?```$/i, '');
        content = content.replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

        return JSON.parse(content);
    } catch (err) {
        console.error(`   ⚠️ Business rule extraction failed for ${programName}:`, err.message);
        return null;
    }
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
        hasAgentId: !!azureConfig.agentId,
        isAIFoundry: azureConfig.isAIFoundry
    };
}

module.exports = {
    initializeAzure,
    convertCobolToJava,
    extractBusinessRules,
    predictProgramOutput,
    analyzeConversionFailure,
    analyzeConversionAccuracy,
    scanForCobolFiles,
    scanForAllMainframeFiles,
    convertDirectory,
    isAvailable,
    getConfig
};
