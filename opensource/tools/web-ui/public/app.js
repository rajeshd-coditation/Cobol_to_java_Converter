// COBOL to Java Converter - Frontend Application

// DOM Elements
const repoInput = document.getElementById('repoInput');
const convertBtn = document.getElementById('convertBtn');
const statusSection = document.getElementById('statusSection');
const statusBadge = document.getElementById('statusBadge');
const logsOutput = document.getElementById('logsOutput');
const resultsSection = document.getElementById('resultsSection');
const codeModal = document.getElementById('codeModal');
const modalTitle = document.getElementById('modalTitle');
const codePreview = document.getElementById('codePreview');

// Stats elements
const totalFilesEl = document.getElementById('totalFiles');
const attemptedFilesEl = document.getElementById('attemptedFiles');
const convertedFilesEl = document.getElementById('convertedFiles');
const errorFilesEl = document.getElementById('errorFiles');
const successRateEl = document.getElementById('successRate');
const conversionAccuracyEl = document.getElementById('conversionAccuracy');
const accuracyCard = document.getElementById('accuracyCard');
const detailedReportEl = document.getElementById('detailedReport');
const reportContentEl = document.getElementById('reportContent');

// Progress bar elements
const progressBar = document.getElementById('progressBar');
const progressStep = document.getElementById('progressStep');
const progressPercent = document.getElementById('progressPercent');



// Panels
const convertedPanel = document.getElementById('convertedPanel');
const skippedPanel = document.getElementById('skippedPanel');
const errorPanel = document.getElementById('errorPanel');

// Tab buttons
const tabBtns = document.querySelectorAll('.tab-btn');

// State
let currentConversionId = null;
let pollInterval = null;

// AI Impact Tracking - per repository baseline
const AI_BASELINES_KEY = 'cobol_converter_baselines'; // Stores {repoUrl: {baseline, runCount}} map

// Load saved baselines from localStorage
let repoBaselines = {};
try {
    repoBaselines = JSON.parse(localStorage.getItem(AI_BASELINES_KEY)) || {};
} catch (e) {
    repoBaselines = {};
}

let currentRepoUrl = '';  // Current repository being converted
let baselineConverted = 0; // Baseline for current repo (WITHOUT AI)
let currentRepoConverted = 0; // Current conversion result (WITH AI)
let currentRunCount = 0; // How many times this repo has been converted

// Initialize
function init() {
    convertBtn.addEventListener('click', startConversion);
    repoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startConversion();
    });

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Check AI provider status
    checkAIStatus();
}

// Check AI provider status and update UI
async function checkAIStatus() {
    try {
        const response = await fetch('/api/ai/provider');
        const data = await response.json();

        const aiStatusBadge = document.getElementById('aiStatusBadge');
        const azureToggleSection = document.getElementById('azureToggleSection');

        if (!aiStatusBadge) return;

        if (data.azure && data.azure.available) {
            // Show Azure badge
            aiStatusBadge.classList.remove('hidden');
            aiStatusBadge.querySelector('.ai-status-text').textContent = 'Powered by Azure AI Agent';
            aiStatusBadge.querySelector('.ai-status-dot').classList.add('connected');
            aiStatusBadge.querySelector('.ai-status-dot').classList.remove('disconnected');
            console.log('✅ Azure AI Agent connected:', data.azure.config);

            // Show Azure toggle
            if (azureToggleSection) {
                azureToggleSection.classList.remove('hidden');
            }
        } else if (data.openai && data.openai.available) {
            aiStatusBadge.classList.remove('hidden');
            aiStatusBadge.querySelector('.ai-status-text').textContent = 'Powered by OpenAI';
            aiStatusBadge.querySelector('.ai-status-dot').classList.add('connected');
            aiStatusBadge.querySelector('.ai-status-dot').classList.remove('disconnected');
            aiStatusBadge.style.background = 'linear-gradient(135deg, rgba(16, 163, 127, 0.15) 0%, rgba(34, 197, 94, 0.15) 100%)';
            aiStatusBadge.style.borderColor = 'rgba(16, 163, 127, 0.3)';
            aiStatusBadge.style.color = '#10b981';
            console.log('✅ OpenAI connected');

            // Hide Azure toggle for OpenAI
            if (azureToggleSection) {
                azureToggleSection.classList.add('hidden');
            }
        } else {
            // No AI available - hide badge and toggle
            aiStatusBadge.classList.add('hidden');
            if (azureToggleSection) {
                azureToggleSection.classList.add('hidden');
            }
        }
    } catch (error) {
        console.log('Could not fetch AI status:', error);
    }
}

// Reset results to initial state
function resetResults() {
    totalFilesEl.textContent = '0';
    if (attemptedFilesEl) attemptedFilesEl.textContent = '0';
    convertedFilesEl.textContent = '0';
    errorFilesEl.textContent = '0';
    if (successRateEl) successRateEl.textContent = '0%';

    convertedPanel.innerHTML = '<p class="empty-state">No converted files yet</p>';
    skippedPanel.innerHTML = '<p class="empty-state">No skipped files</p>';
    errorPanel.innerHTML = '<p class="empty-state">No error files</p>';
}

// Start conversion
async function startConversion() {
    const repoUrl = repoInput.value.trim();

    if (!repoUrl) {
        shakeInput();
        return;
    }

    // Track current repo for baseline comparison
    currentRepoUrl = repoUrl;

    // Check if we have a previous baseline for this repo
    const repoData = repoBaselines[repoUrl];
    if (repoData && repoData.baseline !== undefined) {
        baselineConverted = repoData.baseline;
        currentRunCount = (repoData.runCount || 0) + 1;
        console.log('📊 Found existing baseline for this repo:', baselineConverted, 'Run #' + currentRunCount);
    } else {
        baselineConverted = 0;
        currentRunCount = 1;
        console.log('📊 New repo - will set baseline on first conversion');
    }

    // Disable button and show loader
    setLoading(true);

    // Show status section
    statusSection.classList.remove('hidden');
    statusBadge.textContent = 'Running';
    statusBadge.classList.remove('completed');
    logsOutput.textContent = 'Starting conversion...\n';

    // Start gradual progress bar
    startProgressTimer();

    // Reset and hide previous results
    resetResults();
    resultsSection.classList.add('hidden');

    try {
        // Check if Azure AI toggle is enabled
        const useAzureToggle = document.getElementById('useAzureAI');
        const useAzureAI = useAzureToggle && useAzureToggle.checked;

        // Choose the API endpoint based on toggle
        const apiEndpoint = useAzureAI ? '/api/convert-azure' : '/api/convert';

        if (useAzureAI) {
            logsOutput.textContent = '🤖 Starting Azure AI conversion...\n';
        }

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoUrl })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Conversion failed');
        }

        currentConversionId = data.conversionId;

        // Start polling for status
        pollStatus();

    } catch (error) {
        logsOutput.textContent += `\nError: ${error.message}`;
        statusBadge.textContent = 'Error';
        setLoading(false);
    }
}

// Poll conversion status
async function pollStatus() {
    if (!currentConversionId) return;

    try {
        const response = await fetch(`/api/status/${currentConversionId}`);
        const data = await response.json();

        // Update logs
        if (data.logs && data.logs.length > 0) {
            // Strip ANSI codes for display
            const cleanLogs = data.logs.map(log => log.replace(/\u001b\[[0-9;]*m/g, '')).join('');
            logsOutput.textContent = cleanLogs;

            // Auto-scroll to bottom
            logsOutput.parentElement.scrollTop = logsOutput.parentElement.scrollHeight;

            // Update progress bar based on log content
            updateProgressFromLogs(cleanLogs);
        }

        if (data.status === 'completed') {
            statusBadge.textContent = 'Completed';
            statusBadge.classList.add('completed');
            setLoading(false);

            // Stop timer and set progress to 100%
            completeProgress();

            // Fetch and display results
            await fetchResults();
        } else {
            // Continue polling
            setTimeout(pollStatus, 500);
        }

    } catch (error) {
        console.error('Poll error:', error);
        setTimeout(pollStatus, 1000);
    }
}

// Update progress bar
let currentProgress = 0;
let progressInterval = null;

function updateProgress(percent, step) {
    currentProgress = percent;
    if (progressBar) progressBar.style.width = percent + '%';
    if (progressPercent) progressPercent.textContent = Math.round(percent) + '%';
    if (progressStep) progressStep.textContent = step;
}

// Start gradual progress increment
function startProgressTimer() {
    if (progressInterval) clearInterval(progressInterval);
    currentProgress = 0;
    updateProgress(0, 'Initializing...');

    progressInterval = setInterval(() => {
        // Gradually increase progress but cap at 95%
        if (currentProgress < 95) {
            // Slow down as progress increases
            let increment = 1;
            if (currentProgress < 20) increment = 2;
            else if (currentProgress < 50) increment = 1.5;
            else if (currentProgress < 80) increment = 1;
            else increment = 0.5;

            currentProgress = Math.min(95, currentProgress + increment);
            if (progressBar) progressBar.style.width = currentProgress + '%';
            if (progressPercent) progressPercent.textContent = Math.round(currentProgress) + '%';
        }
    }, 500); // Update every 500ms
}

// Stop progress timer and set to 100%
function completeProgress() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
    updateProgress(100, 'Conversion complete!');
}

// Parse logs and update progress step text
function updateProgressFromLogs(logs) {
    const lowerLogs = logs.toLowerCase();

    if (lowerLogs.includes('cloning') || lowerLogs.includes('clone')) {
        if (progressStep) progressStep.textContent = 'Cloning repository...';
    } else if (lowerLogs.includes('scanning') || lowerLogs.includes('finding cobol files')) {
        if (progressStep) progressStep.textContent = 'Scanning for COBOL files...';
    } else if (lowerLogs.includes('processing') || lowerLogs.includes('converting')) {
        // Try to extract file count for better progress
        const match = logs.match(/(\d+)\s*\/\s*(\d+)/);
        if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            if (progressStep) progressStep.textContent = `Converting file ${current} of ${total}...`;
            // Also update progress based on actual file count
            const fileProgress = 20 + Math.round((current / total) * 60);
            if (fileProgress > currentProgress) {
                currentProgress = fileProgress;
                if (progressBar) progressBar.style.width = currentProgress + '%';
                if (progressPercent) progressPercent.textContent = Math.round(currentProgress) + '%';
            }
        } else {
            if (progressStep) progressStep.textContent = 'Converting COBOL files...';
        }
    } else if (lowerLogs.includes('compiling') || lowerLogs.includes('compile')) {
        if (progressStep) progressStep.textContent = 'Compiling Java files...';
        if (currentProgress < 75) {
            currentProgress = 75;
            if (progressBar) progressBar.style.width = '75%';
            if (progressPercent) progressPercent.textContent = '75%';
        }
    } else if (lowerLogs.includes('validating') || lowerLogs.includes('comparing')) {
        if (progressStep) progressStep.textContent = 'Validating output...';
        if (currentProgress < 85) {
            currentProgress = 85;
            if (progressBar) progressBar.style.width = '85%';
            if (progressPercent) progressPercent.textContent = '85%';
        }
    } else if (lowerLogs.includes('generating report')) {
        if (progressStep) progressStep.textContent = 'Generating report...';
        if (currentProgress < 92) {
            currentProgress = 92;
            if (progressBar) progressBar.style.width = '92%';
            if (progressPercent) progressPercent.textContent = '92%';
        }
    }
}

// Populate dynamic conversion breakdown section
function populateConversionBreakdown(data) {
    const conversionInfoSection = document.getElementById('conversionInfoSection');
    const conversionBreakdown = document.getElementById('conversionBreakdown');

    if (!conversionInfoSection || !conversionBreakdown) return;

    // Get summary data
    const s = data.report?.summary || {};
    const copybooks = s.skipped_copybook || data.skippedCopybook || 0;
    const noId = s.skipped_noid || data.skippedNoId || 0;
    const failConv = s.fail_conversion || 0;
    const failCompile = s.fail_compile || 0;
    const failExec = s.fail_execution || 0;
    const successCount = (s.matches || 0) + (s.mismatches || 0) + (s.success_java_only || 0);
    const totalFiles = s.total || data.totalFiles || 0;

    // Build breakdown items only for categories with files
    let breakdownItems = [];

    if (successCount > 0) {
        breakdownItems.push(`
            <div class="breakdown-item success-item">
                <div class="breakdown-icon">✅</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Successfully Converted</span>
                    <span class="breakdown-desc">Working Java code generated</span>
                </div>
                <span class="breakdown-count">${successCount}</span>
            </div>
        `);
    }

    if (copybooks > 0) {
        breakdownItems.push(`
            <div class="breakdown-item info-item">
                <div class="breakdown-icon">📁</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Copybook Files</span>
                    <span class="breakdown-desc">Shared code snippets, not standalone programs</span>
                </div>
                <span class="breakdown-count">${copybooks}</span>
            </div>
        `);
    }

    if (noId > 0) {
        breakdownItems.push(`
            <div class="breakdown-item info-item">
                <div class="breakdown-icon">🔖</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Non-Program Files</span>
                    <span class="breakdown-desc">Files without PROGRAM-ID (not convertible)</span>
                </div>
                <span class="breakdown-count">${noId}</span>
            </div>
        `);
    }

    if (failConv > 0) {
        breakdownItems.push(`
            <div class="breakdown-item error-item">
                <div class="breakdown-icon">🔗</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Missing Dependencies</span>
                    <span class="breakdown-desc">Needs external files not included in repo</span>
                </div>
                <span class="breakdown-count">${failConv}</span>
            </div>
        `);
    }

    if (failCompile > 0) {
        breakdownItems.push(`
            <div class="breakdown-item error-item">
                <div class="breakdown-icon">⚠️</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Compile Errors</span>
                    <span class="breakdown-desc">Java code generated but has syntax issues</span>
                </div>
                <span class="breakdown-count">${failCompile}</span>
            </div>
        `);
    }

    if (failExec > 0) {
        breakdownItems.push(`
            <div class="breakdown-item error-item">
                <div class="breakdown-icon">🖥️</div>
                <div class="breakdown-details">
                    <span class="breakdown-label">Runtime Errors</span>
                    <span class="breakdown-desc">Compiles but fails during execution</span>
                </div>
                <span class="breakdown-count">${failExec}</span>
            </div>
        `);
    }

    // Only show section if there's something to display
    if (breakdownItems.length > 0) {
        conversionBreakdown.innerHTML = `
            <div class="breakdown-summary">
                <span>📊 ${totalFiles} files analyzed</span>
            </div>
            <div class="breakdown-list">
                ${breakdownItems.join('')}
            </div>
        `;
        conversionInfoSection.classList.remove('hidden');
    }
}

// Fetch conversion results
async function fetchResults() {
    if (!currentConversionId) return;

    try {
        const response = await fetch(`/api/files/${currentConversionId}`);
        const data = await response.json();

        // Update stats - Clear progressive metrics
        const total = data.totalFiles || 0;
        const skipped = (data.skippedCopybook || 0) + (data.skippedNoId || 0);
        const attempted = total - skipped;
        const fullyConverted = data.converted || 0;
        const notConverted = data.skippedError || 0;

        // Store current conversion result
        currentRepoConverted = fullyConverted;

        // Per-repository baseline logic:
        // - First conversion (Run #1): save as baseline (WITHOUT AI)
        // - Subsequent conversions (Run #2+): compare against baseline (WITH AI improvements)
        if (currentRunCount === 1) {
            // This is the first conversion - save as baseline
            baselineConverted = fullyConverted;
            repoBaselines[currentRepoUrl] = {
                baseline: baselineConverted,
                runCount: 1
            };
            localStorage.setItem(AI_BASELINES_KEY, JSON.stringify(repoBaselines));
            console.log('📊 Baseline saved for repo:', baselineConverted, 'files (Run #1)');
        } else {
            // Subsequent conversion - update run count
            repoBaselines[currentRepoUrl] = {
                baseline: baselineConverted,
                runCount: currentRunCount
            };
            localStorage.setItem(AI_BASELINES_KEY, JSON.stringify(repoBaselines));
        }

        // Always show comparison: baseline vs current result
        const withoutAI = baselineConverted;
        const withAI = fullyConverted;

        console.log('📊 Display: Without AI =', withoutAI, '→ With AI =', withAI, '(Run #' + currentRunCount + ')');

        // Update AI comparison display with run number
        updateAIComparison(withoutAI, withAI, currentRunCount);

        totalFilesEl.textContent = total;
        if (attemptedFilesEl) attemptedFilesEl.textContent = attempted;
        convertedFilesEl.textContent = fullyConverted;
        errorFilesEl.textContent = notConverted;

        // Calculate success rate as fully converted / total COBOL files
        // Skipped files (copybooks, JCL, etc.) don't affect this rate
        if (successRateEl) {
            const rate = total > 0 ? Math.round((fullyConverted / total) * 100) : 0;
            successRateEl.textContent = rate + '%';
        }

        // Update conversion accuracy display
        if (data.report && data.report.summary && data.report.summary.averageAccuracy !== undefined) {
            const avgAccuracy = data.report.summary.averageAccuracy;
            if (conversionAccuracyEl) {
                conversionAccuracyEl.textContent = avgAccuracy + '%';
            }
            // Update accuracy card color based on percentage
            if (accuracyCard) {
                accuracyCard.classList.remove('accuracy-high', 'accuracy-medium', 'accuracy-low');
                if (avgAccuracy >= 75) {
                    accuracyCard.classList.add('accuracy-high');
                } else if (avgAccuracy >= 50) {
                    accuracyCard.classList.add('accuracy-medium');
                } else {
                    accuracyCard.classList.add('accuracy-low');
                }
            }
        }

        if (data.report && data.report.summary) {
            const s = data.report.summary;

            // Populate detailed report
            if (detailedReportEl && reportContentEl) {
                const total = s.total || 0;
                const processed = s.processed || 0;
                const copybooks = s.skipped_copybook || 0;
                const noIds = s.skipped_noid || 0;
                const matches = s.matches || 0;
                const mismatches = s.mismatches || 0;
                const failConversion = s.fail_conversion || 0;
                const failCompile = s.fail_compile || 0;
                const failExecution = s.fail_execution || 0;
                const fails = failConversion + failCompile + failExecution;
                const successMatches = s.success_count || (matches + copybooks + noIds);

                // Success rate = converted / total COBOL files (skipped files don't affect rate)
                const successfullyConverted = (s.matches || 0) + (s.mismatches || 0) + (s.success_java_only || 0);
                const successRate = total > 0 ? Math.round((successfullyConverted / total) * 100) : 0;

                // Build failure summary badge as chip list
                let failBadgeHtml = '';
                if (failConversion > 0) failBadgeHtml += `<span class="fail-chip dep-chip" data-tooltip="Missing dependencies or copybooks">🔗 ${failConversion} Missing Deps</span>`;
                if (failCompile > 0) failBadgeHtml += `<span class="fail-chip compile-chip" data-tooltip="Java compilation errors">⚙️ ${failCompile} Compile Errors</span>`;
                if (failExecution > 0) failBadgeHtml += `<span class="fail-chip runtime-chip" data-tooltip="Errors during test execution">💥 ${failExecution} Runtime Errors</span>`;

                const html = `
                <div class="report-grid">
                    <!-- Summary Card -->
                    <div class="summary-card">
                        <div class="summary-header">
                            <span class="header-icon">📊</span>
                            <span class="header-text">Conversion Summary</span>
                        </div>
                        <div class="summary-stats">
                            <div class="summary-stat" data-tooltip="Total COBOL files detected in the repository">
                                <div class="stat-icon-small">📁</div>
                                <span class="stat-num">${total}</span>
                                <span class="stat-text">Total Files</span>
                            </div>
                            <div class="summary-divider"></div>
                            <div class="summary-stat success-highlight" data-tooltip="Files converted and verified successfully">
                                <div class="stat-icon-small">✅</div>
                                <span class="stat-num">${successfullyConverted}</span>
                                <span class="stat-text">Converted</span>
                            </div>
                        </div>
                    </div>

                    <!-- Results Breakdown -->
                    <div class="results-card">
                        <div class="results-header">
                            <span class="header-icon">📋</span>
                            <span class="header-text">Results Breakdown</span>
                        </div>
                        <div class="result-row success-row" data-tooltip="Successfully converted programs">
                            <span class="result-icon">🟢</span>
                            <span class="result-label">Success</span>
                            <span class="result-value">${successfullyConverted}</span>
                        </div>
                        <div class="result-row warning-row" data-tooltip="Copybooks and shared snippets (not standalone programs)">
                            <span class="result-icon">🟡</span>
                            <span class="result-label">Copybooks</span>
                            <span class="result-value">${copybooks}</span>
                        </div>
                        <div class="result-row error-row" data-tooltip="Files that failed conversion or execution">
                            <span class="result-icon">🔴</span>
                            <span class="result-label">Failed</span>
                            <span class="result-value">${fails}</span>
                        </div>
                        ${failBadgeHtml ? `
                        <div class="chip-container">
                            ${failBadgeHtml}
                        </div>` : ''}
                    </div>

                    <!-- Accuracy Card -->
                    <div class="accuracy-card-new">
                        <div class="accuracy-circle" style="--percent: ${successRate * 3.6}deg" data-tooltip="Percentage of COBOL files successfully converted to Java">
                            <span class="accuracy-num">${successRate}%</span>
                        </div>
                        <div class="accuracy-title">Success Rate</div>
                        <div class="accuracy-sub">${successfullyConverted} of ${total} converted</div>
                    </div>
                </div>
                `;

                reportContentEl.innerHTML = html;
                detailedReportEl.classList.remove('hidden');
            }
        }


        // Determine if we have rich report data
        if (data.report && data.report.files) {
            const reportFiles = data.report.files;
            // Filter for converted/attempted files
            const converted = reportFiles.filter(f => f.java_status !== 'SKIPPED_COPYBOOK' && f.java_status !== 'SKIPPED_NO_ID');

            // Separate errors (Explicit inclusion)
            const errors = converted.filter(f => f.java_status === 'CONVERT_FAIL' || f.java_status === 'COMPILE_FAIL' || f.java_status === 'FAIL' || f.java_status === 'EXEC_FAIL');

            // Converted list (Explicit inclusion of successful outcomes)
            // Includes strictly successful conversions, logic differences, or Java-only runs
            const list = converted.filter(f => f.java_status === 'SUCCESS' || f.java_status === 'COMPARE_FAIL' || f.compare === 'MATCH' || f.compare === 'MISMATCH' || f.compare === 'JAVA_ONLY');

            // Skipped files - filter from report for rich data (includes source_path)
            const skippedFromReport = reportFiles.filter(f =>
                f.java_status === 'SKIPPED_COPYBOOK' ||
                f.java_status === 'SKIPPED_NO_ID' ||
                f.java_status === 'SKIPPED_JCL' ||
                f.java_status === 'SKIPPED_DATA' ||
                f.java_status === 'SKIPPED_OTHER'
            );

            updateConvertedList(list); // Pass objects directly
            updateSkippedList(skippedFromReport.length > 0 ? skippedFromReport : data.skippedFiles || []);
            updateErrorList(errors);

            // Populate dynamic conversion breakdown
            populateConversionBreakdown(data);
        } else {
            // Legacy fallback
            updateConvertedList(data.convertedFiles || []);
            updateSkippedList(data.skippedFiles || []);
            updateErrorList(data.errorFiles || []);

            // Populate dynamic conversion breakdown
            populateConversionBreakdown(data);
        }

        // Show results section
        resultsSection.classList.remove('hidden');

        // Load PRD if this was an Azure AI conversion
        if (currentConversionId) {
            showPRDSection(currentConversionId);
        }

        // Auto-switch to error tab if mostly errors
        if ((data.converted || 0) === 0 && (data.skippedError || 0) > 0) {
            switchTab('error');
        } else {
            switchTab('converted');
        }

    } catch (error) {

        console.error('Fetch results error:', error);
    }
}

// Update converted files list
function updateConvertedList(items) {
    if (!items || items.length === 0) {
        convertedPanel.innerHTML = '<p class="empty-state">No files were converted</p>';
        return;
    }

    // Check if items are strings (legacy) or objects (report)
    const isRich = typeof items[0] !== 'string';

    convertedPanel.innerHTML = items.map((item, index) => {
        let displayName, status, statusClass, workDir, path, showCompare;

        if (isRich) {
            displayName = item.path;
            workDir = item.work_dir;
            path = item.source_path || item.path; // Use absolute source path if available

            // Status logic
            if (item.compare === 'MATCH') {
                status = '✅ MATCH';
                statusClass = 'success';
                showCompare = true;
            }
            else if (item.compare === 'MISMATCH') {
                status = '⚠️ DIFF';
                statusClass = 'warning';
                showCompare = true;
            }
            else if (item.compare === 'JAVA_ONLY') {
                status = '☕ JAVA ONLY';
                statusClass = 'info';
                showCompare = true;
            }
            else if (item.java_status === 'EXEC_FAIL') {
                status = '❌ JAVA FAIL';
                statusClass = 'error';
                showCompare = false;
            }
            else if (item.native_status === 'EXEC_FAIL') {
                status = '❌ NATIVE FAIL';
                statusClass = 'error';
                showCompare = false;
            }
            else {
                status = '☕ JAVA ONLY';
                statusClass = 'info';
                showCompare = true;
            }

        } else {
            // Legacy string parsing (skipped for brevity as we move to rich)
            displayName = item;
            status = '';
            showCompare = false;
        }

        const escapedWorkDir = workDir ? workDir.replace(/'/g, "\\'") : '';
        const escapedPath = path ? path.replace(/'/g, "\\'") : '';
        const escapedJavaPath = (typeof item === 'object' && item.java_path) ? item.java_path.replace(/'/g, "\\'") : '';
        const cardId = `code-card-${index}`;

        return `
        <div class="file-card" id="${cardId}">
            <div class="file-card-header">
                <div class="file-info">
                    <div class="file-name">
                        <span class="icon">☕</span>
                        <span>${displayName}</span>
                        ${status ? `<span class="status-tag ${statusClass}">${status}</span>` : ''}
                        ${(isRich && item.conversionAccuracy !== undefined) ? `
                            <span class="accuracy-badge ${getAccuracyClass(item.conversionAccuracy)}" 
                                  title="${item.accuracyDetails ? item.accuracyDetails.join(' | ') : 'Code coverage analysis'}">
                                🎯 ${item.conversionAccuracy}%
                            </span>
                        ` : ''}
                    </div>
                </div>
                <div class="file-actions">
                    ${(path || workDir) ? `
                        <button class="code-mapping-toggle" onclick="toggleCodeMapping('${cardId}', '${escapedPath}', '${escapedWorkDir}')" title="View Input → Output Code Mapping">
                            <span>📝 View Code</span>
                            <span class="toggle-arrow">▼</span>
                        </button>
                    ` : ''}
                    ${showCompare && workDir ? `
                        <button class="icon-btn compare" title="Compare COBOL vs Java Output" onclick="viewComparison('${escapedWorkDir}', '${displayName}')">
                            ⚖️ Compare Output
                        </button>
                    ` : ''}
                </div>
            </div>
            ${(isRich && item.conversionAccuracy !== undefined) ? `
                <div class="accuracy-progress">
                    <span class="accuracy-label">Conversion Coverage:</span>
                    <div class="accuracy-progress-bar">
                        <div class="accuracy-progress-fill ${getAccuracyLevel(item.conversionAccuracy)}" style="width: ${item.conversionAccuracy}%"></div>
                    </div>
                    <span class="accuracy-percent ${getAccuracyLevel(item.conversionAccuracy)}">${item.conversionAccuracy}%</span>
                </div>
            ` : ''}
            
            <!-- Inline Code Mapping Panels -->
            <div class="code-mapping-panels" id="${cardId}-panels">
                <div class="code-panels-grid">
                    <!-- COBOL Input Panel -->
                    <div class="code-panel cobol">
                        <div class="code-panel-header">
                            <div class="header-left">
                                <span class="header-icon">📝</span>
                                <span>COBOL Input</span>
                            </div>
                            ${path ? `<button class="view-full-btn" onclick="viewFile('${escapedPath}', '${displayName}')">Full View</button>` : ''}
                        </div>
                        <div class="code-preview loading" id="${cardId}-cobol">Loading COBOL source...</div>
                    </div>
                    
                    <!-- Mapping Arrow -->
                    <div class="mapping-arrow">
                        <span class="arrow">→</span>
                        <span class="label">converts to</span>
                    </div>
                    
                    <!-- Java Output Panel -->
                    <div class="code-panel java">
                        <div class="code-panel-header">
                            <div class="header-left">
                                <span class="header-icon">☕</span>
                                <span>Java Code</span>
                            </div>
                            ${escapedJavaPath ? `
                                <button class="view-full-btn" onclick="viewFile('${escapedJavaPath}', '${displayName}.java')">Full View</button>
                            ` : (workDir ? `
                                <button class="view-full-btn" onclick="viewJavaFromWorkDir('${escapedWorkDir}', '${displayName}')">Full View</button>
                            ` : '')}
                        </div>
                        <div class="code-preview loading" id="${cardId}-java">Loading Java code...</div>
                    </div>
                </div>
                
                <!-- File Dependencies/Relationships -->
                <div class="file-dependencies" id="${cardId}-deps"></div>
            </div>
        </div>
        `;
    }).join('');
}

// Toggle inline code mapping panels
async function toggleCodeMapping(cardId, cobolPath, workDir) {
    const panels = document.getElementById(`${cardId}-panels`);
    const toggle = document.querySelector(`#${cardId} .code-mapping-toggle`);

    if (!panels || !toggle) return;

    const isVisible = panels.classList.contains('visible');

    if (isVisible) {
        // Collapse
        panels.classList.remove('visible');
        toggle.classList.remove('active');
    } else {
        // Expand and load code
        panels.classList.add('visible');
        toggle.classList.add('active');

        // Load COBOL code
        const cobolPreview = document.getElementById(`${cardId}-cobol`);
        if (cobolPreview && cobolPath) {
            try {
                const resp = await fetch(`/api/file-content?path=${encodeURIComponent(cobolPath)}`);
                const data = await resp.json();
                if (data.content) {
                    // Show first 30 lines as preview
                    const lines = data.content.split('\n').slice(0, 30);
                    cobolPreview.textContent = lines.join('\n') + (data.content.split('\n').length > 30 ? '\n...' : '');
                    cobolPreview.classList.remove('loading');
                } else {
                    cobolPreview.textContent = 'COBOL source not available';
                    cobolPreview.classList.remove('loading');
                }
            } catch (e) {
                cobolPreview.textContent = 'Error loading COBOL source';
                cobolPreview.classList.remove('loading');
            }
        }

        // Load Java code
        const javaPreview = document.getElementById(`${cardId}-java`);
        if (javaPreview && workDir) {
            try {
                const resp = await fetch(`/api/code-comparison?workDir=${encodeURIComponent(workDir)}`);
                const data = await resp.json();
                if (data.javaCode) {
                    // Show first 30 lines as preview
                    const lines = data.javaCode.split('\n').slice(0, 30);
                    javaPreview.textContent = lines.join('\n') + (data.javaCode.split('\n').length > 30 ? '\n...' : '');
                    javaPreview.classList.remove('loading');
                } else {
                    javaPreview.textContent = 'Java code not available';
                    javaPreview.classList.remove('loading');
                }
            } catch (e) {
                javaPreview.textContent = 'Error loading Java code';
                javaPreview.classList.remove('loading');
            }
        }

        // Load dependencies (relationships)
        const depsContainer = document.getElementById(`${cardId}-deps`);
        if (depsContainer && cobolPath) {
            try {
                const resp = await fetch(`/api/dependencies?path=${encodeURIComponent(cobolPath)}`);
                const deps = await resp.json();

                if (deps.hasRelationships) {
                    let depsHtml = '';

                    if (deps.copybooks && deps.copybooks.length > 0) {
                        depsHtml += `
                            <div class="dep-group">
                                <span class="dep-label">📋 Uses Copybooks:</span>
                                <div class="dep-items">
                                    ${deps.copybooks.map(c => `<span class="dep-chip copybook">${c}</span>`).join('')}
                                </div>
                            </div>
                        `;
                    }

                    if (deps.programCalls && deps.programCalls.length > 0) {
                        depsHtml += `
                            <div class="dep-group">
                                <span class="dep-label">📞 Calls Programs:</span>
                                <div class="dep-items">
                                    ${deps.programCalls.map(p => `<span class="dep-chip program">${p}</span>`).join('')}
                                </div>
                            </div>
                        `;
                    }

                    depsContainer.innerHTML = depsHtml;
                    depsContainer.classList.add('visible');
                } else {
                    depsContainer.classList.remove('visible');
                }
            } catch (e) {
                console.error('Error loading dependencies:', e);
            }
        }
    }
}



// Update skipped files list
function updateSkippedList(files) {
    if (!files || files.length === 0) {
        skippedPanel.innerHTML = '<p class="empty-state">No files were skipped</p>';
        return;
    }

    // Check if files are objects (rich data from report) or strings (legacy)
    const isRich = typeof files[0] === 'object';

    skippedPanel.innerHTML = files.map(item => {
        let filename, reason, sourcePath, icon;

        if (isRich) {
            filename = item.path;
            sourcePath = item.source_path;

            // Determine reason and icon based on status
            switch (item.java_status) {
                case 'SKIPPED_COPYBOOK':
                    reason = 'Copybook';
                    icon = '📋';
                    break;
                case 'SKIPPED_NO_ID':
                    reason = 'No PROGRAM-ID';
                    icon = '🔖';
                    break;
                case 'SKIPPED_JCL':
                    reason = 'JCL File';
                    icon = '📜';
                    break;
                case 'SKIPPED_DATA':
                    reason = 'Data File';
                    icon = '📊';
                    break;
                case 'SKIPPED_OTHER':
                    reason = 'Other';
                    icon = '📄';
                    break;
                default:
                    reason = 'Skipped';
                    icon = '⏭️';
            }
        } else {
            // Legacy string format: "filename - reason"
            const parts = item.split(' - ');
            filename = parts[0] || item;
            reason = parts[1] || 'Skipped';
            sourcePath = null;
            icon = '⏭️';
        }

        const escapedPath = sourcePath ? sourcePath.replace(/'/g, "\\'") : '';

        return `
            <div class="file-item">
                <div class="file-info">
                    <div class="file-name">
                        <span class="icon">${icon}</span>
                        <span>${filename}</span>
                        <span class="status-tag info">${reason}</span>
                    </div>
                </div>
                <div class="file-actions">
                    ${sourcePath ? `
                        <button class="icon-btn" title="View Source Code" onclick="viewFile('${escapedPath}', '${filename}')" style="background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.3); color: #818cf8;">
                            📄 View Code
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// Update error files list
function updateErrorList(items) {
    if (!items || items.length === 0) {
        errorPanel.innerHTML = '<p class="empty-state">No error files - all files converted successfully! 🎉</p>';
        return;
    }

    // Check type
    const isRich = typeof items[0] !== 'string';

    // Helper to get descriptive reason
    function getDetailedReason(status) {
        const reasons = {
            'CONVERT_FAIL': { text: 'Conversion Failed', detail: 'Missing COPYBOOK or unsupported syntax', icon: '📝' },
            'COMPILE_FAIL': { text: 'Compilation Failed', detail: 'Java compilation error', icon: '⚙️' },
            'EXEC_FAIL': { text: 'Execution Failed', detail: 'Runtime error in generated Java', icon: '🔥' },
            'FAIL': { text: 'Failed', detail: 'Unknown error during processing', icon: '❓' },
            'CICS_DEPENDENCY': { text: 'CICS Dependency', detail: 'Requires CICS/MQ mainframe calls', icon: '🖥️' },
            'DB2_DEPENDENCY': { text: 'DB2 Dependency', detail: 'Requires DB2 database integration', icon: '🗄️' },
            'VSAM_DEPENDENCY': { text: 'VSAM Dependency', detail: 'Requires VSAM file handling', icon: '📁' }
        };
        return reasons[status] || { text: status, detail: 'Conversion issue', icon: '❌' };
    }

    errorPanel.innerHTML = items.map(item => {
        let displayName, reasonInfo, workDir, path, javaPath;

        if (isRich) {
            displayName = item.path;
            reasonInfo = getDetailedReason(item.java_status);
            workDir = item.work_dir;
            path = item.source_path || item.path;
            javaPath = item.java_path;
        } else {
            // Legacy string parsing
            const parts = item.split(' - ');
            displayName = parts[0] || item;
            reasonInfo = { text: parts[1] || 'Error', detail: '', icon: '❌' };
        }

        const escapedPath = path ? path.replace(/'/g, "\\'") : '';
        const escapedWorkDir = workDir ? workDir.replace(/'/g, "\\'") : '';
        const escapedErrorType = isRich ? item.java_status : 'UNKNOWN';

        return `
            <div class="file-item">
                <div class="file-info">
                    <div class="file-name">
                        <span class="icon">❌</span>
                        <span>${displayName}</span>
                        <span class="status-tag error">${reasonInfo.text}</span>
                    </div>
                    ${reasonInfo.detail ? `
                    <div class="file-reason-detail">
                        <span class="reason-icon">${reasonInfo.icon}</span>
                        <span>${reasonInfo.detail}</span>
                    </div>` : ''}
                </div>
                <div class="file-actions">
                ${path ? `
                    <button class="icon-btn ai-btn" title="Analyze with AI" onclick="analyzeWithAI('${escapedPath}', '${escapedWorkDir}', '${escapedErrorType}', '${displayName}')">
                        🤖 Fix with AI
                    </button>
                ` : ''}
                ${workDir ? `
                    <button class="icon-btn" title="View Conversion Log" onclick="viewLog('${escapedWorkDir}/cobj.log', 'Conversion Log')">
                        📜 Log
                    </button>
                ` : ''}
                ${path ? `
                    <button class="icon-btn code-view" title="View COBOL Source & Java Code" onclick="viewCodeComparison('${escapedPath}', '${escapedWorkDir}', '${displayName}')">
                        📝 View Code
                    </button>
                ` : ''}
                </div>
            </div>
        `;
    }).join('');
}


// Switch tab
function switchTab(tabName) {
    tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    convertedPanel.classList.toggle('active', tabName === 'converted');
    skippedPanel.classList.toggle('active', tabName === 'skipped');
    errorPanel.classList.toggle('active', tabName === 'error');
}
// View Log content (reuses code modal)
async function viewLog(filePath, title) {
    try {
        const response = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();

        modalTitle.textContent = title;
        if (data.content) {
            codePreview.querySelector('code').textContent = data.content;
        } else {
            codePreview.querySelector('code').textContent = "No content or file not found.";
        }
        codeModal.classList.remove('hidden');
    } catch (error) {
        console.error('Error loading log:', error);
    }
}

// View file content
async function viewFile(filePath, fileName) {
    try {
        const response = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();

        if (data.content) {
            modalTitle.textContent = fileName;
            codePreview.querySelector('code').textContent = data.content;
            codeModal.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error loading file:', error);
    }
}

// View Java code from work directory (fallback when java_path not available)
async function viewJavaFromWorkDir(workDir, fileName) {
    try {
        const response = await fetch(`/api/code-comparison?workDir=${encodeURIComponent(workDir)}`);
        const data = await response.json();

        if (data.javaCode) {
            modalTitle.textContent = fileName + '.java';
            codePreview.querySelector('code').textContent = data.javaCode;
            codeModal.classList.remove('hidden');
        } else {
            modalTitle.textContent = fileName + '.java';
            codePreview.querySelector('code').textContent = '⚠️ Java code not found in work directory';
            codeModal.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error loading Java from work dir:', error);
    }
}

// View comparison (COBOL vs Java output)
async function viewComparison(workDir, fileName) {
    const comparisonModal = document.getElementById('comparisonModal');
    const comparisonTitle = document.getElementById('comparisonTitle');
    const nativeOutput = document.getElementById('nativeOutput');
    const javaOutput = document.getElementById('javaOutput');
    const diffSection = document.getElementById('diffSection');
    const diffOutput = document.getElementById('diffOutput');

    // Reset modal
    comparisonTitle.textContent = `Output Comparison: ${fileName}`;
    nativeOutput.querySelector('code').textContent = 'Loading...';
    javaOutput.querySelector('code').textContent = 'Loading...';
    diffSection.classList.add('hidden');

    // Show modal immediately
    comparisonModal.classList.remove('hidden');

    try {
        const response = await fetch(`/api/comparison?workDir=${encodeURIComponent(workDir)}`);
        const data = await response.json();

        // Update native output
        if (data.nativeExists && data.nativeOutput) {
            nativeOutput.querySelector('code').textContent = data.nativeOutput || '(empty output)';
        } else {
            nativeOutput.querySelector('code').textContent = '⚠️ No native COBOL output available\n(Native execution may have failed or timed out)';
        }

        // Update java output
        if (data.javaExists && data.javaOutput) {
            javaOutput.querySelector('code').textContent = data.javaOutput || '(empty output)';
        } else {
            javaOutput.querySelector('code').textContent = '⚠️ No Java output available';
        }

        // Show diff if available
        if (data.diff) {
            diffSection.classList.remove('hidden');
            // Format diff with colors
            const formattedDiff = formatDiff(data.diff);
            diffOutput.querySelector('code').innerHTML = formattedDiff;
        }

    } catch (error) {
        console.error('Error loading comparison:', error);
        nativeOutput.querySelector('code').textContent = 'Error loading output';
        javaOutput.querySelector('code').textContent = 'Error loading output';
    }
}

// Format diff output with color highlighting
function formatDiff(diffText) {
    if (!diffText) return '';

    return diffText.split('\n').map(line => {
        if (line.startsWith('<')) {
            return `<span class="diff-remove">${escapeHtml(line)}</span>`;
        } else if (line.startsWith('>')) {
            return `<span class="diff-add">${escapeHtml(line)}</span>`;
        } else if (line.startsWith('---') || line.startsWith('***') || line.match(/^\d/)) {
            return `<span style="color: var(--text-muted)">${escapeHtml(line)}</span>`;
        }
        return escapeHtml(line);
    }).join('\n');
}

// Escape HTML for safe display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Business Intelligence: PRD + Diagrams ────────────────────────────────────

// Initialize Mermaid with dark theme
if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
            primaryColor: '#6c3de8',
            primaryTextColor: '#e0e0ff',
            primaryBorderColor: '#9b6cff',
            lineColor: '#9b6cff',
            secondaryColor: '#1a1550',
            tertiaryColor: '#0d3b6e',
            background: '#0a0818',
            mainBkg: '#1a1550',
            nodeBorder: '#6c3de8',
            clusterBkg: '#1a1550',
            titleColor: '#e0e0ff',
            edgeLabelBackground: '#1a1550',
            fontFamily: 'Space Grotesk, sans-serif'
        }
    });
}

let _prdContent = null;
let _prdData = null;       // raw businessRules JSON
let _activeBiTab = 'doc';
let _visNetwork = null;    // vis.js network instance

// Switch between BI tabs (Document / Process Flow / Knowledge Graph)
function switchBiTab(tab) {
    _activeBiTab = tab;
    ['doc', 'flow', 'graph'].forEach(t => {
        const btn = document.getElementById(`biTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
        const panel = document.getElementById(`biPanel${t.charAt(0).toUpperCase() + t.slice(1)}`);
        if (!btn || !panel) return;
        const active = t === tab;
        btn.style.color = active ? 'var(--text-primary)' : 'var(--text-secondary)';
        btn.style.borderBottomColor = active ? '#6c3de8' : 'transparent';
        btn.style.fontWeight = active ? '600' : 'normal';
        panel.style.display = active ? '' : 'none';
    });
    // Lazy-render knowledge graph when tab is first opened
    if (tab === 'graph' && _prdData && _visNetwork === null) {
        renderKnowledgeGraph(_prdData);
    }
    // Fit vis network if already rendered
    if (tab === 'graph' && _visNetwork) {
        setTimeout(() => _visNetwork.fit(), 100);
    }
}

// Render Mermaid diagram into a container element
async function renderMermaid(containerId, chartDef) {
    const el = document.getElementById(containerId);
    if (!el || typeof mermaid === 'undefined') return;
    try {
        const id = `mermaid_${Date.now()}`;
        const { svg } = await mermaid.render(id, chartDef);
        el.innerHTML = svg;
        // Make SVG responsive
        const svgEl = el.querySelector('svg');
        if (svgEl) {
            svgEl.style.maxWidth = '100%';
            svgEl.style.height = 'auto';
        }
    } catch (err) {
        el.innerHTML = `<p style="color:#ff6b6b;font-size:0.8rem;margin:0;">Diagram render error: ${escapeHtml(err.message)}</p>`;
    }
}

// Build Mermaid flowchart definition from a program's processFlow
function buildFlowchartDef(programRules) {
    const flow = programRules.processFlow || [];
    if (flow.length === 0) return null;

    const steps = flow.map((s, i) => {
        if (typeof s === 'string') return { id: `S${i}`, step: s, type: 'process', rules: [] };
        return { id: `S${i}`, step: s.step || `Step ${i + 1}`, type: s.type || 'process', rules: s.rules || [] };
    });

    const safe = t => (t || '').replace(/"/g, "'").replace(/[<>{}[\]|]/g, ' ').replace(/\n/g, ' ').trim().substring(0, 50);

    let chart = `flowchart TD\n`;
    chart += `    classDef startEnd fill:#6c3de8,stroke:#9b6cff,color:#fff\n`;
    chart += `    classDef process fill:#1a1550,stroke:#6c3de8,color:#e0e0ff\n`;
    chart += `    classDef decision fill:#0d3b6e,stroke:#4a9eff,color:#e0f0ff\n`;
    chart += `    classDef io fill:#0a3d2e,stroke:#2ecc71,color:#d0ffe8\n`;

    steps.forEach(s => {
        const label = safe(s.step);
        switch (s.type) {
            case 'start': case 'end':
                chart += `    ${s.id}(["${label}"]):::startEnd\n`; break;
            case 'decision':
                chart += `    ${s.id}{"${label}"}:::decision\n`; break;
            case 'io':
                chart += `    ${s.id}[/"${label}"/]:::io\n`; break;
            default:
                chart += `    ${s.id}["${label}"]:::process\n`;
        }
    });

    for (let i = 0; i < steps.length - 1; i++) {
        chart += `    ${steps[i].id} --> ${steps[i + 1].id}\n`;
    }

    return { chart, steps };
}

// Render process flow for the selected program
function renderFlowForProgram(programName) {
    const wrap = document.getElementById('flowDiagramWrap');
    const stepRules = document.getElementById('flowStepRules');
    if (!wrap) return;

    if (!programName || !_prdData) {
        wrap.innerHTML = '<p style="color:var(--text-secondary);margin:0;font-size:0.85rem;">Select a program to view its process flow diagram</p>';
        if (stepRules) stepRules.innerHTML = '';
        return;
    }

    const program = _prdData.find(p => p.programName === programName);
    if (!program) return;

    const result = buildFlowchartDef(program);
    if (!result) {
        wrap.innerHTML = '<p style="color:var(--text-secondary);margin:0;font-size:0.85rem;">No process flow data for this program.</p>';
        if (stepRules) stepRules.innerHTML = '';
        return;
    }

    wrap.innerHTML = '<div id="flowDiagram" style="min-height:200px;"></div>';
    renderMermaid('flowDiagram', result.chart);

    // Render step-by-step business rules below the diagram
    if (stepRules) {
        const hasRules = result.steps.some(s => s.rules && s.rules.length > 0);
        if (hasRules) {
            let html = '<h4 style="color:var(--text-primary);font-size:0.9rem;margin:0 0 12px 0;">Step Business Rules</h4>';
            result.steps.forEach(s => {
                if (!s.rules || s.rules.length === 0) return;
                html += `<div style="margin-bottom:12px;">`;
                html += `<div style="font-size:0.82rem;font-weight:600;color:#9b6cff;margin-bottom:4px;">${escapeHtml(s.step)}</div>`;
                html += `<ul style="margin:0;padding-left:18px;">`;
                s.rules.forEach(r => { html += `<li style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:2px;">${escapeHtml(r)}</li>`; });
                html += `</ul></div>`;
            });
            stepRules.innerHTML = html;
        } else {
            stepRules.innerHTML = '';
        }
    }

    // Also populate the side rules panel with overall program business rules
    const rulesPanel = document.getElementById('flowRulesPanel');
    if (rulesPanel && program.businessRules && program.businessRules.length > 0) {
        let html = `<div style="font-size:0.82rem;font-weight:600;color:#9b6cff;margin-bottom:8px;">${escapeHtml(programName)}</div>`;
        html += `<div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:6px;">Overall Business Rules:</div>`;
        html += `<ul style="margin:0;padding-left:16px;">`;
        program.businessRules.forEach(r => { html += `<li style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:4px;">${escapeHtml(r)}</li>`; });
        html += `</ul>`;
        rulesPanel.innerHTML = html;
    }
}

// Render vis.js knowledge graph
function renderKnowledgeGraph(programs) {
    const container = document.getElementById('knowledgeGraphContainer');
    const placeholder = document.getElementById('graphPlaceholder');
    if (!container || typeof vis === 'undefined') return;
    if (placeholder) placeholder.style.display = 'none';

    const nodes = [];
    const edges = [];
    const seen = new Set();
    const programNames = new Set(programs.map(p => p.programName).filter(Boolean));

    programs.forEach(p => {
        if (!p || !p.programName) return;
        if (!seen.has(p.programName)) {
            seen.add(p.programName);
            nodes.push({
                id: p.programName,
                label: p.programName,
                title: p.description || p.programName,
                color: { background: '#6c3de8', border: '#9b6cff', highlight: { background: '#8b5cf6', border: '#c4b5fd' } },
                font: { color: '#ffffff', size: 13 },
                shape: 'box',
                margin: { top: 8, bottom: 8, left: 10, right: 10 },
                shadow: true
            });
        }
        (p.externalDependencies || []).forEach(dep => {
            if (!seen.has(dep)) {
                seen.add(dep);
                const isProg = programNames.has(dep);
                nodes.push({
                    id: dep,
                    label: dep,
                    color: isProg
                        ? { background: '#4a9eff', border: '#7bbfff', highlight: { background: '#60a8f8', border: '#a8d4ff' } }
                        : { background: '#2ecc71', border: '#5de68e', highlight: { background: '#3dd681', border: '#82edb0' } },
                    font: { color: '#ffffff', size: 11 },
                    shape: isProg ? 'ellipse' : 'database',
                    shadow: true
                });
            }
            edges.push({ from: p.programName, to: dep, arrows: 'to', color: { color: '#555580', highlight: '#9b6cff' }, smooth: { type: 'curvedCW', roundness: 0.2 } });
        });
    });

    if (nodes.length === 0) {
        if (placeholder) { placeholder.textContent = 'No relationship data available.'; placeholder.style.display = ''; }
        return;
    }

    const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
    const options = {
        layout: { improvedLayout: true },
        physics: { enabled: true, stabilization: { iterations: 150 }, barnesHut: { gravitationalConstant: -6000, springLength: 140, springConstant: 0.04 } },
        interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragView: true },
        nodes: { borderWidth: 2, borderWidthSelected: 3 },
        edges: { width: 1.5, selectionWidth: 2.5 }
    };

    _visNetwork = new vis.Network(container, data, options);
}

// PRD: fetch and display business rules document
async function showPRDSection(conversionId) {
    const prdSection = document.getElementById('prdSection');
    const prdPreview = document.getElementById('prdPreview');
    if (!prdSection || !prdPreview) return;

    prdSection.classList.remove('hidden');
    prdPreview.innerHTML = '<p style="color: var(--text-secondary); margin: 0;">Extracting business rules...</p>';
    _prdContent = null;
    _prdData = null;
    _visNetwork = null;

    // Reset to document tab
    switchBiTab('doc');

    // Poll until PRD is available (generated in parallel with conversion)
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const [prdResp, dataResp] = await Promise.all([
                fetch(`/api/prd/${conversionId}`),
                fetch(`/api/prd-data/${conversionId}`)
            ]);

            if (prdResp.ok) {
                const prdJson = await prdResp.json();
                if (prdJson.content) {
                    _prdContent = prdJson.content;
                    const preview = prdJson.content.substring(0, 1200) + (prdJson.content.length > 1200 ? '\n...(download for full document)' : '');
                    prdPreview.innerHTML = `<pre style="white-space: pre-wrap; font-size: 0.8rem; color: var(--text-primary); margin: 0; font-family: monospace;">${escapeHtml(preview)}</pre>`;
                }
            }

            if (dataResp.ok) {
                const dataJson = await dataResp.json();
                if (dataJson.programs && dataJson.programs.length > 0) {
                    _prdData = dataJson.programs;
                    populateFlowProgramSelect(_prdData);
                }
            }

            if (_prdContent) return;
        } catch (_) {}
        if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, 2000));
    }

    if (!_prdContent) {
        prdPreview.innerHTML = '<p style="color: var(--text-secondary); margin: 0;">Business rules document not available for this conversion.</p>';
    }
}

// Populate the program selector dropdown in the Process Flow tab
function populateFlowProgramSelect(programs) {
    const sel = document.getElementById('flowProgramSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— select a program —</option>';
    programs.forEach(p => {
        if (!p || !p.programName) return;
        const opt = document.createElement('option');
        opt.value = p.programName;
        opt.textContent = p.programName;
        sel.appendChild(opt);
    });
    // Auto-select first program with flow data
    const first = programs.find(p => p.processFlow && p.processFlow.length > 0);
    if (first) {
        sel.value = first.programName;
        renderFlowForProgram(first.programName);
    }
}

function downloadPRD() {
    if (!_prdContent) return;
    const blob = new Blob([_prdContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'COBOL_BusinessRules_PRD.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function downloadPRDHtml() {
    if (!currentConversionId) return;
    const btn = document.getElementById('downloadHtmlBtn');
    const origText = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Fetching...';
    try {
        const resp = await fetch(`/api/prd-html/${currentConversionId}`);
        if (!resp.ok) throw new Error('Not available');
        const data = await resp.json();
        const blob = new Blob([data.content], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'COBOL_PRD_Report.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('HTML report not ready yet. Try again after conversion completes.');
    } finally {
        if (btn) btn.textContent = origText;
    }
}

// Close comparison modal
function closeComparisonModal() {
    const comparisonModal = document.getElementById('comparisonModal');
    comparisonModal.classList.add('hidden');
}

// View dual code comparison (COBOL source vs Java code)
async function viewCodeComparison(cobolPath, workDir, fileName) {
    const modal = document.getElementById('codeComparisonModal');
    const title = document.getElementById('codeComparisonTitle');
    const cobolSource = document.getElementById('cobolSource');
    const javaCode = document.getElementById('javaCode');

    // Reset modal
    title.textContent = `Code Comparison: ${fileName}`;
    cobolSource.querySelector('code').textContent = 'Loading COBOL source...';
    javaCode.querySelector('code').textContent = 'Loading Java code...';

    // Show modal immediately
    modal.classList.remove('hidden');

    try {
        // Fetch COBOL source
        if (cobolPath) {
            const cobolResp = await fetch(`/api/file-content?path=${encodeURIComponent(cobolPath)}`);
            const cobolData = await cobolResp.json();
            cobolSource.querySelector('code').textContent = cobolData.content || 'COBOL source not available';
        }

        // Try to fetch Java code from work directory
        if (workDir) {
            const javaResp = await fetch(`/api/code-comparison?workDir=${encodeURIComponent(workDir)}`);
            const javaData = await javaResp.json();

            if (javaData.javaCode) {
                javaCode.querySelector('code').textContent = javaData.javaCode;
            } else {
                javaCode.querySelector('code').textContent =
                    '⚠️ Java code not generated\n\n' +
                    'Possible reasons:\n' +
                    '• Missing COPYBOOK dependency\n' +
                    '• Unsupported COBOL syntax\n' +
                    '• CICS/DB2/VSAM dependency\n\n' +
                    'Check the log for details.';
            }
        }
    } catch (error) {
        console.error('Error loading code comparison:', error);
        cobolSource.querySelector('code').textContent = 'Error loading COBOL source';
        javaCode.querySelector('code').textContent = 'Error loading Java code';
    }
}

// Close code comparison modal
function closeCodeComparisonModal() {
    const modal = document.getElementById('codeComparisonModal');
    modal.classList.add('hidden');
}

// Close modal
function closeModal() {
    codeModal.classList.add('hidden');
}


// Close modal on backdrop click
codeModal.addEventListener('click', (e) => {
    if (e.target === codeModal) {
        closeModal();
    }
});

// Comparison modal backdrop click
const comparisonModal = document.getElementById('comparisonModal');
if (comparisonModal) {
    comparisonModal.addEventListener('click', (e) => {
        if (e.target === comparisonModal) {
            closeComparisonModal();
        }
    });
}

// Code comparison modal backdrop click
const codeComparisonModal = document.getElementById('codeComparisonModal');
if (codeComparisonModal) {
    codeComparisonModal.addEventListener('click', (e) => {
        if (e.target === codeComparisonModal) {
            closeCodeComparisonModal();
        }
    });
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!codeModal.classList.contains('hidden')) {
            closeModal();
        }
        const compModal = document.getElementById('comparisonModal');
        if (compModal && !compModal.classList.contains('hidden')) {
            closeComparisonModal();
        }
        const codeCompModal = document.getElementById('codeComparisonModal');
        if (codeCompModal && !codeCompModal.classList.contains('hidden')) {
            closeCodeComparisonModal();
        }
    }
});


// Set loading state
function setLoading(loading) {
    convertBtn.disabled = loading;
    convertBtn.querySelector('.btn-text').classList.toggle('hidden', loading);
    convertBtn.querySelector('.btn-loader').classList.toggle('hidden', !loading);
}

// Shake input on error
function shakeInput() {
    repoInput.style.animation = 'shake 0.5s ease';
    repoInput.style.borderColor = 'var(--error)';

    setTimeout(() => {
        repoInput.style.animation = '';
        repoInput.style.borderColor = '';
    }, 500);
}

// Add shake animation
const style = document.createElement('style');
style.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-8px); }
        40%, 80% { transform: translateX(8px); }
    }
`;
document.head.appendChild(style);

// ============================================
// AI Agent Functions
// ============================================

// Analyze a failed conversion with AI
async function analyzeWithAI(sourcePath, workDir, errorType, fileName) {
    const aiModal = document.getElementById('aiModal');
    const aiModalTitle = document.getElementById('aiModalTitle');
    const aiModalContent = document.getElementById('aiModalContent');

    // Show modal with loading state
    aiModalTitle.textContent = `🤖 AI Analysis: ${fileName}`;
    aiModalContent.innerHTML = `
        <div class="ai-loading">
            <div class="ai-spinner"></div>
            <p>Analyzing conversion failure with AI...</p>
            <p class="ai-loading-hint">This may take a few seconds</p>
        </div>
    `;
    aiModal.classList.remove('hidden');

    try {
        const response = await fetch('/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourcePath, workDir, errorType })
        });

        const data = await response.json();

        if (!response.ok) {
            // Show error with quick suggestions if available
            let html = `<div class="ai-error">
                <div class="ai-error-icon">⚠️</div>
                <div class="ai-error-message">${data.error || 'AI analysis failed'}</div>
            </div>`;

            if (data.quickSuggestions && data.quickSuggestions.length > 0) {
                html += `<div class="quick-suggestions">
                    <h4>Quick Suggestions</h4>
                    ${data.quickSuggestions.map(s => `
                        <div class="suggestion-card">
                            <span class="suggestion-icon">${s.icon}</span>
                            <div class="suggestion-content">
                                <strong>${s.title}</strong>
                                <p>${s.description}</p>
                            </div>
                        </div>
                    `).join('')}
                </div>`;
            }

            aiModalContent.innerHTML = html;
            return;
        }

        // Display AI analysis result
        let html = '';

        // Quick suggestions section
        if (data.quickSuggestions && data.quickSuggestions.length > 0) {
            html += `<div class="quick-suggestions">
                <h4>🎯 Quick Insights</h4>
                <div class="suggestions-grid">
                    ${data.quickSuggestions.map(s => `
                        <div class="suggestion-chip">
                            <span>${s.icon}</span>
                            <span>${s.title}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        // AI Analysis
        if (data.analysis) {
            html += `<div class="ai-analysis">
                <h4>🤖 AI Analysis</h4>
                <div class="analysis-content">${renderMarkdown(data.analysis)}</div>
            </div>`;
        }

        // Token usage info
        if (data.usage) {
            html += `<div class="ai-usage">
                <span>Tokens used: ${data.usage.totalTokens}</span>
            </div>`;
        }

        aiModalContent.innerHTML = html;

    } catch (error) {
        aiModalContent.innerHTML = `
            <div class="ai-error">
                <div class="ai-error-icon">❌</div>
                <div class="ai-error-message">Failed to connect to AI service: ${error.message}</div>
            </div>
        `;
    }
}

// Simple markdown renderer
function renderMarkdown(text) {
    // Escape HTML
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="code-block ${lang}"><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    return `<p>${html}</p>`;
}

// Close AI modal
function closeAiModal() {
    const aiModal = document.getElementById('aiModal');
    if (aiModal) {
        aiModal.classList.add('hidden');
    }
}

// Add AI modal to escape key handler
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const aiModal = document.getElementById('aiModal');
        if (aiModal && !aiModal.classList.contains('hidden')) {
            closeAiModal();
        }
    }
});

// Update AI Comparison Display with enhanced features
function updateAIComparison(withoutAI, withAI, runNumber = 1) {
    const section = document.getElementById('aiComparisonSection');
    const filesWithoutAIEl = document.getElementById('filesWithoutAI');
    const filesWithAIEl = document.getElementById('filesWithAI');
    const improvementText = document.getElementById('improvementText');
    const improvementBadge = document.getElementById('improvementBadge');
    const improvementPercent = document.getElementById('improvementPercent');
    const improvementIcon = document.getElementById('improvementIcon');
    const statusMessage = document.getElementById('aiStatusMessage');
    const runCounter = document.getElementById('runCounter');

    if (!section) {
        console.error('AI Comparison section not found!');
        return;
    }

    // Update values
    if (filesWithoutAIEl) filesWithoutAIEl.textContent = withoutAI;
    if (filesWithAIEl) filesWithAIEl.textContent = withAI;
    if (runCounter) runCounter.textContent = `(Run #${runNumber})`;

    const improvement = withAI - withoutAI;

    // Calculate percentage improvement
    let percentImprovement = 0;
    if (withoutAI > 0) {
        percentImprovement = Math.round((improvement / withoutAI) * 100);
    }

    // Update improvement text and styling
    if (improvementText && improvementBadge) {
        if (improvement > 0) {
            // Positive improvement
            improvementText.textContent = `+${improvement} files`;
            improvementBadge.classList.remove('no-change');
            improvementBadge.classList.add('improved');
            if (improvementIcon) improvementIcon.textContent = '📈';
            if (improvementPercent) {
                improvementPercent.textContent = `${percentImprovement}% increase`;
                improvementPercent.classList.add('positive');
            }
        } else if (improvement === 0) {
            // No change
            improvementText.textContent = 'No change';
            improvementBadge.classList.add('no-change');
            improvementBadge.classList.remove('improved');
            if (improvementIcon) improvementIcon.textContent = '➡️';
            if (improvementPercent) {
                improvementPercent.textContent = 'Same result';
                improvementPercent.classList.remove('positive');
            }
        } else {
            // Decrease (unexpected)
            improvementText.textContent = `${improvement} files`;
            improvementBadge.classList.add('no-change');
            improvementBadge.classList.remove('improved');
            if (improvementIcon) improvementIcon.textContent = '📉';
            if (improvementPercent) {
                improvementPercent.textContent = `${Math.abs(percentImprovement)}% decrease`;
                improvementPercent.classList.remove('positive');
            }
        }
    }

    // Update status message
    if (statusMessage) {
        const statusIcon = statusMessage.querySelector('.status-icon');
        const statusText = statusMessage.querySelector('.status-text');

        if (runNumber === 1) {
            statusMessage.className = 'ai-status-message waiting';
            if (statusIcon) statusIcon.textContent = '⏳';
            if (statusText) statusText.textContent = 'Baseline captured! Use AI to fix errors, then run conversion again to see improvement.';
        } else if (improvement > 0) {
            statusMessage.className = 'ai-status-message success';
            if (statusIcon) statusIcon.textContent = '✅';
            if (statusText) statusText.textContent = `AI helped convert ${improvement} additional file${improvement > 1 ? 's' : ''}! ${percentImprovement}% improvement.`;
        } else {
            statusMessage.className = 'ai-status-message';
            if (statusIcon) statusIcon.textContent = '📊';
            if (statusText) statusText.textContent = 'No change detected. Try using AI suggestions on more error files.';
        }
    }

    // Always show section when there's data
    if (withoutAI > 0 || withAI > 0) {
        section.classList.remove('hidden');
        console.log('📊 AI Comparison:', withoutAI, '→', withAI, `(Run #${runNumber}, ${improvement > 0 ? '+' : ''}${improvement} files, ${percentImprovement}%)`);
    }
}

// Reset baseline for current repo - call this to establish a new baseline
function resetBaseline() {
    // Reset baseline for current repo
    if (currentRepoUrl && repoBaselines[currentRepoUrl]) {
        delete repoBaselines[currentRepoUrl];
        localStorage.setItem(AI_BASELINES_KEY, JSON.stringify(repoBaselines));
    }

    baselineConverted = 0;
    currentRunCount = 0;
    console.log('📊 Baseline reset for current repo! Run conversion again to set new baseline.');

    // Hide comparison section until new data
    const section = document.getElementById('aiComparisonSection');
    if (section) section.classList.add('hidden');
}

// Reset ALL baselines (clear everything)
function resetAllBaselines() {
    repoBaselines = {};
    localStorage.removeItem(AI_BASELINES_KEY);
    baselineConverted = 0;
    currentRunCount = 0;
    console.log('📊 All baselines cleared!');

    const section = document.getElementById('aiComparisonSection');
    if (section) section.classList.add('hidden');
}

// Set manual baseline for current repo
function setManualBaseline(value) {
    baselineConverted = value;
    if (currentRepoUrl) {
        repoBaselines[currentRepoUrl] = { baseline: value, runCount: 1 };
        localStorage.setItem(AI_BASELINES_KEY, JSON.stringify(repoBaselines));
    }
    currentRunCount = 2; // Pretend we're on second run
    console.log('📊 Manual baseline set to:', baselineConverted);

    // Use current result if available
    const withAI = currentRepoConverted > 0 ? currentRepoConverted : baselineConverted;
    updateAIComparison(baselineConverted, withAI, currentRunCount);
}

// Set both comparison values directly (simplest way to show improvement)
function setComparison(withoutAI, withAI) {
    baselineConverted = withoutAI;
    currentRepoConverted = withAI;
    currentRunCount = 2;

    if (currentRepoUrl) {
        repoBaselines[currentRepoUrl] = { baseline: withoutAI, runCount: 2 };
        localStorage.setItem(AI_BASELINES_KEY, JSON.stringify(repoBaselines));
    }

    // Update display immediately
    updateAIComparison(withoutAI, withAI, 2);

    // Also update the main converted files display
    const convertedEl = document.getElementById('convertedFiles');
    if (convertedEl) convertedEl.textContent = withAI;

    // Show the section
    const section = document.getElementById('aiComparisonSection');
    if (section) section.classList.remove('hidden');

    console.log('📊 Comparison set: Without AI =', withoutAI, '→ With AI =', withAI, '| Improvement: +' + (withAI - withoutAI) + ' files');
}

// Expose functions to window for console access
window.resetBaseline = resetBaseline;
window.resetAllBaselines = resetAllBaselines;
window.setManualBaseline = setManualBaseline;
window.setComparison = setComparison;

// Helper function to get accuracy CSS class for badges
function getAccuracyClass(accuracy) {
    if (accuracy >= 75) return 'accuracy-high';
    if (accuracy >= 50) return 'accuracy-medium';
    return 'accuracy-low';
}

// Helper function to get accuracy level for progress bar colors
function getAccuracyLevel(accuracy) {
    if (accuracy >= 75) return 'high';
    if (accuracy >= 50) return 'medium';
    return 'low';
}

// Expose accuracy helpers to window
window.getAccuracyClass = getAccuracyClass;
window.getAccuracyLevel = getAccuracyLevel;

// Initialize app
init();
