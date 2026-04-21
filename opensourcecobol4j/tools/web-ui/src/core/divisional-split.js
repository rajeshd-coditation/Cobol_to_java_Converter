/**
 * Two-pass divisional converter for oversized COBOL programs (§16).
 *
 * When a source file is too big to fit one-shot in the deployment's
 * context window, split at the PROCEDURE DIVISION boundary and convert
 * each half separately, then stitch the results:
 *
 *   1. Part A = IDENTIFICATION + ENVIRONMENT + DATA divisions.
 *      → Convert to a Java class with the fields/constants/file handles
 *        but no business logic (empty method bodies).
 *   2. Part B = IDENTIFICATION header + PROCEDURE DIVISION.
 *      → Pass Part A's Java as context so the AI knows the field shapes
 *        and class name, then generate the method bodies.
 *   3. Stitch Part B's method bodies into Part A's class skeleton.
 *
 * Both halves stay well under the one-shot cap individually (PROCEDURE
 * DIVISION is usually 60-70% of the file). Stitching is structural
 * (textual substitution of method bodies), NOT AI-mediated — keeps the
 * output deterministic.
 *
 * The splitter is conservative: it only attempts when it finds a clear
 * PROCEDURE DIVISION marker. Files without one (copybook-like shapes,
 * or programs with unusual formatting) fall back to SKIPPED_TOO_LARGE
 * with a note so the user can decide how to proceed.
 *
 * ENABLE_DIVISIONAL_SPLIT env var gates the feature; default off for
 * now since the two-call flow doubles token cost and is only worth it
 * for genuinely oversized files. Off by default, on when explicitly
 * enabled by a user who has seen SKIPPED_TOO_LARGE and wants to pay
 * for the split.
 */

// Marker regex — forgiving of different COBOL dialects (with or without
// sequence numbers; with or without trailing period on the first line).
const PROCEDURE_DIVISION_RE = /^[ \t]*(?:\d+[ \t]+)?PROCEDURE\s+DIVISION\b/im;

/**
 * Split the COBOL source at PROCEDURE DIVISION. Returns null if no clean
 * split is possible (markers missing / ambiguous).
 */
function splitAtProcedureDivision(cobolSource) {
    const match = PROCEDURE_DIVISION_RE.exec(cobolSource);
    if (!match) return null;
    const procStart = match.index;
    const partA = cobolSource.slice(0, procStart);
    const partB = cobolSource.slice(procStart);
    // Both halves must carry the IDENTIFICATION DIVISION header so each
    // AI call sees the same PROGRAM-ID. Part A already has it; synthesize
    // one for Part B by prepending a minimal header.
    const progIdMatch = /PROGRAM-ID\s*\.\s*['"]?([A-Za-z0-9_-]+)/im.exec(partA);
    const programId = progIdMatch ? progIdMatch[1] : 'PROGRAM';
    const bHeader = `      * [divisional-split] Reconstructed IDENTIFICATION header for Part B.\n` +
                   `       IDENTIFICATION DIVISION.\n` +
                   `       PROGRAM-ID. ${programId}.\n\n`;
    return {
        partA: partA + '\n       PROCEDURE DIVISION.\n           EXIT.\n', // Minimal procedure for Part A so it compiles / the AI emits a class with empty bodies
        partB: bHeader + partB,
        programId
    };
}

/**
 * Stitch Part A's class skeleton (from the data-division-only conversion)
 * with Part B's method bodies (from the procedure-division conversion).
 *
 * Strategy: take Part A as the class skeleton (fields, imports, empty
 * methods), then for each public non-constructor method in Part B whose
 * name matches one in Part A, replace Part A's empty body with Part B's
 * body.
 *
 * Falls back to concatenation when method-name matching fails — the
 * caller can hand the stitched output through autoFixJavaCode which
 * will catch simple issues.
 */
function stitchJava(partAJava, partBJava) {
    if (!partAJava) return partBJava;
    if (!partBJava) return partAJava;

    // Extract method bodies from Part B keyed by method name. Match
    // `public <rettype> <name>(<args>) {...}` and capture name + body.
    // Use a balanced-brace walk (cheap since the code came from one
    // class) to isolate each method's body.
    const methodBodies = {};
    let pos = 0;
    const methodHeaderRe = /\b(public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{/g;
    let hm;
    while ((hm = methodHeaderRe.exec(partBJava)) !== null) {
        const name = hm[2];
        if (name === 'main') continue; // main is stitched separately from Part A's skeleton
        // Walk from the opening brace to find the matching close.
        const openIdx = hm.index + hm[0].length - 1;
        let depth = 1;
        for (let i = openIdx + 1; i < partBJava.length; i++) {
            const ch = partBJava[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    methodBodies[name] = partBJava.slice(openIdx + 1, i);
                    break;
                }
            }
        }
    }
    if (Object.keys(methodBodies).length === 0) {
        // No methods extracted — couldn't stitch; concat with a comment.
        return partAJava + '\n\n// [divisional-split] Part B Java (unstitched — method-name matching failed):\n/*\n' + partBJava + '\n*/\n';
    }

    // Walk Part A and swap in bodies for any matching method name.
    let out = partAJava;
    for (const [name, body] of Object.entries(methodBodies)) {
        const re = new RegExp(`(\\b(?:public|private|protected)\\s+(?:static\\s+)?[\\w<>\\[\\]]+\\s+${name}\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?\\s*\\{)[\\s\\S]*?(\\n\\s*\\})`, 'm');
        if (re.test(out)) {
            out = out.replace(re, (m, openGroup) => `${openGroup}${body}\n    }`);
        } else {
            // Method exists in Part B but not Part A — append at the end
            // before the final class-closing brace.
            const lastBrace = out.lastIndexOf('}');
            if (lastBrace > 0) {
                out = out.slice(0, lastBrace) +
                    `\n    // [divisional-split] Method from Part B (not declared in Part A skeleton):\n` +
                    `    private void ${name}() {${body}\n    }\n` +
                    out.slice(lastBrace);
            }
        }
    }
    return out;
}

function isSplitEnabled() {
    // Off by default — splitting doubles token cost. Users who actually
    // have oversized files opt in via the env var.
    const v = process.env.ENABLE_DIVISIONAL_SPLIT;
    return v === '1' || v === 'true' || v === 'yes';
}

module.exports = {
    splitAtProcedureDivision,
    stitchJava,
    isSplitEnabled,
    PROCEDURE_DIVISION_RE
};
