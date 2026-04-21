/**
 * POST /api/fix-cobol/:id/:fileId — apply a one-click typo fix to a
 * COBOL source file, parallel to the Java-side /api/fix-java.
 *
 * Body: { bad, suggestion }
 *   bad        the undefined identifier cobc flagged
 *   suggestion the canonical name to rewrite it to
 *
 * Safety:
 *   - The `bad` identifier must actually appear in the source (avoids
 *     no-op fixes after a prior edit or a misrouted request).
 *   - Whole-word rewrite only — uses `(?<![A-Z0-9_-])bad(?![A-Z0-9_-])`
 *     so partial matches inside longer identifiers (e.g. PRINT-RECX
 *     when replacing PRINT-REC) aren't touched.
 *   - Backup to `<basename>.cbl.before-fix` created on first fix; left
 *     untouched on repeated fixes so `undo-fix` always returns to the
 *     pristine original.
 *   - UPPERCASE-normalized match: COBOL identifiers are case-insensitive,
 *     so we replace all casings but keep the suggestion's canonical
 *     casing (UPPER as cobc uses).
 *
 * Response: { ok, replacements, backupPath } on success; { ok:false,
 * error } with a meaningful status otherwise.
 *
 * Paired with GET /api/fix-cobol-diff/:id/:fileId + POST /api/unfix-cobol
 * for the same View-diff / Undo UX the Java repair has.
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

const fs = require('fs');
const path = require('path');

const IDENT_CHARS = 'A-Za-z0-9_\\-';

function findEntry(conversion, fileId) {
    if (!conversion || !conversion.result || !conversion.result.report) return null;
    const norm = String(fileId).replace(/\\/g, '/');
    return (conversion.result.report.files || []).find(f => (f.path || '').replace(/\\/g, '/') === norm) || null;
}

function backupPathFor(entry) {
    // Source extension varies (.cob / .cbl / .cobol). Append the backup
    // suffix on the full basename so the original extension stays visible
    // in the backup filename — useful for manual inspection.
    return entry.source_path + '.before-fix';
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mount(app, deps) {
    const { activeConversions } = deps;

    // Get the pre-fix vs current source side-by-side, so the UI can
    // render a diff modal mirroring the Java "View fix diff" behavior.
    app.get('/api/fix-cobol-diff/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const entry = findEntry(conversion, req.params.fileId);
        if (!entry || !entry.source_path) return res.status(404).json({ error: 'File not in report' });
        const bpath = backupPathFor(entry);
        if (!fs.existsSync(bpath)) return res.json({ hasBackup: false });
        try {
            const before = fs.readFileSync(bpath, 'utf-8');
            const after  = fs.readFileSync(entry.source_path, 'utf-8');
            res.json({ hasBackup: true, before, after });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read fix artifacts: ' + err.message });
        }
    });

    // Restore the pre-fix backup. Deletes the backup so a subsequent
    // fix-then-unfix cycle starts clean (same pattern as the Java side).
    app.post('/api/unfix-cobol/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        const entry = findEntry(conversion, req.params.fileId);
        if (!entry || !entry.source_path) return res.status(404).json({ error: 'File not in report' });
        const bpath = backupPathFor(entry);
        if (!fs.existsSync(bpath)) {
            return res.status(400).json({ error: 'No backup to restore — has a COBOL fix been applied?' });
        }
        try {
            const restored = fs.readFileSync(bpath, 'utf-8');
            fs.writeFileSync(entry.source_path, restored, 'utf-8');
            fs.unlinkSync(bpath);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: 'Restore failed: ' + err.message });
        }
    });

    app.post('/api/fix-cobol/:id/:fileId(*)', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ ok: false, error: 'Conversion not found' });
        const entry = findEntry(conversion, req.params.fileId);
        if (!entry || !entry.source_path || !fs.existsSync(entry.source_path)) {
            return res.status(404).json({ ok: false, error: 'Source file not found' });
        }

        const bad = (req.body && req.body.bad || '').trim();
        const suggestion = (req.body && req.body.suggestion || '').trim();
        // Both identifiers must match the COBOL identifier grammar — keeps
        // the rewrite regex-safe and rejects injection attempts.
        const IDENT_RE = /^[A-Z][A-Z0-9_-]*$/i;
        if (!IDENT_RE.test(bad) || !IDENT_RE.test(suggestion)) {
            return res.status(400).json({ ok: false, error: 'bad/suggestion must be COBOL identifiers' });
        }
        if (bad === suggestion) {
            return res.status(400).json({ ok: false, error: 'bad and suggestion are identical' });
        }

        let source;
        try { source = fs.readFileSync(entry.source_path, 'utf-8'); }
        catch (err) { return res.status(500).json({ ok: false, error: 'read failed: ' + err.message }); }

        // Whole-word case-insensitive replace. Negative-lookbehind /
        // lookahead ensure we don't partial-match inside longer
        // identifiers (PRINT-RECORD when replacing PRINT-REC).
        const pattern = new RegExp(
            `(?<![${IDENT_CHARS}])${escapeRegex(bad)}(?![${IDENT_CHARS}])`,
            'gi'
        );
        const matches = source.match(pattern) || [];
        if (matches.length === 0) {
            return res.status(400).json({ ok: false, error: `'${bad}' does not appear in the source` });
        }

        // Backup ONCE — preserves the pristine original across repeated
        // fix / unfix / fix cycles.
        const bpath = backupPathFor(entry);
        if (!fs.existsSync(bpath)) {
            try { fs.copyFileSync(entry.source_path, bpath); } catch {}
        }

        // Upper-cased suggestion: cobc identifiers are case-insensitive
        // at the language level but source typically uses UPPER. Keep
        // replacement consistent rather than preserving the (possibly
        // wrong) casing of each bad occurrence.
        const upperSuggestion = suggestion.toUpperCase();
        const newSource = source.replace(pattern, upperSuggestion);

        try {
            fs.writeFileSync(entry.source_path, newSource, 'utf-8');
        } catch (err) {
            return res.status(500).json({ ok: false, error: 'write failed: ' + err.message });
        }

        res.json({
            ok: true,
            replacements: matches.length,
            backupPath: path.basename(bpath)
        });
    });
}

module.exports = { mount };
