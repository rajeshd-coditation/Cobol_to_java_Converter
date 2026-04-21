/**
 * toPascalCase — canonical COBOL-basename → Java-class transform.
 *
 * Used by every path that needs to know what Java class a COBOL source
 * will produce: the conversion worker (to anchor the `public class` line),
 * /api/fix-java (sibling lookup), analysis-context (PROGRAM-ID → class map),
 * and the accuracy scorer.
 *
 * Treats `-` and `_` as word separators, uppercases each word's first char,
 * lowercases the rest, joins with no delimiter:
 *   CBL0001          → Cbl0001
 *   HELLO-APP        → HelloApp
 *   cust_file_rd     → CustFileRd
 *
 * Lives in src/util (not src/core) because it has no domain knowledge —
 * it's just string munging. Historically duplicated across server.js +
 * azureAgent.js; consolidated here so prompt changes that affect class
 * names can't silently drift between the two.
 */
function toPascalCase(str) {
    return str
        .replace(/[-_]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

module.exports = { toPascalCase };
