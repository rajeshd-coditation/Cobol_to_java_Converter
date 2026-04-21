/**
 * Normalize a Java source so its public class matches the file name.
 *
 * The file on disk is named after the COBOL basename (PascalCase); `java <cls>`
 * requires the public class name to match. This handles:
 *   - AI returning a completely different class name (e.g. CardAuthorization
 *     instead of COPAUA0C) — detected from the `public class` declaration.
 *   - AI returning the COBOL basename verbatim (not PascalCase) — upper/lower
 *     case variants of the basename get rewritten.
 * Used by both the initial conversion path AND the auto-repair path so a fixed
 * Java file with a preserved-but-wrong class name still produces a runnable file.
 */
function normalizeClassName(javaCode, javaClassName, baseName) {
    if (!javaCode) return javaCode;
    let out = javaCode;

    // Step 1: if the declared public class name differs from the target, rewrite
    // every reference (decl, ctor, new X(), type refs, static calls).
    const classNameMatch = out.match(/public\s+class\s+(\w+)\s*\{/);
    const aiGeneratedClassName = classNameMatch ? classNameMatch[1] : null;
    if (aiGeneratedClassName && aiGeneratedClassName !== javaClassName) {
        console.log(`   🔧 Fixing class name: ${aiGeneratedClassName} → ${javaClassName}`);
        const rename = (pattern) => {
            out = out.replace(pattern, (m, a, b) => `${a}${javaClassName}${b !== undefined ? b : ''}`);
        };
        rename(new RegExp(`(public\\s+class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'));
        rename(new RegExp(`(class\\s+)${aiGeneratedClassName}(\\s*\\{)`, 'g'));
        rename(new RegExp(`(public\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'));
        rename(new RegExp(`(new\\s+)${aiGeneratedClassName}(\\s*\\()`, 'g'));
        rename(new RegExp(`(^|[\\s,\\(])${aiGeneratedClassName}(\\s+\\w+\\s*[=;,\\)])`, 'gm'));
        rename(new RegExp(`(^|[\\s\\(])${aiGeneratedClassName}(\\.\\w+)`, 'gm'));
    }

    // Step 2: rewrite all case-variant references to the basename itself.
    // Catches things like `class CBL0001 {` or `new cbl0001()` that survived
    // step 1 because the AI used the raw COBOL name as the class.
    const variants = [baseName, baseName.toLowerCase(), baseName.toUpperCase()];
    for (const variant of variants) {
        out = out.replace(new RegExp(`(public\\s+class\\s+)${variant}(\\s*\\{)`, 'gi'), `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(class\\s+)${variant}(\\s*\\{)`, 'gi'),            `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(public\\s+)${variant}(\\s*\\()`, 'gi'),            `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(new\\s+)${variant}(\\s*\\()`, 'gi'),               `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(^|[\\s,\\(])${variant}(\\s+\\w+\\s*[=;,\\)])`, 'gim'), `$1${javaClassName}$2`);
        out = out.replace(new RegExp(`(^|[\\s\\(])${variant}(\\.\\w+)`, 'gim'),               `$1${javaClassName}$2`);
    }

    return out;
}

module.exports = { normalizeClassName };
