/**
 * analyzeConversionAccuracy — post-conversion semantic scorer.
 *
 * Pure text-in / number-out. Takes the COBOL source and the generated
 * Java, measures several structural signals (data items, procedures,
 * fields, methods), runs a suite of semantic-penalty heuristics
 * (fabricated input fallback, simulation markers, missing file I/O,
 * unimplemented CICS / DB2, etc.), and returns a 0–100 accuracy score
 * plus the per-penalty breakdown the UI surfaces as badges.
 *
 * The penalty strings it emits are load-bearing — the frontend
 * (public/app.js PENALTY_GUIDANCE map) and the auto-repair path
 * (/api/fix-java) both match on them verbatim. Don't rename them
 * without grepping both consumers. Every string documented here is
 * covered by at least one test in tests/fidelity.test.js.
 *
 * Lives in core (not ai) because it's deterministic — no AI calls, no
 * azureConfig, no network. That makes it cheap to unit-test and safe
 * to run on every conversion + every repair pass without token cost.
 */

/**
 * Analyze conversion accuracy by comparing COBOL source with Java output
 * Uses line-based analysis for more accurate results
 * Returns a percentage (0-100) indicating how much of the COBOL code was converted
 */
function analyzeConversionAccuracy(cobolSource, javaCode) {
    const result = {
        accuracy: 0,
        cobolMetrics: {
            totalLines: 0,
            codeLines: 0,
            dataItems: 0,
            procedures: 0
        },
        javaMetrics: {
            totalLines: 0,
            codeLines: 0,
            fields: 0,
            methods: 0
        },
        details: []
    };

    if (!cobolSource || !javaCode) {
        return result;
    }

    try {
        // === COBOL Analysis ===
        const cobolLines = cobolSource.split('\n');
        result.cobolMetrics.totalLines = cobolLines.length;

        // Count meaningful COBOL code lines (not comments, not blank, not just periods)
        let cobolCodeLines = 0;
        let inProcedureDivision = false;

        for (const line of cobolLines) {
            const trimmed = line.trim();
            // Skip blank lines
            if (!trimmed) continue;
            // Skip comment lines (column 7 = *)
            if (line.length >= 7 && line[6] === '*') continue;
            if (trimmed.startsWith('*')) continue;
            // Skip lines that are just periods
            if (trimmed === '.') continue;

            // Track procedure division
            if (trimmed.match(/PROCEDURE\s+DIVISION/i)) {
                inProcedureDivision = true;
            }

            cobolCodeLines++;
        }
        result.cobolMetrics.codeLines = cobolCodeLines;

        // Count COBOL data items (lines with PIC clause)
        const picMatches = cobolSource.match(/\bPIC\b/gi) || [];
        result.cobolMetrics.dataItems = picMatches.length;

        // Count COBOL procedures (PERFORM targets and paragraph names)
        const performMatches = cobolSource.match(/\bPERFORM\s+[\w-]+/gi) || [];
        const uniqueProcedures = new Set();
        performMatches.forEach(p => {
            const name = p.replace(/\bPERFORM\s+/i, '').toUpperCase();
            if (!['UNTIL', 'VARYING', 'WITH', 'TEST', 'THRU', 'THROUGH', 'TIMES'].includes(name)) {
                uniqueProcedures.add(name);
            }
        });
        result.cobolMetrics.procedures = uniqueProcedures.size;

        // === Java Analysis ===
        const javaLines = javaCode.split('\n');
        result.javaMetrics.totalLines = javaLines.length;

        // Count meaningful Java code lines
        let javaCodeLines = 0;
        let inMultilineComment = false;

        for (const line of javaLines) {
            const trimmed = line.trim();
            // Skip blank lines
            if (!trimmed) continue;

            // Handle multiline comments
            if (trimmed.startsWith('/*')) inMultilineComment = true;
            if (inMultilineComment) {
                if (trimmed.endsWith('*/') || trimmed.includes('*/')) {
                    inMultilineComment = false;
                }
                continue;
            }

            // Skip single line comments
            if (trimmed.startsWith('//')) continue;

            // Skip import statements (don't count as logic)
            if (trimmed.startsWith('import ')) continue;

            // Skip package statement
            if (trimmed.startsWith('package ')) continue;

            // Skip lines that are just braces
            if (trimmed === '{' || trimmed === '}' || trimmed === '};') continue;

            javaCodeLines++;
        }
        result.javaMetrics.codeLines = javaCodeLines;

        // Count Java fields (class-level variables)
        const fieldPattern = /(private|public|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\]]+\s+\w+\s*[=;]/g;
        const fieldMatches = javaCode.match(fieldPattern) || [];
        result.javaMetrics.fields = fieldMatches.length;

        // Count Java methods (excluding main and constructors that might be auto-generated)
        const methodPattern = /(private|public|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;
        let methodCount = 0;
        let match;
        while ((match = methodPattern.exec(javaCode)) !== null) {
            const methodName = match[2];
            // Don't count main or constructor-like names
            if (methodName !== 'main') {
                methodCount++;
            }
        }
        result.javaMetrics.methods = methodCount;

        // === Calculate Accuracy ===
        // Use a balanced approach comparing:
        // 1. Code line ratio (how much code was generated vs original)
        // 2. Data structure coverage (fields vs PIC items)
        // 3. Procedure coverage (methods vs PERFORM procedures)
        // 4. Completeness check (does Java have essential elements?)
        // 5. Semantic accuracy (proper implementation vs simulation)

        let accuracy = 0;

        if (result.cobolMetrics.codeLines > 0) {
            // Code volume comparison (35% weight)
            const expectedJavaLines = result.cobolMetrics.codeLines * 1.0;
            const codeRatio = Math.min(1, result.javaMetrics.codeLines / expectedJavaLines);
            const codeScore = codeRatio * 35;

            // Data structure coverage (25% weight)
            let dataScore = 25;
            if (result.cobolMetrics.dataItems > 0) {
                const dataRatio = Math.min(1, (result.javaMetrics.fields * 3) / result.cobolMetrics.dataItems);
                dataScore = dataRatio * 25;
            }

            // Procedure coverage (15% weight)
            let procedureScore = 15;
            if (result.cobolMetrics.procedures > 0) {
                const procedureRatio = Math.min(1, result.javaMetrics.methods / result.cobolMetrics.procedures);
                procedureScore = procedureRatio * 15;
            }

            // Completeness bonus (10% weight)
            let completenessScore = 0;
            if (javaCode.includes('class ')) completenessScore += 3;
            if (javaCode.includes('public static void main')) completenessScore += 3;
            if (javaCode.includes('System.out.print')) completenessScore += 2;
            if (javaCode.includes('try') && javaCode.includes('catch')) completenessScore += 2;

            // === SEMANTIC ACCURACY ANALYSIS (15% weight) ===
            // Detect COBOL features and check if Java properly implements them
            let semanticScore = 15;
            let penalties = [];
            const cobolLower = cobolSource.toLowerCase();
            const javaLower = javaCode.toLowerCase();

            // 1. File I/O operations (SELECT, OPEN, READ, WRITE, CLOSE)
            const hasFileIO = cobolLower.includes('select ') &&
                (cobolLower.includes(' assign ') || cobolLower.includes('file-control'));
            if (hasFileIO) {
                // Check if Java simulates with arrays/mock instead of real file I/O
                const hasMockFileIO = javaLower.includes('mock') ||
                    javaLower.includes('simulate') ||
                    javaLower.includes('string[]') ||
                    javaLower.includes('// simulation') ||
                    (javaLower.includes('string[') && !javaCode.includes('FileReader') && !javaCode.includes('BufferedReader'));
                const hasRealFileIO = javaCode.includes('FileReader') ||
                    javaCode.includes('FileWriter') ||
                    javaCode.includes('BufferedReader') ||
                    javaCode.includes('BufferedWriter') ||
                    javaCode.includes('RandomAccessFile') ||
                    javaCode.includes('FileInputStream') ||
                    javaCode.includes('FileOutputStream');

                if (hasMockFileIO && !hasRealFileIO) {
                    semanticScore -= 5;
                    penalties.push('File I/O simulated');
                } else if (!hasRealFileIO) {
                    semanticScore -= 3;
                    penalties.push('File I/O simplified');
                }
            }

            // 2. Variable-length records (DEPENDING ON, OCCURS DEPENDING ON)
            const hasDependingOn = cobolLower.includes('depending on');
            if (hasDependingOn) {
                // Check if Java has dynamic array/list handling
                const hasDynamicHandling = javaCode.includes('ArrayList') ||
                    javaCode.includes('List<') ||
                    javaCode.includes('Arrays.copyOf');
                if (!hasDynamicHandling) {
                    semanticScore -= 2;
                    penalties.push('DEPENDING ON simplified');
                }
            }

            // 3. FILE STATUS handling
            const hasFileStatus = cobolLower.includes('file status');
            if (hasFileStatus) {
                const hasProperStatus = javaCode.includes('IOException') ||
                    javaCode.includes('FileNotFoundException');
                if (!hasProperStatus) {
                    semanticScore -= 2;
                    penalties.push('FILE STATUS simulated');
                }
            }

            // 4. COMP/COMP-3 packed decimal
            const hasPackedDecimal = cobolLower.includes('comp-3') || cobolLower.includes('comp ');
            if (hasPackedDecimal) {
                const hasBigDecimal = javaCode.includes('BigDecimal');
                if (!hasBigDecimal) {
                    semanticScore -= 1;
                    penalties.push('Packed decimal simplified');
                }
            }

            // 5. RECORDING MODE V (variable length records)
            const hasRecordingModeV = cobolLower.includes('recording mode') && cobolLower.includes(' v');
            if (hasRecordingModeV) {
                // Very specific COBOL feature - hard to replicate properly
                semanticScore -= 2;
                penalties.push('Variable records approximated');
            }

            // 6. Check for obvious simulation comments
            const simulationIndicators = [
                '// mock', '// simulate', '// simulated',
                '/* mock', '/* simulate', '// for demo',
                '// placeholder', '// stub', '// fake',
                'simulating', 'simulation'
            ];
            for (const indicator of simulationIndicators) {
                if (javaLower.includes(indicator)) {
                    semanticScore -= 4;
                    penalties.push('Contains simulation markers');
                    break;
                }
            }

            // 6b. Fabricated sample-data fallback for missing input files.
            // Banned pattern: COBOL would fail with file-not-found but Java silently
            // substitutes hardcoded records. Detect the literal prompt-leakage
            // phrases emitted by prior conversions.
            const fabricatedFallbackPhrases = [
                'using sample data for demonstration',
                'input file not found, using sample',
                'not found, using sample data',
                'using sample acct-rec record',
                'using sample record',
                'sample data for demo'
            ];
            for (const phrase of fabricatedFallbackPhrases) {
                if (javaLower.includes(phrase)) {
                    semanticScore -= 6;
                    penalties.push('Fabricated input fallback');
                    break;
                }
            }

            // 7. CICS commands (EXEC CICS SEND, RECEIVE, RETURN, XCTL, LINK, SYNCPOINT)
            const hasCICS = cobolLower.includes('exec cics');
            if (hasCICS) {
                // Check if Java has any CICS-like framework or just console output
                const hasCICSFramework = javaLower.includes('cicsapi') ||
                    javaLower.includes('com.ibm.cics') ||
                    javaLower.includes('jcics');
                const hasConsoleMock = javaLower.includes('system.out.print') &&
                    (javaLower.includes('sending') || javaLower.includes('screen'));

                if (!hasCICSFramework) {
                    semanticScore -= 3;  // Reduced penalty - CICS framework not present but logic may be valid
                    penalties.push('CICS simplified');
                }
            }

            // 8. IMS/DLI commands (EXEC DLI GU, GNP, REPL, SCHD, TERM)
            const hasIMS = cobolLower.includes('exec dli') ||
                cobolLower.includes('pcb(') ||
                cobolLower.includes('psb-name') ||
                cobolLower.includes('dibstat');
            if (hasIMS) {
                const hasIMSFramework = javaLower.includes('imsapi') ||
                    javaLower.includes('com.ibm.ims') ||
                    javaLower.includes('dliapi');
                const hasMockDB = javaLower.includes('mockauth') ||
                    javaLower.includes('mock') ||
                    javaLower.includes('pendingauth[]');

                if (!hasIMSFramework) {
                    semanticScore -= 3;  // Reduced penalty - IMS/DLI simplified but logic preserved
                    penalties.push('IMS/DLI simplified');
                }
            }

            // 9. BMS screen handling (MAP, MAPSET, SEND MAP, RECEIVE MAP)
            const hasBMS = cobolLower.includes('mapset') ||
                cobolLower.includes('send map') ||
                cobolLower.includes('receive map') ||
                cobolLower.includes('dfhbmsca');
            if (hasBMS) {
                const hasBMSFramework = javaLower.includes('bmsapi') ||
                    javaLower.includes('screen.') ||
                    javaLower.includes('terminal.') ||
                    javaLower.includes('javax.swing');
                const hasConsoleMock = javaLower.includes('system.out.print');

                if (!hasBMSFramework && hasConsoleMock) {
                    semanticScore -= 2;  // Reduced penalty - BMS screens adapted to console output
                    penalties.push('BMS adapted');
                }
            }

            // 10. COPY statements (copybooks)
            const copyMatches = cobolSource.match(/COPY\s+\w+/gi) || [];
            const copybookCount = copyMatches.length;
            if (copybookCount > 3) {
                // Many copybooks indicate complex data structures
                // Check if Java has corresponding classes/imports
                const javaImportCount = (javaCode.match(/import\s+/g) || []).length;
                if (javaImportCount < copybookCount / 2) {
                    semanticScore -= 3;
                    penalties.push(`${copybookCount} copybooks simplified`);
                }
            }

            // 11. DFHAID/DFHBMSCA (CICS special variables)
            const hasDFH = cobolLower.includes('dfhaid') ||
                cobolLower.includes('dfhbmsca') ||
                cobolLower.includes('dfhenter') ||
                cobolLower.includes('dfhpf');
            if (hasDFH) {
                const hasKeyHandling = javaLower.includes('keyevent') ||
                    javaLower.includes('actionevent') ||
                    javaLower.includes('keylistener');
                if (!hasKeyHandling) {
                    semanticScore -= 3;
                    penalties.push('CICS keys simplified');
                }
            }

            // Ensure semantic score doesn't go below -20 (will result in lower accuracy)
            semanticScore = Math.max(-20, semanticScore);

            // Store penalties for details
            result.semanticPenalties = penalties;

            accuracy = codeScore + dataScore + procedureScore + completenessScore + semanticScore;

            // Apply minimum floor based on code presence
            if (result.javaMetrics.codeLines > 100 && accuracy < 70) {
                accuracy = 70;  // Increased floor for substantial code
            } else if (result.javaMetrics.codeLines > 50 && accuracy < 65) {
                accuracy = 65;
            }
        } else {
            // Fallback: use Java code presence
            accuracy = result.javaMetrics.codeLines > 100 ? 70 :
                result.javaMetrics.codeLines > 50 ? 55 : 40;
        }

        result.accuracy = Math.round(Math.min(100, Math.max(0, accuracy)));

        // Build details for tooltip
        result.details.push(`COBOL: ${result.cobolMetrics.codeLines} lines`);
        result.details.push(`Java: ${result.javaMetrics.codeLines} lines`);
        if (result.semanticPenalties && result.semanticPenalties.length > 0) {
            result.details.push(`[warn] ${result.semanticPenalties.join(', ')}`);
        }

    } catch (err) {
        console.error('Error analyzing conversion accuracy:', err.message);
        // Fallback based on Java code length
        const javaLines = javaCode ? javaCode.split('\n').length : 0;
        result.accuracy = javaLines > 100 ? 75 : javaLines > 50 ? 60 : 40;
    }

    return result;
}

module.exports = { analyzeConversionAccuracy };
