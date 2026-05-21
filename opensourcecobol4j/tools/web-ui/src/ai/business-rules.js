/**
 * Business rule extraction and coverage analysis.
 *
 *   extractBusinessRules(cobolSource, programName)
 *     → { programName, description, businessRules[], processFlow[],
 *         dataEntities[], externalDependencies[] }
 *
 *   analyzeBusinessRuleCoverage(businessRules[], javaCode, programName)
 *     → { coverage: [{rule, status, note}], summary: {covered,partial,missing,total} }
 *
 * Both functions return null on failure rather than throwing, so the
 * caller can treat business-rule data as optional enrichment without
 * blocking the core conversion pipeline.
 *
 * processFlow step types: start | end | process | decision | io
 */

const { isAvailable, makeOpenAIRequest } = require('./azure-client');

function extractJson(raw) {
    // Strip markdown fences
    let s = raw.replace(/^```json\n?/i, '').replace(/\n?```$/i, '')
               .replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    try { return JSON.parse(s); } catch (_) {}
    // Fall back: find first { ... } block
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
    }
    return null;
}

async function extractBusinessRules(cobolSource, programName) {
    if (!isAvailable()) {
        console.warn(`   [bi] Azure not available — skipping business rules for ${programName}`);
        return null;
    }

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

        console.log(`   [bi] Extracting business rules for ${programName}...`);
        const response = await makeOpenAIRequest([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Extract business rules from this COBOL program:\n\n${cobolSource.substring(0, 8000)}` }
        ], { maxTokens: 2000 });

        if (!response?.choices?.[0]) {
            console.warn(`   [bi] No response choices for ${programName}`);
            return null;
        }

        const content = response.choices[0].message?.content || '';
        const parsed = extractJson(content);
        if (!parsed) {
            console.warn(`   [bi] JSON parse failed for ${programName}, raw snippet: ${content.substring(0, 200)}`);
            return null;
        }
        console.log(`   [bi] Extracted ${parsed.businessRules?.length || 0} rules, ${parsed.processFlow?.length || 0} flow steps for ${programName}`);
        return parsed;
    } catch (err) {
        console.error(`   [bi] Business rule extraction failed for ${programName}:`, err.message);
        return null;
    }
}

async function analyzeBusinessRuleCoverage(businessRules, javaCode, programName) {
    if (!isAvailable() || !businessRules || businessRules.length === 0 || !javaCode) return null;

    try {
        const rulesJson = JSON.stringify(businessRules);
        const prompt = `You are a code auditor. Below are business rules extracted from a COBOL program called "${programName}", followed by the Java code generated from it.

For EACH business rule, determine whether it is implemented in the Java code:
- "COVERED"  — clearly and fully implemented
- "PARTIAL"  — partly implemented or implemented with caveats
- "MISSING"  — not found in the Java code at all

Return ONLY a JSON object, no extra text:
{
  "coverage": [
    {"rule": "<exact rule text>", "status": "COVERED|PARTIAL|MISSING", "note": "<one sentence explaining why>"}
  ],
  "summary": {"covered": N, "partial": N, "missing": N, "total": N}
}

Business Rules:
${rulesJson}

Generated Java Code:
\`\`\`java
${javaCode.substring(0, 6000)}
\`\`\``;

        const response = await makeOpenAIRequest([
            { role: 'user', content: prompt }
        ], { temperature: 0.2, maxTokens: 2000 });

        if (!response?.choices?.[0]) return null;

        const content = response.choices[0].message?.content || '';
        const parsed = extractJson(content);
        if (!parsed) console.warn(`   [bi] Coverage JSON parse failed for ${programName}`);
        return parsed;
    } catch (err) {
        console.error(`   [bi] Coverage analysis failed for ${programName}:`, err.message);
        return null;
    }
}

module.exports = { extractBusinessRules, analyzeBusinessRuleCoverage };
