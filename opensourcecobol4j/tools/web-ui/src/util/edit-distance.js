/**
 * Classic Levenshtein edit distance.
 * Used to suggest likely COBOL typos (e.g. PRINT-REX vs PRINT-REC) when the
 * compiler reports an undefined identifier. Bails out early if the lengths
 * differ by more than 2 — we only care about distance <= 1, occasionally 2.
 */
function editDistance(a, b) {
    a = String(a); b = String(b);
    if (Math.abs(a.length - b.length) > 2) return 99;
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

module.exports = { editDistance };
