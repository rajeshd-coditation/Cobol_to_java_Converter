/**
 * Status / browser / files endpoints — all read-only, all keyed on the
 * conversion id, all backed by the in-memory activeConversions map.
 *
 *   GET /api/status/:id   — full conversion object (used by pollStatus).
 *   GET /api/browser/:id  — shape the Results Browser tree view consumes.
 *   GET /api/files/:id    — legacy list of generated Java files on disk.
 *
 * mount(app, deps) where deps = { activeConversions }.
 */

const fs = require('fs');
const path = require('path');

function mount(app, deps) {
    const { activeConversions } = deps;

    // GET /api/status/:id — returns the full in-memory conversion object,
    // including fileStates / tokens / graph ready-ness. The frontend polls
    // this every 1-2s during a conversion.
    app.get('/api/status/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        res.json(conversion);
    });

    // GET /api/browser/:id — projects the report into the shape the Results
    // Browser expects (cobolPath/javaPath/status/accuracy/penalties).
    app.get('/api/browser/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion) return res.status(404).json({ error: 'Conversion not found' });
        if (!conversion.result || !conversion.result.report) {
            return res.json({ ready: false, status: conversion.status });
        }
        const reportFiles = conversion.result.report.files || [];
        const files = reportFiles.map(f => ({
            cobolPath: f.path,
            cobolSourcePath: f.source_path,
            javaPath: f.java_path || null,
            workDir: f.work_dir || null,
            status: f.java_status,
            accuracy: f.conversionAccuracy != null ? f.conversionAccuracy : null,
            // Semantic penalty list — surfaces "File I/O simulated", "CICS
            // simplified", etc. for a badge tooltip on the row.
            penalties: (f.accuracyBreakdown && f.accuracyBreakdown.semanticPenalties) || [],
            error: f.error || null
        }));
        res.json({
            ready: true,
            status: conversion.status,
            files,
            outputDir: conversion.result.outputDir,
            postReview: conversion.postReview || {}
        });
    });

    // GET /api/files/:id — list the generated Java files on disk. Legacy
    // endpoint used by older parts of the UI; kept for compatibility.
    app.get('/api/files/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion || !conversion.result) {
            return res.status(404).json({ error: 'Conversion not found or not complete' });
        }
        const javaDir = path.join(conversion.result.outputDir, 'java');
        let javaFiles = [];
        try {
            if (fs.existsSync(javaDir)) {
                javaFiles = fs.readdirSync(javaDir)
                    .filter(f => f.endsWith('.java'))
                    .map(f => ({ name: f, path: path.join(javaDir, f) }));
            }
        } catch (err) {
            console.error('Error reading java directory:', err);
        }
        res.json({ files: javaFiles, ...conversion.result });
    });
}

module.exports = { mount };
