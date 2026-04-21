/**
 * Turn the local cobol_repo_scanner.sh run into a frontend-friendly result.
 *
 * Preferred path: read `report.json` from outputDir. Modern scanner runs
 * always write it, and it carries per-file status + comparison info the
 * legacy log-scraping branch can't see.
 *
 * Fallback path (if report.json is missing): parse human-readable lines out
 * of the scanner's stdout. Kept for robustness on partial runs / crashes
 * where report.json never got written.
 *
 * parseScannerOutput(output, outputDir, { stripAnsi }) → result
 *   output      stdout from the scanner (used only by the fallback path)
 *   outputDir   where report.json is expected to live
 *   stripAnsi   injected ANSI-escape stripper (util/strip-ansi)
 */

const fs = require('fs');
const path = require('path');

function parseScannerOutput(output, outputDir, deps) {
    const { stripAnsi } = deps;
    const reportPath = path.join(outputDir, 'report.json');
    let report = null;

    try {
        if (fs.existsSync(reportPath)) {
            const reportData = fs.readFileSync(reportPath, 'utf-8');
            report = JSON.parse(reportData);
        }
    } catch (e) {
        console.error('Error reading report.json:', e);
    }

    const result = {
        outputDir,
        totalFiles: 0,
        converted: 0,
        skippedCopybook: 0,
        skippedNoId: 0,
        skippedError: 0,
        convertedFiles: [],
        skippedFiles: [],
        errorFiles: [],
        report
    };

    if (report && report.summary) {
        result.totalFiles = report.summary.total;
        result.converted = (report.summary.matches || 0) + (report.summary.mismatches || 0) + (report.summary.success_java_only || 0);
        result.skippedError = (report.summary.fail_conversion || 0) + (report.summary.fail_compile || 0) + (report.summary.fail_execution || 0);

        let copybooks = 0;
        let noIds = 0;

        report.files.forEach(file => {
            if (file.java_status === 'SUCCESS' || file.java_status === 'COMPARE_FAIL' || file.compare === 'MATCH' || file.compare === 'MISMATCH') {
                result.convertedFiles.push(`${file.path} [${file.compare}]`);
            } else if (file.java_status === 'SKIPPED_COPYBOOK') {
                copybooks++;
                result.skippedFiles.push(`${file.path} - Copybook`);
            } else if (file.java_status === 'SKIPPED_NO_ID') {
                noIds++;
                result.skippedFiles.push(`${file.path} - No ID DIVISION`);
            } else {
                result.errorFiles.push(`${file.path} - ${file.java_status}`);
            }
        });

        result.skippedCopybook = copybooks;
        result.skippedNoId = noIds;
    } else {
        // Legacy log-scraper fallback.
        const cleanOutput = stripAnsi(output);
        const lines = cleanOutput.split('\n');

        for (const line of lines) {
            if (line.includes('Total files scanned:')) {
                const match = line.match(/Total files scanned:\s*(\d+)/);
                if (match) result.totalFiles = parseInt(match[1]);
            }
            if (line.includes('Successfully converted:')) {
                const match = line.match(/Successfully converted:\s*(\d+)/);
                if (match) result.converted = parseInt(match[1]);
            }
            if (line.includes('Skipped (copybooks):')) {
                const match = line.match(/Skipped \(copybooks\):\s*(\d+)/);
                if (match) result.skippedCopybook = parseInt(match[1]);
            }
            if (line.includes('Skipped (no ID DIV):')) {
                const match = line.match(/Skipped \(no ID DIV\):\s*(\d+)/);
                if (match) result.skippedNoId = parseInt(match[1]);
            }
            if (line.includes('Skipped (errors):')) {
                const match = line.match(/Skipped \(errors\):\s*(\d+)/);
                if (match) result.skippedError = parseInt(match[1]);
            }

            if (line.includes('[OK]') && line.includes('Converted:')) {
                const match = line.match(/Converted:\s*(.+)$/);
                if (match) result.convertedFiles.push(match[1].trim());
            }
            if (line.includes('[SKIP]')) {
                const match = line.match(/\[SKIP\]\s*(.+)$/);
                if (match) result.skippedFiles.push(match[1].trim());
            }
            if (line.includes('[ERROR]') && !line.includes('Failed to clone repository')) {
                const match = line.match(/\[ERROR\]\s*(.+)\s-\sConversion failed/);
                if (match) {
                    result.errorFiles.push(`${match[1].trim()} - Conversion Error`);
                }
            }
        }
    }

    return result;
}

module.exports = { parseScannerOutput };
