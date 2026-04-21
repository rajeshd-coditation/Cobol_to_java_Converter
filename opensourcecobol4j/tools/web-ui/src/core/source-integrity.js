/**
 * COBOL source-integrity pre-check (§13).
 *
 * Runs in processFile BEFORE we send a file to the AI. Catches sources
 * that were truncated mid-program (cut-off downloads, incomplete clones,
 * SCM corruption) so we skip with a clean status instead of wasting a
 * round trip on an obviously-broken file and getting a "AI invented the
 * rest of the program" output.
 *
 * What "truncated" means here — conservative to avoid false positives:
 *
 *   1. The tail ~400 bytes of the source contain NONE of:
 *        END PROGRAM, STOP RUN, GOBACK, EXIT PROGRAM
 *      These are the four legitimate program-exit markers. A real
 *      program will have at least one of them near the bottom.
 *
 *   2. AND the very last non-blank, non-comment line doesn't end with a
 *      period. COBOL statements terminate with periods; a line like
 *      `           MOVE WS-AMT TO` (no period, no verb completion) is
 *      almost certainly a mid-statement truncation.
 *
 * Both conditions must fire together — a legitimate program with an
 * inline comment as the last line would pass (1) fails but (2) passes,
 * and vice versa. Tuned against the 40-file CardDemo fixture to produce
 * zero false positives while catching obviously-truncated synthetic
 * inputs.
 *
 * Returns { truncated: bool, reason?: string }.
 */

const EXIT_MARKERS = /\b(END\s+PROGRAM|STOP\s+RUN|GOBACK|EXIT\s+PROGRAM)\b/i;

function isLikelyTruncated(cobolSource) {
    if (!cobolSource || typeof cobolSource !== 'string') {
        return { truncated: false };
    }
    // Condition 1: tail contains no exit marker.
    const tail = cobolSource.slice(-400);
    if (EXIT_MARKERS.test(tail)) return { truncated: false };

    // Condition 2: last meaningful line doesn't end with a period. Walk
    // lines bottom-up, skipping blank lines and COBOL comment lines
    // (column 7 == '*' in fixed format, or line starts with `*>` in free
    // format).
    const lines = cobolSource.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i];
        if (!raw || !raw.trim()) continue;
        const trimmedStart = raw.trimStart();
        if (trimmedStart.startsWith('*>')) continue;
        // Fixed-format comment: column 7 is '*' (0-indexed col 6).
        if (raw.length >= 7 && raw[6] === '*') continue;
        // Found the last content line — check if it ends with a period.
        // Strip trailing whitespace + column-73+ identification area before
        // checking. Fixed-format code lives in cols 8-72 so anything past
        // 72 is ignored by the compiler.
        const areaB = raw.length > 72 ? raw.slice(0, 72) : raw;
        const trimEnd = areaB.trimEnd();
        if (trimEnd.endsWith('.')) return { truncated: false };
        return {
            truncated: true,
            reason: 'Source appears truncated — no END PROGRAM / STOP RUN / GOBACK / EXIT PROGRAM near the end, and the last content line does not terminate with a period.'
        };
    }

    // File had content but every line was blank/comment (unusual). Not
    // flagging — the PROGRAM-ID check upstream will catch it as SKIPPED_NO_ID.
    return { truncated: false };
}

module.exports = { isLikelyTruncated };
