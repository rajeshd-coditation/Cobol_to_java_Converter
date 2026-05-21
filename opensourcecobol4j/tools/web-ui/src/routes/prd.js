/**
 * PRD report endpoints.
 *
 *   GET /api/prd/:id       → PRD.md content + program count
 *   GET /api/prd-html/:id  → PRD.html content (full standalone HTML)
 *   GET /api/prd-data/:id  → businessRules.json (for UI diagram rendering)
 *
 * mount(app, { activeConversions })
 */

const fs = require('fs');
const path = require('path');

function mount(app, { activeConversions }) {
    app.get('/api/prd/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion || !conversion.result) {
            return res.status(404).json({ error: 'Conversion not found or not complete' });
        }
        const prdPath = path.join(conversion.result.outputDir, 'PRD.md');
        if (!fs.existsSync(prdPath)) {
            return res.status(404).json({ error: 'PRD not generated' });
        }
        try {
            const content = fs.readFileSync(prdPath, 'utf-8');
            res.json({ content, programCount: conversion.result.businessRulesData?.length || 0 });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read PRD' });
        }
    });

    app.get('/api/prd-html/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion || !conversion.result) {
            return res.status(404).json({ error: 'Conversion not found or not complete' });
        }
        const htmlPath = path.join(conversion.result.outputDir, 'PRD.html');
        if (!fs.existsSync(htmlPath)) {
            return res.status(404).json({ error: 'HTML report not generated' });
        }
        try {
            const content = fs.readFileSync(htmlPath, 'utf-8');
            res.json({ content });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read HTML report' });
        }
    });

    app.get('/api/prd-data/:id', (req, res) => {
        const conversion = activeConversions.get(req.params.id);
        if (!conversion || !conversion.result) {
            return res.status(404).json({ error: 'Conversion not found or not complete' });
        }
        const dataPath = path.join(conversion.result.outputDir, 'businessRules.json');
        if (!fs.existsSync(dataPath)) {
            const data = conversion.result.businessRulesData;
            if (!data || data.length === 0) {
                return res.status(404).json({ error: 'No business rules data available' });
            }
            return res.json({ programs: data });
        }
        try {
            const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            res.json({ programs: data });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read business rules data' });
        }
    });
}

module.exports = { mount };
