// COBOL to Java Converter - Frontend Application
// toast, confirmDialog, promptDialog → public/js/dialogs.js (loaded first).

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

// Bundled samples are fetched from the server (portable across machines)
let availableSamples = [];
let conversionStartedAt = 0;

// Initialize
function init() {
    convertBtn.addEventListener('click', startConversion);
    repoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !convertBtn.disabled) startConversion();
    });

    // Enable Convert only when input has content and no run is in flight
    window.updateConvertEnabled = () => {
        const busy = convertBtn.dataset.busy === '1';
        const empty = repoInput.value.trim().length === 0;
        convertBtn.disabled = empty || busy;
        convertBtn.title = busy
            ? 'A conversion is already running'
            : (empty ? 'Enter a repository URL or pick a sample first' : 'Start conversion');
    };
    repoInput.addEventListener('input', window.updateConvertEnabled);
    window.updateConvertEnabled();

    // "Try sample" → fetch list, show dropdown menu
    const sampleBtn = document.getElementById('sampleBtn');
    const sampleMenu = document.getElementById('sampleMenu');
    if (sampleBtn && sampleMenu) {
        sampleBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (availableSamples.length === 0) {
                try {
                    const r = await fetch('/api/samples');
                    const d = await r.json();
                    availableSamples = d.samples || [];
                } catch { availableSamples = []; }
            }
            sampleMenu.innerHTML = availableSamples.length
                ? availableSamples.map(s =>
                    `<button class="sample-item" data-path="${escapeHtml(s.path)}">
                        <div class="sample-name">${escapeHtml(s.name)}</div>
                        <div class="sample-desc">${escapeHtml(s.description)}</div>
                    </button>`).join('')
                : '<div class="sample-empty">No bundled samples found</div>';
            sampleMenu.classList.toggle('hidden');
            sampleMenu.querySelectorAll('.sample-item').forEach(item => {
                item.addEventListener('click', () => {
                    repoInput.value = item.dataset.path;
                    sampleMenu.classList.add('hidden');
                    repoInput.focus();
                    if (window.updateConvertEnabled) window.updateConvertEnabled();
                });
            });
        });
        document.addEventListener('click', () => sampleMenu.classList.add('hidden'));
    }

    // Stop button
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) stopBtn.addEventListener('click', stopConversion);

    // HITL: show/hide glob input alongside the review-mode toggle
    const reviewToggleEl = document.getElementById('reviewModeToggle');
    const reviewGlobEl = document.getElementById('reviewGlobInput');
    if (reviewToggleEl) {
        // Debounce rapid clicks: only push the final state after 150ms of silence.
        let reviewToggleTimer = null;
        reviewToggleEl.addEventListener('change', () => {
            if (reviewGlobEl) reviewGlobEl.classList.toggle('hidden', !reviewToggleEl.checked);
            // If a conversion is in flight, push the new state to the server so it
            // applies seamlessly mid-run (drains pending reviews when turning off).
            if (reviewToggleTimer) clearTimeout(reviewToggleTimer);
            reviewToggleTimer = setTimeout(async () => {
                if (!currentConversionId) return;
                try {
                    const body = {
                        reviewMode: reviewToggleEl.checked,
                        reviewGlob: (reviewGlobEl && reviewGlobEl.value || '').trim() || null
                    };
                    await fetch(`/api/review-mode/${currentConversionId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                } catch (e) { /* non-fatal */ }
            }, 150);
        });
    }

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

        // Cache the deployment name so estimateRunCostUsd can look up
        // the right price row without another fetch. Keeps the pricing
        // table lookup honest across custom deployment names.
        if (data.azure && data.azure.config && data.azure.config.deployment) {
            window.__aiDeployment = data.azure.config.deployment;
        }
        // Populate the provider row in the settings menu.
        const providerEl = document.getElementById('settingsAiProvider');
        if (providerEl) {
            if (data.azure && data.azure.available) {
                providerEl.textContent = 'Azure • ' + (data.azure.config?.deployment || 'unknown');
                providerEl.className = 'settings-value settings-value-ok';
            } else if (data.openai && data.openai.available) {
                providerEl.textContent = 'OpenAI';
                providerEl.className = 'settings-value settings-value-ok';
            } else {
                providerEl.textContent = 'not configured';
                providerEl.className = 'settings-value settings-value-warn';
            }
        }

        const aiStatusBadge = document.getElementById('aiStatusBadge');
        const azureToggleSection = document.getElementById('azureToggleSection');

        if (!aiStatusBadge) return;

        if (data.azure && data.azure.available) {
            // Show Azure badge
            aiStatusBadge.classList.remove('hidden');
            aiStatusBadge.querySelector('.ai-status-text').textContent = 'Powered by Coditation AI';
            aiStatusBadge.querySelector('.ai-status-dot').classList.add('connected');
            aiStatusBadge.querySelector('.ai-status-dot').classList.remove('disconnected');
            console.log('[ok] Azure AI Agent connected:', data.azure.config);

            // Show Azure toggle
            if (azureToggleSection) {
                azureToggleSection.classList.remove('hidden');
            }
        } else if (data.openai && data.openai.available) {
            aiStatusBadge.classList.remove('hidden');
            aiStatusBadge.querySelector('.ai-status-text').textContent = 'Powered by Coditation AI';
            aiStatusBadge.querySelector('.ai-status-dot').classList.add('connected');
            aiStatusBadge.querySelector('.ai-status-dot').classList.remove('disconnected');
            aiStatusBadge.style.background = 'linear-gradient(135deg, rgba(16, 163, 127, 0.15) 0%, rgba(34, 197, 94, 0.15) 100%)';
            aiStatusBadge.style.borderColor = 'rgba(16, 163, 127, 0.3)';
            aiStatusBadge.style.color = '#10b981';
            console.log('[ok] OpenAI connected');

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
    // Invalidate the lazy-loaded orchestration panel so the next tab open
    // refetches against the new conversion rather than showing stale cards.
    const orchEl = document.getElementById('orchestrationPanel');
    if (orchEl) {
        delete orchEl.dataset.loaded;
        orchEl.innerHTML = '<p class="empty-state">JCL orchestration will appear here once a conversion completes. Each job card shows its steps (EXEC PGM=…) with cross-references to the converted Java classes, the DD datasets each step reads/writes, and a suggested modern orchestrator (Spring Batch / Airflow / cron).</p>';
    }
    const countEl = document.getElementById('orchestrationTabCount');
    if (countEl) countEl.classList.add('hidden');
}

// Start conversion — pre-conversion HITL: scan first, let user select files,
// then call the actual converter with the selected list.
async function startConversion() {
    const repoUrl = repoInput.value.trim();

    if (!repoUrl) {
        shakeInput();
        return;
    }

    // Step 1: scan the repo to enumerate files for selection
    setLoading(true);
    // Show a scan overlay with spinner
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `<div class="scan-overlay-card">
        <div class="scan-spinner"></div>
        <div class="scan-text">Scanning repository</div>
        <div class="scan-sub">Cloning and enumerating files…</div>
    </div>`;
    document.body.appendChild(overlay);

    try {
        const r = await fetch('/api/scan-repo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoUrl })
        });
        overlay.remove();
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Scan failed: ' + (err.error || r.status), 'error');
            setLoading(false);
            return;
        }
        const scan = await r.json();
        openPreConvertModal(scan);
        setLoading(false);
    } catch (err) {
        overlay.remove();
        toast('Scan failed: ' + err.message, 'error');
        setLoading(false);
    }
}

// Real conversion starter — invoked from the pre-convert modal "Start" button.
async function actuallyStartConversion(inputPath, selectedFiles) {
    // Track current repo for baseline comparison
    currentRepoUrl = inputPath;
    const repoUrl = inputPath; // local var for the rest of the function

    // Check if we have a previous baseline for this repo
    const repoData = repoBaselines[repoUrl];
    if (repoData && repoData.baseline !== undefined) {
        baselineConverted = repoData.baseline;
        currentRunCount = (repoData.runCount || 0) + 1;
        console.log(' Found existing baseline for this repo:', baselineConverted, 'Run #' + currentRunCount);
    } else {
        baselineConverted = 0;
        currentRunCount = 1;
        console.log(' New repo - will set baseline on first conversion');
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
            logsOutput.textContent = ' Starting AI-powered conversion...\n';
        }

        // HITL: read review-mode toggle + optional glob
        const reviewToggle = document.getElementById('reviewModeToggle');
        const reviewMode = reviewToggle && reviewToggle.checked;
        const reviewGlobEl = document.getElementById('reviewGlobInput');
        const reviewGlob = reviewMode && reviewGlobEl ? (reviewGlobEl.value || '').trim() || null : null;

        // Clear any stale UI state from a prior conversion so we don't leak
        // 'awaiting_review' / 'Ready for review' labels into the new run.
        window._filePhaseTracker = {};
        if (window.cobolGraph) {
            window.cobolGraph.fileStates = {};
            if (typeof window.cobolGraph.reset === 'function') {
                try { window.cobolGraph.reset(); } catch (e) { /* non-fatal */ }
            }
        }

        // Pick up the Parallel workers slider value from the settings cog
        // (hidden in /api/convert's request body so the worker clamps to the
        // requested concurrency). Slider defaults to 5 even if the user
        // hasn't opened the menu.
        const batchSlider = document.getElementById('batchSizeSlider');
        const batchSize = batchSlider ? parseInt(batchSlider.value, 10) : undefined;

        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoUrl, reviewMode, reviewGlob, selectedFiles, batchSize })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Conversion failed');
        }

        currentConversionId = data.conversionId;
        conversionStartedAt = Date.now();
        // Bookmark URL — update the path to /c/<id> so a browser refresh
        // preserves this conversion. history.replaceState avoids cluttering
        // the back-button history with a new entry per conversion.
        try {
            window.history.replaceState({}, '', '/c/' + encodeURIComponent(data.conversionId));
        } catch {}

        // Mark Convert busy / enable Stop
        convertBtn.dataset.busy = '1';
        if (window.updateConvertEnabled) window.updateConvertEnabled();
        const stopBtn = document.getElementById('stopBtn');
        if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.title = 'Cancel the current conversion';
        }
        document.getElementById('kpiBar').classList.add('hidden');

        // Reset browser + risks state for new run
        browserLoaded = false;
        const browserSection = document.getElementById('browserSection');
        if (browserSection) browserSection.classList.add('hidden');
        const risksPanelEl = document.getElementById('risksPanel');
        if (risksPanelEl) risksPanelEl.classList.add('hidden');

        // Kick off the live dependency graph view
        const liveCountsEl = document.getElementById('liveCounts');
        if (liveCountsEl) liveCountsEl.classList.remove('hidden');

        if (window.cobolGraph) {
            window.cobolGraph.destroy();
            window.cobolGraph.load(currentConversionId, {
                onNodeClick: (nodeData) => {
                    // Determine current state from latest graph poll data
                    const node = window.cobolGraph._cy && window.cobolGraph._cy.getElementById(nodeData.id);
                    const isAwaiting = node && node.length && node.hasClass('awaiting_review');
                    if (isAwaiting) {
                        openReviewModal(nodeData.id, nodeData.label);
                        return;
                    }
                    // Instead of a modal + right-panel combo, drive the
                    // Results Browser directly: scroll to it, select the
                    // clicked file in the tree (populates COBOL + Java
                    // panes + accuracy banner + Fix-with-AI button), and
                    // open the per-file timeline alongside it. One coherent
                    // full-width view instead of stacked overlays.
                    if (typeof showFileInBrowser === 'function') {
                        showFileInBrowser(nodeData.id, nodeData.label);
                    }
                },
                onStateUpdate: (counts) => {
                    const set = (id, val) => {
                        const el = document.getElementById(id);
                        if (el) el.textContent = val;
                    };
                    set('liveTotal', counts.total);
                    set('liveDone', counts.done);
                    set('liveActive', counts.active);
                    set('liveFailed', counts.failed);
                    set('liveSkipped', counts.skipped);
                    set('liveAwaiting', counts.awaiting_review || 0);
                    // Show/hide bulk-action buttons based on queue depth
                    const bulkEl = document.getElementById('bulkReviewActions');
                    if (bulkEl) bulkEl.classList.toggle('hidden', !counts.awaiting_review);
                    // Show "click amber nodes to review" hint when something is waiting
                    const canvas = document.getElementById('graphCanvas');
                    if (canvas) canvas.classList.toggle('has-awaiting', (counts.awaiting_review || 0) > 0);
                }
            });

            // Start polling review history (cheap, every 2s)
            startReviewHistoryPoll();
        }

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
            const cleanLogs = data.logs
                .map(log => log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, ''))
                .map(whiteLabel)
                .join('');
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
                <div class="breakdown-icon">[ok]</div>
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
                <div class="breakdown-icon"></div>
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
                <div class="breakdown-icon"></div>
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
                <div class="breakdown-icon"></div>
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
                <div class="breakdown-icon">[warn]</div>
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
                <div class="breakdown-icon"></div>
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
                <span> ${totalFiles} files analyzed</span>
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
            console.log(' Baseline saved for repo:', baselineConverted, 'files (Run #1)');
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

        console.log(' Display: Without AI =', withoutAI, '→ With AI =', withAI, '(Run #' + currentRunCount + ')');

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
                if (failConversion > 0) failBadgeHtml += `<span class="fail-chip dep-chip" data-tooltip="Missing dependencies or copybooks"> ${failConversion} Missing Deps</span>`;
                if (failCompile > 0) failBadgeHtml += `<span class="fail-chip compile-chip" data-tooltip="Java compilation errors"> ${failCompile} Compile Errors</span>`;
                if (failExecution > 0) failBadgeHtml += `<span class="fail-chip runtime-chip" data-tooltip="Errors during test execution"> ${failExecution} Runtime Errors</span>`;

                const html = `
                <div class="report-grid">
                    <!-- Summary Card -->
                    <div class="summary-card">
                        <div class="summary-header">
                            <span class="header-icon"></span>
                            <span class="header-text">Conversion Summary</span>
                        </div>
                        <div class="summary-stats">
                            <div class="summary-stat" data-tooltip="Total COBOL files detected in the repository">
                                <div class="stat-icon-small"></div>
                                <span class="stat-num">${total}</span>
                                <span class="stat-text">Total Files</span>
                            </div>
                            <div class="summary-divider"></div>
                            <div class="summary-stat success-highlight" data-tooltip="Files converted and verified successfully">
                                <div class="stat-icon-small">[ok]</div>
                                <span class="stat-num">${successfullyConverted}</span>
                                <span class="stat-text">Converted</span>
                            </div>
                        </div>
                    </div>

                    <!-- Results Breakdown -->
                    <div class="results-card">
                        <div class="results-header">
                            <span class="header-icon"></span>
                            <span class="header-text">Results Breakdown</span>
                        </div>
                        <div class="result-row success-row" data-tooltip="Successfully converted programs">
                            <span class="result-icon"></span>
                            <span class="result-label">Success</span>
                            <span class="result-value">${successfullyConverted}</span>
                        </div>
                        <div class="result-row warning-row" data-tooltip="Copybooks and shared snippets (not standalone programs)">
                            <span class="result-icon"></span>
                            <span class="result-label">Copybooks</span>
                            <span class="result-value">${copybooks}</span>
                        </div>
                        <div class="result-row error-row" data-tooltip="Files that failed conversion or execution">
                            <span class="result-icon"></span>
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
            // Filter for converted/attempted files — exclude files skipped
            // before the AI ever saw them (copybooks, no-ID, JCL, too-large).
            const SKIPPED_STATUSES = new Set([
                'SKIPPED_COPYBOOK', 'SKIPPED_NO_ID', 'SKIPPED_JCL',
                'SKIPPED_DATA', 'SKIPPED_OTHER', 'SKIPPED_TOO_LARGE',
                'SKIPPED_BUDGET', 'SKIPPED_INCOMPLETE_SOURCE'
            ]);
            const converted = reportFiles.filter(f => !SKIPPED_STATUSES.has(f.java_status));

            // Separate errors (Explicit inclusion)
            const errors = converted.filter(f => f.java_status === 'CONVERT_FAIL' || f.java_status === 'COMPILE_FAIL' || f.java_status === 'FAIL' || f.java_status === 'EXEC_FAIL');

            // Converted list (Explicit inclusion of successful outcomes)
            // Includes strictly successful conversions, logic differences, or Java-only runs
            const list = converted.filter(f => f.java_status === 'SUCCESS' || f.java_status === 'COMPARE_FAIL' || f.compare === 'MATCH' || f.compare === 'MISMATCH' || f.compare === 'JAVA_ONLY');

            // Skipped files - filter from report for rich data (includes source_path)
            const skippedFromReport = reportFiles.filter(f => SKIPPED_STATUSES.has(f.java_status));

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
                status = '[ok] MATCH';
                statusClass = 'success';
                showCompare = true;
            }
            else if (item.compare === 'MISMATCH') {
                status = '[warn] DIFF';
                statusClass = 'warning';
                showCompare = true;
            }
            else if (item.compare === 'JAVA_ONLY') {
                status = ' JAVA ONLY';
                statusClass = 'info';
                showCompare = true;
            }
            else if (item.java_status === 'EXEC_FAIL') {
                status = '[error] JAVA FAIL';
                statusClass = 'error';
                showCompare = false;
            }
            else if (item.native_status === 'EXEC_FAIL') {
                status = '[error] NATIVE FAIL';
                statusClass = 'error';
                showCompare = false;
            }
            else {
                status = ' JAVA ONLY';
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
                        <span class="icon"></span>
                        <span>${displayName}</span>
                        ${status ? `<span class="status-tag ${statusClass}">${status}</span>` : ''}
                        ${(isRich && item.conversionAccuracy !== undefined) ? `
                            <span class="accuracy-badge ${getAccuracyClass(item.conversionAccuracy)}" 
                                  title="${item.accuracyDetails ? item.accuracyDetails.join(' | ') : 'Code coverage analysis'}">
                                 ${item.conversionAccuracy}%
                            </span>
                        ` : ''}
                    </div>
                </div>
                <div class="file-actions">
                    ${(path || workDir) ? `
                        <button class="code-mapping-toggle" onclick="toggleCodeMapping('${cardId}', '${escapedPath}', '${escapedWorkDir}')" title="View Input → Output Code Mapping">
                            <span> View Code</span>
                            <span class="toggle-arrow"></span>
                        </button>
                    ` : ''}
                    ${showCompare && workDir ? `
                        <button class="icon-btn compare" title="Compare COBOL vs Java Output" onclick="viewComparison('${escapedWorkDir}', '${displayName}')">
                             Compare Output
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
                                <span class="header-icon"></span>
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
                                <span class="header-icon"></span>
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
                                <span class="dep-label"> Uses Copybooks:</span>
                                <div class="dep-items">
                                    ${deps.copybooks.map(c => `<span class="dep-chip copybook">${c}</span>`).join('')}
                                </div>
                            </div>
                        `;
                    }

                    if (deps.programCalls && deps.programCalls.length > 0) {
                        depsHtml += `
                            <div class="dep-group">
                                <span class="dep-label"> Calls Programs:</span>
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
                    icon = '';
                    break;
                case 'SKIPPED_NO_ID':
                    reason = 'No PROGRAM-ID';
                    icon = '';
                    break;
                case 'SKIPPED_JCL':
                    reason = 'JCL File';
                    icon = '';
                    break;
                case 'SKIPPED_DATA':
                    reason = 'Data File';
                    icon = '';
                    break;
                case 'SKIPPED_OTHER':
                    reason = 'Other';
                    icon = '';
                    break;
                case 'SKIPPED_TOO_LARGE':
                    reason = 'Too Large';
                    icon = '';
                    break;
                case 'SKIPPED_BUDGET':
                    reason = 'Budget Hit';
                    icon = '';
                    break;
                case 'SKIPPED_INCOMPLETE_SOURCE':
                    reason = 'Truncated Source';
                    icon = '';
                    break;
                default:
                    reason = 'Skipped';
                    icon = 'skipped';
            }
        } else {
            // Legacy string format: "filename - reason"
            const parts = item.split(' - ');
            filename = parts[0] || item;
            reason = parts[1] || 'Skipped';
            sourcePath = null;
            icon = 'skipped';
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
                             View Code
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
        errorPanel.innerHTML = '<p class="empty-state">No error files - all files converted successfully! </p>';
        return;
    }

    // Check type
    const isRich = typeof items[0] !== 'string';

    // Helper to get descriptive reason
    function getDetailedReason(status) {
        const reasons = {
            'CONVERT_FAIL': { text: 'Conversion Failed', detail: 'Missing COPYBOOK or unsupported syntax', icon: '' },
            'COMPILE_FAIL': { text: 'Compilation Failed', detail: 'Java compilation error', icon: '' },
            'EXEC_FAIL': { text: 'Execution Failed', detail: 'Runtime error in generated Java', icon: '' },
            'FAIL': { text: 'Failed', detail: 'Unknown error during processing', icon: '?' },
            'SKIPPED_TOO_LARGE': { text: 'Too Large', detail: 'Source exceeds single-pass size cap (~80KB)', icon: '' },
            'SKIPPED_BUDGET':    { text: 'Budget Hit', detail: 'Conversion stopped — token ceiling reached', icon: '' },
            'SKIPPED_INCOMPLETE_SOURCE': { text: 'Truncated Source', detail: 'Source looks incomplete — no STOP RUN / END PROGRAM / GOBACK near the end, and the last statement has no terminating period', icon: '' },
            'CICS_DEPENDENCY': { text: 'CICS Dependency', detail: 'Requires CICS/MQ mainframe calls', icon: '' },
            'DB2_DEPENDENCY': { text: 'DB2 Dependency', detail: 'Requires DB2 database integration', icon: '' },
            'VSAM_DEPENDENCY': { text: 'VSAM Dependency', detail: 'Requires VSAM file handling', icon: '' }
        };
        return reasons[status] || { text: status, detail: 'Conversion issue', icon: '[error]' };
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
            reasonInfo = { text: parts[1] || 'Error', detail: '', icon: '[error]' };
        }

        const escapedPath = path ? path.replace(/'/g, "\\'") : '';
        const escapedWorkDir = workDir ? workDir.replace(/'/g, "\\'") : '';
        const escapedErrorType = isRich ? item.java_status : 'UNKNOWN';

        return `
            <div class="file-item">
                <div class="file-info">
                    <div class="file-name">
                        <span class="icon">[error]</span>
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
                         Fix with AI
                    </button>
                ` : ''}
                ${workDir ? `
                    <button class="icon-btn" title="View Conversion Log" onclick="viewLog('${escapedWorkDir}/cobj.log', 'Conversion Log')">
                         Log
                    </button>
                ` : ''}
                ${path ? `
                    <button class="icon-btn code-view" title="View COBOL Source & Java Code" onclick="viewCodeComparison('${escapedPath}', '${escapedWorkDir}', '${displayName}')">
                         View Code
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
    const orchEl = document.getElementById('orchestrationPanel');
    if (orchEl) orchEl.classList.toggle('active', tabName === 'orchestration');
    // Lazy-load the orchestration panel — we don't fetch JCL analysis until
    // the tab is actually opened to avoid hammering the server on every
    // conversion result. Cached via panel's data attribute.
    if (tabName === 'orchestration' && orchEl && !orchEl.dataset.loaded) {
        loadOrchestrationPanel();
    }
}

/**
 * Fetch + render every JCL file's parsed analysis under the Orchestration
 * tab. For each JCL file in the current conversion's report (status
 * SKIPPED_JCL), hit /api/jcl-analysis — the server parses the JCL and
 * cross-references PGM= entries against our converted Java classes,
 * returning a `coverage` array and a target-orchestrator recommendation.
 *
 * The UI renders one expandable card per JCL file, each showing:
 *   - Job name
 *   - Each step's PGM= with a ✓ / ✗ against our converted Java (linked
 *     to the Results Browser when we have a match)
 *   - DD list with DSN targets
 *   - Server's recommendation for a modern orchestrator
 *
 * Async loop runs requests in parallel (Promise.all) because each
 * /api/jcl-analysis call is cheap (pure-parse, no AI).
 */
async function loadOrchestrationPanel() {
    const panel = document.getElementById('orchestrationPanel');
    if (!panel || !currentConversionId) return;
    panel.dataset.loaded = '1'; // lock so we don't double-fetch on tab re-open
    panel.innerHTML = '<p class="empty-state">Loading JCL analysis…</p>';

    let browser;
    try {
        browser = await (await fetch(`/api/browser/${currentConversionId}`)).json();
    } catch {
        panel.innerHTML = '<p class="empty-state">Could not load the conversion report.</p>';
        return;
    }
    const jclFiles = (browser.files || []).filter(f => f.status === 'SKIPPED_JCL');
    const countEl = document.getElementById('orchestrationTabCount');
    if (countEl) {
        if (jclFiles.length > 0) {
            countEl.textContent = jclFiles.length;
            countEl.classList.remove('hidden');
        } else {
            countEl.classList.add('hidden');
        }
    }
    if (jclFiles.length === 0) {
        // Generic empty-state — not every converted repo ships JCL.
        // Non-mainframe COBOL repos, course repos, and standalone
        // utilities typically don't; that's fine, there's nothing to show.
        panel.innerHTML = '<p class="empty-state">No JCL files were found in this conversion. If the converted repo is a mainframe project, check that .jcl / .proc files are present under the selected path — they\'re what populates this tab.</p>';
        return;
    }

    const analyses = await Promise.all(jclFiles.map(async f => {
        try {
            const src = f.cobolSourcePath || f.cobolPath;
            const url = `/api/jcl-analysis?conversionId=${encodeURIComponent(currentConversionId)}&path=${encodeURIComponent(src)}`;
            const r = await fetch(url);
            if (!r.ok) return { file: f, error: 'Parse failed: HTTP ' + r.status };
            const data = await r.json();
            return { file: f, data };
        } catch (err) {
            return { file: f, error: err.message };
        }
    }));

    panel.innerHTML = analyses.map(({ file, data, error }) => {
        const name = (file.cobolPath || '').split('/').pop();
        if (error) {
            return `<div class="orch-card"><div class="orch-card-head"><span class="orch-name">${escapeHtml(name)}</span></div><div class="orch-err">${escapeHtml(error)}</div></div>`;
        }
        const parsed = data && data.parsed;
        const steps = (parsed && parsed.steps) || [];
        const coverage = data && data.coverage || [];
        const covMap = {};
        for (const c of coverage) covMap[c.program] = c;
        const rec = (data && data.recommendation) || '';
        const jobName = (parsed && parsed.jobName) || '(no JOB card)';
        const libs = (parsed && parsed.libraries) || [];

        const stepsHtml = steps.map(s => {
            const pgm = s.exec && s.exec.pgm;
            const proc = s.exec && s.exec.proc;
            const cov = pgm ? covMap[pgm] : null;
            let badge;
            if (!pgm && proc) {
                badge = `<span class="orch-badge orch-badge-proc">PROC ${escapeHtml(proc)}</span>`;
            } else if (cov && cov.converted) {
                badge = `<span class="orch-badge orch-badge-ok">✓ ${escapeHtml(cov.javaClass || pgm)}</span>`;
            } else if (cov && cov.status && cov.status !== 'NOT_IN_CONVERSION') {
                badge = `<span class="orch-badge orch-badge-warn" title="${escapeHtml(cov.status)}">${escapeHtml(pgm)} · ${escapeHtml(cov.status)}</span>`;
            } else {
                badge = `<span class="orch-badge orch-badge-miss" title="Not in this conversion">${escapeHtml(pgm || '(unknown)')}</span>`;
            }
            const dds = (s.dds || []).slice(0, 8).map(dd =>
                `<span class="orch-dd" title="${dd.dsn ? escapeHtml(dd.dsn) : ''}">${escapeHtml(dd.name)}${dd.sysout ? ' (SYSOUT)' : ''}</span>`
            ).join('');
            const extraDds = (s.dds || []).length > 8 ? `<span class="orch-dd orch-dd-more">+${(s.dds || []).length - 8} more</span>` : '';
            return `
                <div class="orch-step">
                    <div class="orch-step-head">
                        <span class="orch-step-name">${escapeHtml(s.name || '(step)')}</span>
                        ${badge}
                    </div>
                    ${dds || extraDds ? `<div class="orch-dds">${dds}${extraDds}</div>` : ''}
                </div>`;
        }).join('');

        // Libraries (STEPLIB / JOBLIB DSNs) — DB2 plans, bound DBRMs, and
        // linker-output objects live here. Surfaced so users converting
        // DB2-bound programs can see what the mainframe runtime expected.
        const libsHtml = libs.length > 0
            ? `<div class="orch-libs"><div class="orch-libs-label">Load libraries (STEPLIB / JOBLIB):</div>` +
              libs.slice(0, 12).map(l => `<span class="orch-lib">${escapeHtml(l)}</span>`).join('') +
              (libs.length > 12 ? `<span class="orch-lib orch-dd-more">+${libs.length - 12} more</span>` : '') +
              `</div>`
            : '';

        return `
            <details class="orch-card" open>
                <summary class="orch-card-head">
                    <span class="orch-name">${escapeHtml(name)}</span>
                    <span class="orch-job">${escapeHtml(jobName)}</span>
                    <span class="orch-step-count">${steps.length} step${steps.length === 1 ? '' : 's'}</span>
                </summary>
                ${stepsHtml || '<p class="empty-state">No EXEC steps parsed.</p>'}
                ${libsHtml}
                ${rec ? `<div class="orch-recommendation"><strong>Suggested orchestrator:</strong> ${escapeHtml(rec)}</div>` : ''}
            </details>`;
    }).join('');
}
window.loadOrchestrationPanel = loadOrchestrationPanel;
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
            codePreview.querySelector('code').textContent = '[warn] Java code not found in work directory';
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
            nativeOutput.querySelector('code').textContent = '[warn] No native COBOL output available\n(Native execution may have failed or timed out)';
        }

        // Update java output
        if (data.javaExists && data.javaOutput) {
            javaOutput.querySelector('code').textContent = data.javaOutput || '(empty output)';
        } else {
            javaOutput.querySelector('code').textContent = '[warn] No Java output available';
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
// formatDiff, escapeHtml → public/js/helpers.js

// Close comparison modal
function closeComparisonModal() {
    const comparisonModal = document.getElementById('comparisonModal');
    comparisonModal.classList.add('hidden');
}

// Render the accuracy panel as a first-class UI element above a Java code pane.
// Used by the Results browser (not the modal) to keep Java source clean.
// PENALTY_GUIDANCE, renderAccuracyPanel, buildAccuracyBanner → public/js/accuracy-panel.js
// Loaded before app.js in index.html; functions + constants are globals.

// View dual code comparison (COBOL source vs Java code)
// Overloaded call shapes (to stay back-compatible):
//   (cobolPath, workDir, fileName)        -- original form from result table
//   (cobolPath, fileName)                 -- from graph click (workDir inferred server-side)
//   (cobolPath, fileName, relativePath)   -- preferred form from graph click
async function viewCodeComparison(cobolPath, arg2, arg3) {
    // Resolve args. If arg2 looks like a filesystem path (contains a separator),
    // treat it as workDir (original call shape). Otherwise it's the fileName.
    let workDir = null, fileName = null, relativePath = null;
    if (arg2 && (arg2.includes('/') || arg2.includes('\\')) && !arg2.endsWith('.cobol') && !arg2.endsWith('.cbl') && !arg2.endsWith('.cpy')) {
        workDir = arg2;
        fileName = arg3;
    } else {
        fileName = arg2;
        relativePath = arg3 || null;
    }
    // Derive fileName from path if still missing
    if (!fileName && cobolPath) {
        fileName = cobolPath.split(/[\\/]/).pop();
    }
    if (!fileName) fileName = 'file';

    const modal = document.getElementById('codeComparisonModal');
    const title = document.getElementById('codeComparisonTitle');
    const cobolSource = document.getElementById('cobolSource');
    const javaCode = document.getElementById('javaCode');

    title.textContent = `Code Comparison: ${fileName}`;
    cobolSource.querySelector('code').textContent = 'Loading COBOL source...';
    javaCode.querySelector('code').textContent = 'Loading Java code...';
    modal.classList.remove('hidden');

    try {
        // Fetch COBOL source
        if (cobolPath) {
            const cobolResp = await fetch(`/api/file-content?path=${encodeURIComponent(cobolPath)}`);
            const cobolData = await cobolResp.json();
            cobolSource.querySelector('code').textContent = cobolData.content || 'COBOL source not available';
        }

        // Build query with conversion context so server can report the real reason.
        const qs = new URLSearchParams();
        if (workDir) qs.set('workDir', workDir);
        if (currentConversionId) qs.set('conversionId', currentConversionId);
        if (relativePath) qs.set('relativePath', relativePath);

        const javaResp = await fetch(`/api/code-comparison?${qs.toString()}`);
        let javaData = await javaResp.json();

        // Fallback A: if the code-comparison endpoint didn't return javaCode
        // (stale conversionId, server restarted and lost in-memory state, etc.)
        // but we CAN infer the java file path, read it directly from disk via
        // /api/file-content. Previously this path returned "Java not generated"
        // even when the .java file existed — because the modal trusted the
        // API's "no entry found" over the file system.
        if (!javaData.javaCode && currentBrowserFile && currentBrowserFile.javaPath) {
            try {
                const r2 = await fetch(`/api/file-content?path=${encodeURIComponent(currentBrowserFile.javaPath)}`);
                const d2 = await r2.json();
                if (d2 && d2.content) {
                    javaData = Object.assign({}, javaData, {
                        javaCode: d2.content,
                        javaExists: true,
                        javaStatus: javaData.javaStatus || currentBrowserFile.status || 'SUCCESS',
                        reason: javaData.reason || 'Java source loaded directly from disk (conversion state not in memory).'
                    });
                }
            } catch (e) { /* fall through to whatever we have */ }
        }

        // Fallback B: infer java path from cobolPath convention
        // (<outputDir>/java/<PascalCase>.java). Only if we still have nothing.
        if (!javaData.javaCode && cobolPath) {
            const base = (cobolPath.split(/[\\/]/).pop() || '').replace(/\.(cobol|cbl|cob)$/i, '');
            const pascal = base.replace(/[-_]/g, ' ').split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
            const guess = typeof window.lastOutputDir === 'string' ? `${window.lastOutputDir}/java/${pascal}.java` : null;
            if (guess) {
                try {
                    const r3 = await fetch(`/api/file-content?path=${encodeURIComponent(guess)}`);
                    const d3 = await r3.json();
                    if (d3 && d3.content) {
                        javaData = Object.assign({}, javaData, {
                            javaCode: d3.content,
                            javaExists: true,
                            javaStatus: javaData.javaStatus || 'SUCCESS',
                            reason: 'Java source loaded directly from disk (via inferred path).'
                        });
                    }
                } catch (e) { /* fall through */ }
            }
        }

        if (javaData.javaCode) {
            // Render the accuracy panel as a UI element above the Java pane
            // (the code itself stays clean and copyable).
            const javaPane = javaCode.closest('.comparison-pane');
            if (javaPane) {
                javaPane.querySelectorAll('.accuracy-panel').forEach(n => n.remove());
                renderAccuracyPanel(javaPane, javaData);
            }
            javaCode.querySelector('code').textContent = javaData.javaCode;
        } else {
            javaCode.querySelector('code').textContent = buildStatusExplanation(javaData);
        }
    } catch (error) {
        console.error('Error loading code comparison:', error);
        cobolSource.querySelector('code').textContent = 'Error loading COBOL source';
        javaCode.querySelector('code').textContent = `Error loading Java code: ${error.message || error}`;
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
    aiModalTitle.textContent = ` AI Analysis: ${fileName}`;
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
                <div class="ai-error-icon">[warn]</div>
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
                <h4> Quick Insights</h4>
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
                <h4> AI Analysis</h4>
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
                <div class="ai-error-icon">[error]</div>
                <div class="ai-error-message">Failed to connect to AI service: ${error.message}</div>
            </div>
        `;
    }
}

// renderMarkdown → public/js/helpers.js

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
            if (improvementIcon) improvementIcon.textContent = '';
            if (improvementPercent) {
                improvementPercent.textContent = `${percentImprovement}% increase`;
                improvementPercent.classList.add('positive');
            }
        } else if (improvement === 0) {
            // No change
            improvementText.textContent = 'No change';
            improvementBadge.classList.add('no-change');
            improvementBadge.classList.remove('improved');
            if (improvementIcon) improvementIcon.textContent = '->';
            if (improvementPercent) {
                improvementPercent.textContent = 'Same result';
                improvementPercent.classList.remove('positive');
            }
        } else {
            // Decrease (unexpected)
            improvementText.textContent = `${improvement} files`;
            improvementBadge.classList.add('no-change');
            improvementBadge.classList.remove('improved');
            if (improvementIcon) improvementIcon.textContent = '';
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
            if (statusIcon) statusIcon.textContent = '';
            if (statusText) statusText.textContent = 'Baseline captured! Use AI to fix errors, then run conversion again to see improvement.';
        } else if (improvement > 0) {
            statusMessage.className = 'ai-status-message success';
            if (statusIcon) statusIcon.textContent = '[ok]';
            if (statusText) statusText.textContent = `AI helped convert ${improvement} additional file${improvement > 1 ? 's' : ''}! ${percentImprovement}% improvement.`;
        } else {
            statusMessage.className = 'ai-status-message';
            if (statusIcon) statusIcon.textContent = '';
            if (statusText) statusText.textContent = 'No change detected. Try using AI suggestions on more error files.';
        }
    }

    // Always show section when there's data
    if (withoutAI > 0 || withAI > 0) {
        section.classList.remove('hidden');
        console.log(' AI Comparison:', withoutAI, '→', withAI, `(Run #${runNumber}, ${improvement > 0 ? '+' : ''}${improvement} files, ${percentImprovement}%)`);
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
    console.log(' Baseline reset for current repo! Run conversion again to set new baseline.');

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
    console.log(' All baselines cleared!');

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
    console.log(' Manual baseline set to:', baselineConverted);

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

    console.log(' Comparison set: Without AI =', withoutAI, '→ With AI =', withAI, '| Improvement: +' + (withAI - withoutAI) + ' files');
}

// Expose functions to window for console access
window.resetBaseline = resetBaseline;
window.resetAllBaselines = resetAllBaselines;
window.setManualBaseline = setManualBaseline;
window.setComparison = setComparison;

// Helper function to get accuracy CSS class for badges
// getAccuracyClass, getAccuracyLevel → public/js/accuracy-panel.js

// Initialize app
init();

// --- HITL: review modal helpers ------------------------------------------
let currentReviewFileId = null;

async function openReviewModal(fileId, label) {
    if (!currentConversionId) return;
    currentReviewFileId = fileId;
    const modal = document.getElementById('reviewModal');
    const title = document.getElementById('reviewModalTitle');
    const cobolEl = document.getElementById('reviewCobolSource');
    const javaEl = document.getElementById('reviewJavaCode');

    if (title) title.textContent = `Review: ${label || fileId}`;
    if (cobolEl) cobolEl.textContent = 'Loading…';
    if (javaEl) javaEl.value = 'Loading…';
    modal.classList.remove('hidden');

    try {
        const r = await fetch(`/api/review/${currentConversionId}/${encodeURIComponent(fileId)}`);
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (cobolEl) cobolEl.textContent = err.error || 'Unable to load review payload';
            if (javaEl) javaEl.value = '';
            return;
        }
        const data = await r.json();
        if (cobolEl) cobolEl.textContent = data.cobolSource || '';
        if (javaEl) javaEl.value = data.javaCode || '';
    } catch (err) {
        if (cobolEl) cobolEl.textContent = 'Error: ' + err.message;
    }
}

function closeReviewModal() {
    const modal = document.getElementById('reviewModal');
    if (modal) modal.classList.add('hidden');
    currentReviewFileId = null;
}

async function submitReview(action) {
    if (!currentConversionId || !currentReviewFileId) return;
    const javaEl = document.getElementById('reviewJavaCode');
    const body = { action };
    if (action === 'edit' && javaEl) body.editedJava = javaEl.value;

    try {
        const r = await fetch(
            `/api/review/${currentConversionId}/${encodeURIComponent(currentReviewFileId)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Review failed: ' + (err.error || r.status), 'error');
            return;
        }
        closeReviewModal();
    } catch (err) {
        toast('Review failed: ' + err.message, 'error');
    }
}

// Expose for inline onclick handlers
window.openReviewModal = openReviewModal;
window.closeReviewModal = closeReviewModal;
window.submitReview = submitReview;

// --- HITL Phase 2: bulk actions + history polling ------------------------
let reviewHistoryTimer = null;

async function bulkReview(action) {
    if (!currentConversionId) return;
    if (action === 'reject' && !(await confirmDialog('Reject ALL files awaiting review?', { title: 'Reject all', okText: 'Reject all', danger: true }))) return;
    try {
        const r = await fetch(`/api/reviews/${currentConversionId}/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Bulk action failed: ' + (err.error || r.status), 'error');
        }
    } catch (err) {
        toast('Bulk action failed: ' + err.message, 'error');
    }
}

function startReviewHistoryPoll() {
    if (reviewHistoryTimer) clearInterval(reviewHistoryTimer);
    reviewHistoryTimer = setInterval(async () => {
        if (!currentConversionId) return;
        try {
            const r = await fetch(`/api/reviews/${currentConversionId}/history`);
            if (!r.ok) return;
            const data = await r.json();
            renderReviewHistory(data.history || []);
        } catch { /* swallow */ }
    }, 2000);
}

function renderReviewHistory(history) {
    const wrap = document.getElementById('reviewHistoryWrap');
    const list = document.getElementById('reviewHistoryList');
    const count = document.getElementById('reviewHistoryCount');
    if (!wrap || !list || !count) return;

    count.textContent = history.length;
    if (history.length === 0) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');

    // Show last 10, newest first
    const items = history.slice(-10).reverse();
    list.innerHTML = items.map(h => {
        const time = new Date(h.at).toLocaleTimeString();
        const icon = h.action === 'approve' ? 'OK' : h.action === 'reject' ? 'FAIL' : 'edit';
        const cls  = h.action === 'approve' ? 'approve' : h.action === 'reject' ? 'reject' : 'edit';
        const bulk = h.bulk ? ' (bulk)' : '';
        const name = (h.fileId || '').split('/').pop();
        return `<div class="history-item ${cls}" title="${escapeHtml(h.fileId)}">
            <span class="history-icon">${icon}</span>
            <span class="history-name">${escapeHtml(name)}${bulk}</span>
            <span class="history-time">${time}</span>
        </div>`;
    }).join('');
}

// escapeHtml, fmt → public/js/helpers.js
window.bulkReview = bulkReview;
window.updateTokenPanel = function (tokens) {
    if (!tokens) return;
    const panel = document.getElementById('tokenPanel');
    if (panel) panel.classList.remove('hidden');
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    set('tokenIn',    fmt(tokens.promptIn));
    set('tokenOut',   fmt(tokens.completionOut));
    set('tokenTotal', fmt(tokens.total));
    set('tokenCalls', fmt(tokens.calls));
};

// --- Risks panel ---------------------------------------------------------
window.updateRisksPanel = function (risks) {
    const panel = document.getElementById('risksPanel');
    const list  = document.getElementById('risksList');
    const count = document.getElementById('risksCount');
    if (!panel || !list || !count) return;
    if (!risks || risks.length === 0) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    count.textContent = risks.length;
    list.innerHTML = risks.map(r => {
        const items = (r.items || []).map(i => `<li>${escapeHtml(i)}</li>`).join('');
        return `<div class="risk-item ${escapeHtml(r.severity)}">
            <div class="risk-title">${escapeHtml(r.title)}</div>
            <div class="risk-detail">${escapeHtml(r.detail)}</div>
            ${items ? `<ul class="risk-items">${items}</ul>` : ''}
        </div>`;
    }).join('');
};

// --- Results browser -----------------------------------------------------
let browserFiles = [];
let browserLoaded = false;

async function loadBrowser() {
    if (browserLoaded || !currentConversionId) return;
    try {
        const r = await fetch(`/api/browser/${currentConversionId}`);
        if (!r.ok) return;
        const data = await r.json();
        if (!data.ready) return;
        browserFiles = data.files || [];
        // Stash outputDir so viewCodeComparison can fall back to reading Java
        // directly from disk when the server's code-comparison lookup misses.
        if (data.outputDir) window.lastOutputDir = data.outputDir;
        renderBrowserTree(browserFiles);
        const section = document.getElementById('browserSection');
        const count = document.getElementById('browserCount');
        if (section) section.classList.remove('hidden');
        if (count) count.textContent = `${browserFiles.length} files`;
        browserLoaded = true;
    } catch (err) {
        console.warn('Browser load failed', err);
    }
}

// Build a nested tree from flat file list (for tree rendering)
function buildTree(files) {
    const root = {};
    for (const f of files) {
        const parts = (f.cobolPath || '').split('/').filter(Boolean);
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            const isLeaf = i === parts.length - 1;
            const key = parts[i];
            if (isLeaf) {
                cur._files = cur._files || [];
                cur._files.push({ name: key, file: f });
            } else {
                cur[key] = cur[key] || {};
                cur = cur[key];
            }
        }
    }
    return root;
}

function renderBrowserTree(files) {
    const treeEl = document.getElementById('browserTree');
    if (!treeEl) return;
    if (files.length === 0) {
        treeEl.innerHTML = '<div class="empty-state">No files to display</div>';
        return;
    }
    // Show all files — COBOL files are interactive, others are dimmed context
    const tree = buildTree(files);
    treeEl.innerHTML = renderTreeNode(tree, '', 0);
    // Wire clicks
    treeEl.querySelectorAll('.tree-file:not(.context-file)').forEach(el => {
        el.addEventListener('click', () => {
            const path = el.dataset.path;
            const file = browserFiles.find(f => f.cobolPath === path);
            if (file) selectBrowserFile(file, el);
        });
    });
    // Wire folder collapse
    treeEl.querySelectorAll('.tree-folder > .tree-folder-label').forEach(el => {
        el.addEventListener('click', () => {
            el.parentElement.classList.toggle('collapsed');
        });
    });
}

function renderTreeNode(node, parentPath, depth) {
    let html = '';
    const folders = Object.keys(node).filter(k => k !== '_files').sort();
    for (const name of folders) {
        const fullPath = parentPath ? parentPath + '/' + name : name;
        html += `<div class="tree-folder">
            <div class="tree-folder-label" style="padding-left:${depth * 12}px">
                <span class="tree-caret"></span>
                <span class="tree-folder-name">${escapeHtml(name)}</span>
            </div>
            <div class="tree-folder-children">
                ${renderTreeNode(node[name], fullPath, depth + 1)}
            </div>
        </div>`;
    }
    if (node._files) {
        // Sort: COBOL files first, then others alphabetically
        const cobolExts = /\.(cob|cbl|cobol|cpy)$/i;
        const sorted = node._files.sort((a, b) => {
            const aCob = cobolExts.test(a.name);
            const bCob = cobolExts.test(b.name);
            if (aCob !== bCob) return aCob ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        for (const item of sorted) {
            const f = item.file;
            const isCobol = ['SUCCESS', 'CONVERT_FAIL', 'FAIL', 'REJECTED_BY_REVIEW', 'SKIPPED_COPYBOOK', 'SKIPPED_NO_ID'].includes(f.status);
            const cls = isCobol ? statusClass(f.status) : 'context-file';
            // Build the accuracy badge with a tooltip explaining the penalty drivers.
            let accTooltip = '';
            if (f.accuracy != null) {
                if (f.accuracy >= 100) {
                    accTooltip = 'Converted at full confidence.';
                } else {
                    accTooltip = `Conversion confidence: ${f.accuracy}%.`;
                    if (Array.isArray(f.penalties) && f.penalties.length > 0) {
                        accTooltip += ' Review: ' + f.penalties.join(', ') + '.';
                    } else {
                        accTooltip += ' Lower than ideal code-volume/coverage ratio — check for missing paragraphs or data items.';
                    }
                    accTooltip += ' Click the file to see details.';
                }
            }
            const acc = f.accuracy != null
                ? `<span class="tree-acc" title="${escapeHtml(accTooltip)}">${f.accuracy}%</span>`
                : '';
            const isCopybook = f.status === 'SKIPPED_COPYBOOK';
            const isNoId = f.status === 'SKIPPED_NO_ID';
            let badge = '';
            let tooltip = escapeHtml(f.cobolPath);
            if (isCopybook) {
                badge = '<span class="tree-badge copybook">copybook</span>';
                tooltip += ' — COBOL include file (data definitions).';
            } else if (isNoId) {
                badge = '<span class="tree-badge noid">no program-id</span>';
                tooltip += ' — Skipped: no PROGRAM-ID found.';
            } else if (!isCobol) {
                tooltip += ' — Not a COBOL file';
            }
            if (f.error) tooltip += ' — ' + escapeHtml(f.error);
            html += `<div class="tree-file ${cls}${isCopybook ? ' copybook-file' : ''}" data-path="${escapeHtml(f.cobolPath)}" style="padding-left:${depth * 12 + 14}px"
                title="${tooltip}">
                <span class="tree-file-icon">${isCobol ? statusIcon(f.status) : fileIcon(item.name)}</span>
                <span class="tree-file-name">${escapeHtml(item.name)}</span>
                ${badge}${acc}
            </div>`;
        }
    }
    return html;
}

function statusIcon(status) {
    switch (status) {
        case 'SUCCESS': return 'OK';
        case 'CONVERT_FAIL':
        case 'FAIL':
        case 'REJECTED_BY_REVIEW': return 'FAIL';
        case 'SKIPPED_COPYBOOK':
        case 'SKIPPED_NO_ID':
        case 'SKIPPED_JCL':
        case 'SKIPPED_DATA':
        case 'SKIPPED_OTHER': return '-';
        default: return '-';
    }
}

function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const icons = {
        md: '', txt: '', json: '{}', yml: '', yaml: '',
        sh: 'cmd', py: '', js: '', java: '', xml: '',
        jpg: '', jpeg: '', png: '', gif: '', svg: '',
        gitignore: '', dockerfile: ''
    };
    return icons[ext] || '-';
}

function statusClass(status) {
    if (status === 'SUCCESS') return 'success';
    if (status && status.startsWith('SKIPPED')) return 'skipped';
    return 'failed';
}

let currentBrowserFile = null;
async function selectBrowserFile(file, el) {
    // Highlight selected
    document.querySelectorAll('.tree-file.selected').forEach(e => e.classList.remove('selected'));
    if (el) el.classList.add('selected');
    currentBrowserFile = file;

    // Show "Fix with AI" for any file where the AI produced Java we can
    // inspect — SUCCESS, COMPILE_FAIL (compile error after repair),
    // CONVERT_FAIL (rare — Java may still have partial output), and any
    // FAIL where java_path is set. Hide only for pre-AI-skipped cases
    // (copybooks, no-ID, JCL) where there's nothing to fix.
    const fixBtn = document.getElementById('fixJavaBtn');
    if (fixBtn) {
        const FIXABLE_STATUSES = new Set(['SUCCESS', 'COMPILE_FAIL', 'CONVERT_FAIL', 'FAIL', 'EXEC_FAIL', 'COMPARE_FAIL']);
        const showable = file && FIXABLE_STATUSES.has(file.status) && file.javaPath;
        fixBtn.classList.toggle('hidden', !showable);
        // Tweak the tooltip so the user knows why fix is worth clicking on a failure.
        if (showable) {
            fixBtn.title = file.status === 'SUCCESS'
                ? 'Use AI to repair this Java file (e.g. to lift the accuracy score or fix low-confidence areas).'
                : `Compile/run issue (${file.status}) — use AI to repair using the COBOL source, compile errors, and known dependencies.`;
        }
    }
    // "View fix diff" + "Undo fix" show only when a .before-fix backup
    // exists on disk — ask the server via /api/fix-diff (cheap, just stat
    // + two file reads).
    const diffBtn = document.getElementById('fixDiffBtn');
    const unfixBtn = document.getElementById('unfixJavaBtn');
    if (diffBtn) diffBtn.classList.add('hidden');
    if (unfixBtn) unfixBtn.classList.add('hidden');
    if (file && file.javaPath && currentConversionId) {
        fetch(`/api/fix-diff/${currentConversionId}/${encodeURIComponent(file.cobolPath)}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d || !d.hasBackup) return;
                // Only show if this is still the file the user is looking at
                // (selectBrowserFile may have advanced to a different file).
                if (!currentBrowserFile || currentBrowserFile.cobolPath !== file.cobolPath) return;
                if (diffBtn) diffBtn.classList.remove('hidden');
                if (unfixBtn) unfixBtn.classList.remove('hidden');
            })
            .catch(() => {});
    }
    // Show the terminal panel when a runnable file is selected
    const canRun = file.status === 'SUCCESS' && file.javaPath;
    const panel = document.getElementById('runOutputPanel');
    const runBtn = document.getElementById('runBtn');
    const fileLabel = document.getElementById('runOutputFile');
    if (canRun && panel) {
        panel.classList.remove('hidden');
        if (fileLabel) fileLabel.textContent = file.cobolPath;
    }
    if (runBtn) {
        runBtn.disabled = !canRun;
        runBtn.title = canRun ? 'Run COBOL and Java side by side' : 'This file was not converted successfully';
    }

    const cobolEl = document.getElementById('browserCobolCode');
    const javaEl  = document.getElementById('browserJavaCode');
    const cobolTitle = document.getElementById('browserCobolTitle');
    const javaTitle  = document.getElementById('browserJavaTitle');

    if (cobolTitle) cobolTitle.textContent = file.cobolPath;
    if (javaTitle)  javaTitle.textContent  = file.javaPath ? file.javaPath.split('/').pop() : 'No Java output';

    if (cobolEl) cobolEl.querySelector('code').textContent = 'Loading…';
    if (javaEl)  javaEl.querySelector('code').textContent  = 'Loading…';

    // Helper: fetch and unwrap the {content} response
    async function loadFileContent(path) {
        try {
            const r = await fetch(`/api/file-content?path=${encodeURIComponent(path)}`);
            if (!r.ok) return null;
            const data = await r.json();
            return data.content || '';
        } catch { return null; }
    }

    // Fetch COBOL source
    if (file.cobolSourcePath) {
        const text = await loadFileContent(file.cobolSourcePath);
        if (cobolEl) cobolEl.querySelector('code').textContent = text != null ? text : '[COBOL source not available]';
    } else if (cobolEl) {
        cobolEl.querySelector('code').textContent = '[COBOL source path not recorded]';
    }

    // Fetch Java code + per-file diagnostics (status, accuracy breakdown, reason)
    // so we can explain WHY a file is at e.g. 71% or why it was skipped.
    let diagnostics = null;
    try {
        const qs = new URLSearchParams();
        if (currentConversionId) qs.set('conversionId', currentConversionId);
        if (file.cobolPath) qs.set('relativePath', file.cobolPath);
        if (file.workDir) qs.set('workDir', file.workDir);
        const dr = await fetch(`/api/code-comparison?${qs.toString()}`);
        if (dr.ok) diagnostics = await dr.json();
    } catch { /* non-fatal — fall back to plain file content */ }

    if (!javaEl) return;
    const codeNode = javaEl.querySelector('code');

    // Whichever path we take below, make sure any stale panel from a prior
    // selection is removed first.
    const javaPane = javaEl.closest('.browser-pane');
    if (javaPane) {
        javaPane.querySelectorAll('.accuracy-panel').forEach(n => n.remove());
    }

    if (diagnostics && diagnostics.javaCode) {
        // Successful conversion — render accuracy panel as a UI element above
        // the code (NOT inside the Java source), so the code itself stays clean
        // and copyable.
        renderAccuracyPanel(javaPane, diagnostics);
        codeNode.textContent = diagnostics.javaCode;
    } else if (diagnostics && (diagnostics.javaStatus || diagnostics.reason)) {
        // Skipped / failed — show structured explanation instead of a dry error string.
        const msg = buildStatusExplanation(diagnostics);
        codeNode.textContent = msg;
    } else if (file.javaPath) {
        // Legacy path — diagnostics unavailable, but the java file exists on disk.
        const text = await loadFileContent(file.javaPath);
        codeNode.textContent = text != null ? text : '[Java file not available]';
    } else {
        codeNode.textContent = file.error
            ? `[No Java generated]\n\n${file.error}`
            : '[No Java generated for this file]';
    }
}

// Shared helper used by both the Results browser and the comparison modal.
// Renders a rich, actionable explanation when Java wasn't produced (or was
// produced with a low score and no code to show).
function buildStatusExplanation(data) {
    const status = data.javaStatus || 'UNKNOWN';
    const reason = data.reason || 'Java code was not generated for this file.';
    const suggestion = data.suggestion || '';
    const err = data.error || '';

    let msg = '[warn] Java not generated\n\n';
    msg += `Status: ${status}\n\n`;
    msg += `Why: ${reason}\n`;
    if (suggestion) msg += `\nWhat to do: ${suggestion}\n`;
    if (err) msg += `\n--- Details ---\n${err}\n`;
    if (status === 'UNKNOWN') {
        msg += '\n(No report entry found. The file may still be in-flight, or the conversion was cancelled before reaching it.)';
    }
    return msg;
}

// Hook into the existing graph poll: when status flips to completed, load the browser
window.onConversionComplete = function () {
    loadBrowser();
};

// Maximize/restore the Results browser section (full-viewport mode).
/**
 * Per-pane expand toggle for the Results Browser (§19).
 *
 * `which` = 'cobol' | 'java'. Toggles `pane-expanded-<which>` on
 * document.body — CSS collapses the other pane and the tree sidebar so
 * the chosen pane fills the row. Clicking the same pane's button again
 * (or the other pane's button) restores the normal layout.
 *
 * Different from the existing `browser-maximized` (which maximizes the
 * WHOLE three-pane grid against the rest of the page); this is about
 * focusing on ONE of the two code panes.
 */
/**
 * Settings cog menu in the header (§9.3).
 *
 * Clicking the cog toggles a dropdown that hosts theme, AI provider
 * status, and placeholders for future knobs (concurrency, budget).
 * Outside-click and Escape both dismiss. Re-entrant: clicking the cog
 * while the menu is open closes it.
 */
/**
 * Compare-two-conversions A/B tool (§21). Opens a modal with two
 * conversion pickers; fetching /api/browser for both and rendering a
 * per-file diff shows which files got better / worse / changed status
 * between the two runs. Useful for A/B testing prompt changes (we've
 * done this ad-hoc via DISABLE_AUTOFIX already — this productizes it).
 *
 * Diff shape per file:
 *   - status delta: A-status → B-status (colored if changed)
 *   - accuracy delta: A-acc% → B-acc% (green if up, red if down, muted
 *     if same)
 *   - penalty set delta: summarized as a count + first-3 differences
 *
 * Files present in only one conversion are shown with the other side
 * blank + a "only in A/B" marker.
 */
async function openCompareConversions() {
    let modal = document.getElementById('compareConversionsModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'compareConversionsModal';
        modal.className = 'modal hidden';
        modal.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h3>Compare conversions</h3>
                    <button class="modal-close" onclick="document.getElementById('compareConversionsModal').classList.add('hidden')" aria-label="Close">x</button>
                </div>
                <div class="modal-body" style="padding: 1rem 1.25rem;">
                    <div class="compare-pickers">
                        <label>A:
                            <select id="compareConvA"><option value="">— pick a conversion —</option></select>
                        </label>
                        <label>B:
                            <select id="compareConvB"><option value="">— pick a conversion —</option></select>
                        </label>
                        <button class="btn-pill btn-sm btn-primary" onclick="runCompareConversions()">Compare</button>
                    </div>
                    <div id="compareConvResult" class="compare-result">
                        <p class="empty-state">Pick two conversions above and click Compare.</p>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    // Populate both dropdowns from /api/conversions. Newest-first;
    // format each option with a short repoUrl + file count + timestamp
    // so picking the right one is unambiguous.
    try {
        const r = await fetch('/api/conversions');
        if (r.ok) {
            const data = await r.json();
            const opts = ['<option value="">— pick a conversion —</option>'];
            for (const c of data.conversions) {
                const when = c.startedAt ? new Date(c.startedAt).toLocaleString() : c.id;
                const repo = (c.inputPath || '').split('/').slice(-2).join('/') || c.id;
                opts.push(`<option value="${c.id}">${when} — ${repo} (${c.successCount}/${c.fileCount})</option>`);
            }
            document.getElementById('compareConvA').innerHTML = opts.join('');
            document.getElementById('compareConvB').innerHTML = opts.join('');
            // Default A to the current conversion so the common case
            // (compare current vs previous) is one click.
            if (currentConversionId) {
                document.getElementById('compareConvA').value = currentConversionId;
            }
        }
    } catch {}
    modal.classList.remove('hidden');
}
window.openCompareConversions = openCompareConversions;

async function runCompareConversions() {
    const idA = document.getElementById('compareConvA').value;
    const idB = document.getElementById('compareConvB').value;
    const result = document.getElementById('compareConvResult');
    if (!idA || !idB || idA === idB) {
        result.innerHTML = '<p class="empty-state">Pick two different conversions.</p>';
        return;
    }
    result.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
        const [aResp, bResp] = await Promise.all([
            fetch(`/api/browser/${idA}`),
            fetch(`/api/browser/${idB}`)
        ]);
        const aData = await aResp.json();
        const bData = await bResp.json();

        // Index by cobolPath — the stable cross-conversion key.
        const aByPath = new Map((aData.files || []).map(f => [f.cobolPath, f]));
        const bByPath = new Map((bData.files || []).map(f => [f.cobolPath, f]));
        const allPaths = new Set([...aByPath.keys(), ...bByPath.keys()]);

        // Aggregate: how many changed status, accuracy sum delta.
        let changedStatus = 0, accImproved = 0, accRegressed = 0;
        const rows = [...allPaths].sort().map(p => {
            const a = aByPath.get(p);
            const b = bByPath.get(p);
            const aStatus = a ? (a.status || '—') : '(missing)';
            const bStatus = b ? (b.status || '—') : '(missing)';
            const aAcc = a && typeof a.accuracy === 'number' ? a.accuracy : null;
            const bAcc = b && typeof b.accuracy === 'number' ? b.accuracy : null;
            const statusChanged = aStatus !== bStatus;
            if (statusChanged) changedStatus++;
            let accDelta = '';
            if (aAcc != null && bAcc != null) {
                const d = bAcc - aAcc;
                if (d > 0) { accDelta = `+${d}`; accImproved++; }
                else if (d < 0) { accDelta = `${d}`; accRegressed++; }
                else accDelta = '±0';
            }
            const accCls = accDelta.startsWith('+') ? 'up' : accDelta.startsWith('-') ? 'down' : 'flat';
            return `
                <tr>
                    <td class="compare-file">${escapeHtml((p || '').split('/').pop())}</td>
                    <td class="${statusChanged ? 'compare-changed' : ''}">${escapeHtml(aStatus)}</td>
                    <td class="${statusChanged ? 'compare-changed' : ''}">${escapeHtml(bStatus)}</td>
                    <td>${aAcc != null ? aAcc + '%' : '—'}</td>
                    <td>${bAcc != null ? bAcc + '%' : '—'}</td>
                    <td class="compare-delta compare-delta-${accCls}">${accDelta}</td>
                </tr>`;
        }).join('');

        result.innerHTML = `
            <div class="compare-summary">
                ${allPaths.size} file${allPaths.size === 1 ? '' : 's'} compared.
                <strong>${changedStatus}</strong> changed status,
                <strong class="compare-delta-up">${accImproved}</strong> accuracy ↑,
                <strong class="compare-delta-down">${accRegressed}</strong> accuracy ↓.
            </div>
            <div class="compare-table-wrap">
                <table class="compare-table">
                    <thead>
                        <tr><th>File</th><th>A status</th><th>B status</th><th>A acc</th><th>B acc</th><th>Δ</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    } catch (err) {
        result.innerHTML = `<p class="empty-state">Compare failed: ${escapeHtml(err.message)}</p>`;
    }
}
window.runCompareConversions = runCompareConversions;

function toggleSettingsMenu(force) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (!menu) return;
    const shouldOpen = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !shouldOpen);
    if (btn) btn.setAttribute('aria-expanded', String(shouldOpen));

    // Bind the outside-click + Escape handlers only while open so we
    // don't leak listeners across toggles.
    if (shouldOpen) {
        const onDocClick = (e) => {
            const wrap = document.getElementById('settingsMenuWrap');
            if (wrap && !wrap.contains(e.target)) {
                toggleSettingsMenu(false);
            }
        };
        const onKey = (e) => { if (e.key === 'Escape') toggleSettingsMenu(false); };
        // Store refs on the menu so close can unbind.
        menu.__docClick = onDocClick;
        menu.__key = onKey;
        // Defer to next tick so the click that opened the menu doesn't
        // immediately close it.
        setTimeout(() => document.addEventListener('click', onDocClick), 0);
        document.addEventListener('keydown', onKey);
    } else {
        if (menu.__docClick) document.removeEventListener('click', menu.__docClick);
        if (menu.__key)      document.removeEventListener('keydown', menu.__key);
        menu.__docClick = null;
        menu.__key = null;
    }
}
window.toggleSettingsMenu = toggleSettingsMenu;

function togglePaneExpand(which) {
    const body = document.body;
    const classes = ['pane-expanded-cobol', 'pane-expanded-java'];
    const target = 'pane-expanded-' + which;
    const alreadyOn = body.classList.contains(target);
    // Always clear both before toggling so switching from one pane's
    // expand to the other's is a clean swap, not a stacked state.
    classes.forEach(c => body.classList.remove(c));
    if (!alreadyOn) body.classList.add(target);
}
window.togglePaneExpand = togglePaneExpand;

function toggleBrowserMaximize(force) {
    const body = document.body;
    const btn  = document.getElementById('browserMaximizeBtn');
    const shouldMax = typeof force === 'boolean' ? force : !body.classList.contains('browser-maximized');
    body.classList.toggle('browser-maximized', shouldMax);
    if (btn) {
        const iconEl  = btn.querySelector('.browser-maximize-icon');
        const labelEl = btn.querySelector('.browser-maximize-label');
        if (iconEl)  iconEl.textContent  = shouldMax ? 'x' : '';
        if (labelEl) labelEl.textContent = shouldMax ? 'Exit' : 'Maximize';
        btn.title = shouldMax ? 'Exit maximized view (Esc)' : 'Maximize (Esc to exit)';
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('browserMaximizeBtn');
    if (btn) btn.addEventListener('click', () => toggleBrowserMaximize());
    // Esc exits maximized view (but only when no modal is capturing Escape).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!document.body.classList.contains('browser-maximized')) return;
        // Don't steal Escape from an open modal dialog.
        const openModal = document.querySelector('.modal:not(.hidden)');
        if (openModal) return;
        toggleBrowserMaximize(false);
    });

    // Download button — streams a zip of Java output + manual-review guide.
    const dlBtn = document.getElementById('browserDownloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadConversionOutput);

    // "Fix with AI" button — repair the currently-selected Java file.
    const fixBtn = document.getElementById('fixJavaBtn');
    if (fixBtn) fixBtn.addEventListener('click', fixSelectedJava);

    // Paired recovery buttons — "View fix diff" + "Undo fix" — enabled only
    // after a fix has been applied (we detect by asking the server whether
    // a .before-fix backup exists).
    const diffBtn = document.getElementById('fixDiffBtn');
    if (diffBtn) diffBtn.addEventListener('click', showFixDiff);
    const unfixBtn = document.getElementById('unfixJavaBtn');
    if (unfixBtn) unfixBtn.addEventListener('click', undoFix);
});

// --- Unified node-click -> Results browser ---------------------------------
// When a user clicks any node in the dependency graph, we drive the existing
// Results Browser to that file and open the timeline beside it. This replaces
// the old "modal + right-side slide-out" combo (which overlapped and hid the
// underlying graph) with a single full-width view:
//   [ tree | COBOL source | Java + accuracy + Fix-with-AI ]  + timeline sidebar.
// The browser section is ALREADY the ideal layout — no point reinventing it
// in a modal.
async function showFileInBrowser(relPath, label) {
    if (!currentConversionId || !relPath) return;
    // Ensure the browser tree is loaded (no-op after first load).
    if (typeof loadBrowser === 'function') await loadBrowser();

    // Scroll to the browser section so it's in view.
    const section = document.getElementById('browserSection');
    if (section) {
        section.classList.remove('hidden');
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Find the matching tree row. Tree rows are keyed by data-path = cobolPath.
    // The row may not exist yet if the conversion is still mid-flight for
    // this file -- retry briefly.
    const selectRow = () => {
        const row = document.querySelector(`.tree-file[data-path="${CSS.escape(relPath)}"]`);
        if (!row) return false;
        row.click();   // triggers selectBrowserFile via the existing delegated listener
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
    };
    let tries = 0;
    while (tries++ < 8 && !selectRow()) {
        await new Promise(r => setTimeout(r, 250));
    }

    // Open the per-file phase timeline alongside the code panes.
    if (typeof openFileTimelinePanel === 'function') {
        openFileTimelinePanel(relPath, label);
    }
}
window.showFileInBrowser = showFileInBrowser;

// --- Per-file timeline slide-out (reuses .fix-progress-panel styling) ---
// Clicked from any node in the graph. Shows the file's phase history
// (queued → ai_call → compile → [repair] → done) with timings + tokens.
// While the conversion is still in flight for this file, the panel polls
// for updates every 1.5s and appends new steps as they arrive.
const ICONS_BY_STEP = {
    queued: '-',
    context_built: '',
    ai_call: '',
    ai_done: 'OK',
    compile: '',
    compile_done: 'OK',
    accuracy: '',
    repair: '',
    repair_done: 'OK',
    repair_failed: 'FAIL',
    repair_errored: 'FAIL',
    done: '[done]',
    skipped: 'skipped'
};
let _timelinePoll = null;
function openFileTimelinePanel(relPath, label) {
    if (!currentConversionId || !relPath) return;
    let panel = document.getElementById('fileTimelinePanel');
    if (!panel) {
        panel = document.createElement('aside');
        panel.id = 'fileTimelinePanel';
        panel.className = 'fix-progress-panel';  // reuse same slide-out CSS
        panel.innerHTML = `
            <div class="fix-progress-header">
                <div class="title">File timeline</div>
                <div class="file"></div>
                <button type="button" class="fix-progress-close" aria-label="Close">x</button>
            </div>
            <ul class="fix-progress-steps"></ul>
            <div class="fix-progress-footer"><span class="elapsed">Loading…</span></div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('.fix-progress-close').addEventListener('click', () => {
            panel.classList.remove('open');
            if (_timelinePoll) { clearInterval(_timelinePoll); _timelinePoll = null; }
        });
    }
    const stepsEl = panel.querySelector('.fix-progress-steps');
    const footerEl = panel.querySelector('.fix-progress-footer');
    panel.querySelector('.file').textContent = label || relPath;
    stepsEl.innerHTML = '';
    footerEl.innerHTML = '<span class="elapsed">Loading…</span>';
    panel.classList.add('open');

    let seenCount = 0;
    const renderEntry = (e) => {
        const icon = ICONS_BY_STEP[e.step] || '-';
        const li = document.createElement('li');
        li.className = 'done';
        const meta = [];
        if (e.ms != null) meta.push(`${e.ms}ms`);
        if (e.tokens != null) meta.push(`${e.tokens} tokens`);
        if (e.accuracy != null) meta.push(`accuracy ${e.accuracy}%`);
        if (e.compileStatus) meta.push(`javac: ${e.compileStatus}`);
        if (e.calls != null || e.copybooks != null || e.copybookBodies != null) {
            const p = [];
            if (e.calls != null) p.push(`${e.calls} calls`);
            if (e.copybooks != null) p.push(`${e.copybooks} copybooks`);
            if (e.copybookBodies != null && e.copybookBodies > 0) p.push(`${e.copybookBodies} inlined`);
            if (e.jclInvocations != null && e.jclInvocations > 0) p.push(`${e.jclInvocations} JCL steps`);
            meta.push(p.join(' - '));
        }
        if (e.errorPreview) meta.push(String(e.errorPreview).slice(0, 200));
        if (e.error)  meta.push(String(e.error).slice(0, 200));
        if (e.totalMs != null) meta.push(`total ${(e.totalMs / 1000).toFixed(1)}s`);
        if (e.javaBytes != null && e.javaBytes > 0) meta.push(`${e.javaBytes}B java`);
        li.innerHTML = `
            <span class="ico">${icon}</span>
            <div class="step-body">
                <span class="label"></span>
                ${meta.length ? `<span class="meta"></span>` : ''}
            </div>
        `;
        li.querySelector('.label').textContent = e.label || e.step || '(step)';
        if (meta.length) li.querySelector('.meta').textContent = meta.join(' - ');
        stepsEl.appendChild(li);
    };

    const refresh = async () => {
        try {
            const r = await fetch(`/api/file-timeline/${currentConversionId}?file=${encodeURIComponent(relPath)}`);
            if (!r.ok) return;
            const data = await r.json();
            const timeline = (data && data.timeline) || [];
            // Append any new entries (stable order, ids by array index).
            for (let i = seenCount; i < timeline.length; i++) renderEntry(timeline[i]);
            if (timeline.length > seenCount) {
                seenCount = timeline.length;
                stepsEl.scrollTop = stepsEl.scrollHeight;
            }
            // Footer: show the latest phase + state.
            const last = timeline[timeline.length - 1];
            const state = data.state || '';
            footerEl.innerHTML = timeline.length
                ? `<strong>${state || last.step}</strong> - ${timeline.length} events`
                : `No events yet for <code>${(label || relPath).slice(0, 60)}</code> — file may be pending.`;
            // Stop polling once we hit a terminal state.
            const terminal = last && ['done', 'skipped', 'repair_failed', 'repair_errored'].includes(last.step);
            if (terminal && _timelinePoll) {
                clearInterval(_timelinePoll);
                _timelinePoll = null;
            }
        } catch { /* silent — polling is best-effort */ }
    };

    if (_timelinePoll) clearInterval(_timelinePoll);
    refresh();
    _timelinePoll = setInterval(refresh, 1500);
}

// --- Fix-with-AI live progress panel -------------------------------------
// Right-side slide-out that shows each step of /api/fix-java as the server
// streams events. Gives the user real-time visibility into the 10-30s repair
// instead of a silent "Fixing…" spinner.
function openFixProgressPanel(fileLabel) {
    let panel = document.getElementById('fixProgressPanel');
    if (!panel) {
        panel = document.createElement('aside');
        panel.id = 'fixProgressPanel';
        panel.className = 'fix-progress-panel';
        panel.innerHTML = `
            <div class="fix-progress-header">
                <div class="title">Fix with AI</div>
                <div class="file"></div>
                <button type="button" class="fix-progress-close" aria-label="Close">x</button>
            </div>
            <ul class="fix-progress-steps"></ul>
            <div class="fix-progress-footer"><span class="elapsed">Starting…</span></div>
        `;
        document.body.appendChild(panel);
        panel.querySelector('.fix-progress-close').addEventListener('click', () => {
            panel.classList.remove('open');
        });
    }
    const stepsEl = panel.querySelector('.fix-progress-steps');
    const footerEl = panel.querySelector('.fix-progress-footer');
    const fileEl = panel.querySelector('.file');
    stepsEl.innerHTML = '';
    footerEl.innerHTML = '<span class="elapsed">Starting…</span>';
    fileEl.textContent = fileLabel || '';
    panel.classList.add('open');

    const startedAt = Date.now();
    let currentRunningLi = null;
    function markRunningDone() {
        if (currentRunningLi) {
            currentRunningLi.classList.remove('running');
            currentRunningLi.classList.add('done');
            const ico = currentRunningLi.querySelector('.ico');
            if (ico) ico.textContent = 'OK';
        }
    }
    function tickElapsed() {
        const el = panel.querySelector('.elapsed');
        if (el && panel.classList.contains('open')) {
            el.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed`;
        }
    }
    const tickInterval = setInterval(tickElapsed, 200);

    return {
        el: panel,
        addStep(payload) {
            markRunningDone();
            const li = document.createElement('li');
            li.className = 'running';
            const meta = [];
            if (payload.ms != null) meta.push(`${payload.ms}ms`);
            if (payload.tokens != null) meta.push(`${payload.tokens} tokens`);
            if (payload.cobolBytes != null || payload.javaBytes != null) {
                const p = [];
                if (payload.cobolBytes != null) p.push(`${payload.cobolBytes}B COBOL`);
                if (payload.javaBytes != null) p.push(`${payload.javaBytes}B Java`);
                meta.push(p.join(' - '));
            }
            if (payload.errorPreview) meta.push(payload.errorPreview);
            if (payload.dependencies != null) meta.push(`deps: ${payload.dependencies}`);
            if (payload.compileStatus) meta.push(`javac: ${payload.compileStatus}`);
            li.innerHTML = `
                <span class="ico">-</span>
                <div class="step-body">
                    <span class="label"></span>
                    ${meta.length ? `<span class="meta"></span>` : ''}
                </div>
            `;
            li.querySelector('.label').textContent = payload.label || payload.step || '(step)';
            if (meta.length) li.querySelector('.meta').textContent = meta.join(' - ');
            stepsEl.appendChild(li);
            li.scrollIntoView({ block: 'nearest' });
            currentRunningLi = li;
        },
        errorStep(msg) {
            markRunningDone();
            const li = document.createElement('li');
            li.className = 'error';
            li.innerHTML = `<span class="ico">FAIL</span><div class="step-body"><span class="label"></span></div>`;
            li.querySelector('.label').textContent = msg;
            stepsEl.appendChild(li);
            currentRunningLi = null;
        },
        finalize(final) {
            clearInterval(tickInterval);
            markRunningDone();
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            const parts = [`total ${elapsed}s`];
            if (final && final.compileStatus) {
                parts.push(final.compileStatus === 'ok'
                    ? `<span class="compile-ok">compiles OK</span>`
                    : `<span class="compile-fail">compile: ${final.compileStatus}</span>`);
            }
            if (final && typeof final.newAccuracy === 'number') parts.push(`accuracy ${final.newAccuracy}%`);
            if (final && final.usage && (final.usage.total_tokens || final.usage.totalTokens)) {
                parts.push(`${final.usage.total_tokens || final.usage.totalTokens} tokens`);
            }
            if (final && !final.success) parts.push(`<span class="compile-fail">failed</span>`);
            footerEl.innerHTML = parts.join(' - ');
        }
    };
}

/**
 * Consume an SSE-style response from /api/fix-java and feed its events into
 * the progress panel. Returns the final payload (same shape the non-streaming
 * endpoint returned before), so the caller can proceed with its existing
 * success/failure logic unchanged.
 */
async function consumeFixStream(response, panel) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalPayload = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines. Parse each complete event.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = raw.split('\n');
            let type = 'message', data = '';
            for (const l of lines) {
                if (l.startsWith('event:')) type = l.slice(6).trim();
                else if (l.startsWith('data:')) data += l.slice(5).trim();
            }
            let payload = null;
            try { payload = JSON.parse(data); } catch { /* ignore */ }
            if (!payload) continue;
            if (type === 'step') panel.addStep(payload);
            else if (type === 'final') {
                finalPayload = payload;
                panel.finalize(payload);
            }
        }
    }
    return finalPayload;
}

/**
 * Invoke the AI repair agent on the currently-selected file. Sends the
 * COBOL source, current Java, compile errors, run outputs, and sibling
 * dependency map as context. Replaces the Java pane in place when done
 * and refreshes the accuracy panel + tree badge from the updated report.
 */
async function fixSelectedJava() {
    if (!currentBrowserFile || !currentConversionId) {
        toast('Select a converted file first.', 'warning');
        return;
    }
    const fixBtn = document.getElementById('fixJavaBtn');
    const javaEl = document.getElementById('browserJavaCode');
    const codeNode = javaEl && javaEl.querySelector('code');
    const labelEl = fixBtn && fixBtn.querySelector('.fix-java-label');

    if (fixBtn) { fixBtn.disabled = true; if (labelEl) labelEl.textContent = 'Fixing…'; }
    if (codeNode) codeNode.textContent = '// AI repair agent is analyzing the COBOL source, current Java,\n// compile errors, and sibling dependencies to produce a fixed version.\n// This usually takes 10–30 seconds — live progress is in the right panel.\n\n' + codeNode.textContent;

    // Open a live progress panel on the right so the user sees each step
    // instead of staring at a spinner. The server streams events as it runs.
    const panel = openFixProgressPanel(currentBrowserFile.cobolPath);

    try {
        const r = await fetch('/api/fix-java', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({
                conversionId: currentConversionId,
                relativePath: currentBrowserFile.cobolPath
            })
        });

        let data = null;
        const ctype = (r.headers.get('content-type') || '').toLowerCase();
        if (ctype.includes('text/event-stream')) {
            data = await consumeFixStream(r, panel);
        } else {
            // Backwards compat — old server returns a single JSON payload.
            data = await r.json();
            panel.finalize(data);
        }

        if (!r.ok || !data || !data.success) {
            toast('Fix failed: ' + ((data && data.error) || r.status), 'error');
            if (codeNode) codeNode.textContent = codeNode.textContent.replace(/^\/\/ AI repair agent[^]*?\n\n/, '');
            return;
        }
        // Replace pane contents with the new Java
        if (codeNode) codeNode.textContent = data.newJavaCode;

        // Refresh the accuracy panel from the updated server state — the
        // report entry was rewritten with new metrics + penalty list.
        const javaPane = javaEl && javaEl.closest('.browser-pane');
        if (javaPane) {
            javaPane.querySelectorAll('.accuracy-panel').forEach(n => n.remove());
            try {
                const qs = new URLSearchParams({
                    conversionId: currentConversionId,
                    relativePath: currentBrowserFile.cobolPath
                });
                const diagResp = await fetch(`/api/code-comparison?${qs.toString()}`);
                if (diagResp.ok) {
                    const diagData = await diagResp.json();
                    renderAccuracyPanel(javaPane, diagData);
                    // Mutate the cached browser file so later clicks reflect the fix
                    currentBrowserFile.accuracy = diagData.accuracy;
                    currentBrowserFile.penalties = (diagData.accuracyBreakdown && diagData.accuracyBreakdown.semanticPenalties) || [];
                }
            } catch { /* non-fatal */ }
        }

        // Refresh the tree so the accuracy badge updates in place.
        try {
            const br = await fetch(`/api/browser/${currentConversionId}`);
            if (br.ok) {
                const data2 = await br.json();
                if (data2 && Array.isArray(data2.files)) {
                    browserFiles = data2.files;
                    browserLoaded = true;
                    renderBrowserTree(browserFiles);
                    // Re-select the same row so the user doesn't lose context
                    const row = document.querySelector(`.tree-file[data-path="${CSS.escape(currentBrowserFile.cobolPath)}"]`);
                    if (row) row.classList.add('selected');
                }
            }
        } catch { /* non-fatal */ }

        const accMsg = (typeof data.newAccuracy === 'number') ? ` (accuracy now ${data.newAccuracy}%)` : '';
        toast(`Java file repaired${accMsg}. Backup saved as .java.before-fix.`, 'success');
    } catch (err) {
        toast('Fix failed: ' + (err.message || err), 'error');
    } finally {
        if (fixBtn) { fixBtn.disabled = false; if (labelEl) labelEl.textContent = 'Fix with AI'; }
    }
}

/**
 * Show the pre-fix vs current Java side-by-side. Side-by-side (not unified
 * diff) mirrors the code-comparison modal pattern and avoids pulling in a
 * diff library — the existing `formatDiff` expects unified output.
 */
async function showFixDiff() {
    if (!currentBrowserFile || !currentConversionId) return;
    try {
        const r = await fetch(`/api/fix-diff/${currentConversionId}/${encodeURIComponent(currentBrowserFile.cobolPath)}`);
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast(err.error || 'No fix diff available', 'warning');
            return;
        }
        const data = await r.json();
        if (!data.hasBackup) {
            toast('No fix has been applied to this file yet.', 'info');
            return;
        }

        // Reuse the existing code-comparison modal structure. Modal is
        // created lazily the first time.
        let modal = document.getElementById('fixDiffModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'fixDiffModal';
            modal.className = 'modal hidden';
            modal.innerHTML = `
                <div class="modal-content modal-wide">
                    <div class="modal-header">
                        <h3>Fix diff — <span id="fixDiffTitle"></span></h3>
                        <button class="modal-close" onclick="document.getElementById('fixDiffModal').classList.add('hidden')" aria-label="Close">x</button>
                    </div>
                    <div class="comparison-panes">
                        <div class="comparison-pane">
                            <div class="pane-header"><span class="pane-title">Before fix (.java.before-fix)</span></div>
                            <pre class="browser-code"><code id="fixDiffBefore" class="language-java"></code></pre>
                        </div>
                        <div class="comparison-pane">
                            <div class="pane-header"><span class="pane-title">After fix (current)</span></div>
                            <pre class="browser-code"><code id="fixDiffAfter" class="language-java"></code></pre>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        document.getElementById('fixDiffTitle').textContent = currentBrowserFile.cobolPath;
        document.getElementById('fixDiffBefore').textContent = data.before;
        document.getElementById('fixDiffAfter').textContent = data.after;
        // Prism re-highlight if available
        if (window.Prism && Prism.highlightAllUnder) {
            Prism.highlightAllUnder(modal);
        }
        modal.classList.remove('hidden');
    } catch (err) {
        toast('Failed to load fix diff: ' + (err.message || err), 'error');
    }
}
window.showFixDiff = showFixDiff;

/**
 * Restore the pre-fix backup. Confirms first — destructive (deletes the
 * backup and overwrites current Java). Server recompiles the restored code
 * so the entry's status reflects reality after unfix.
 */
async function undoFix() {
    if (!currentBrowserFile || !currentConversionId) return;
    const ok = await confirmDialog(
        `Restore the pre-fix version of ${currentBrowserFile.cobolPath.split('/').pop()}?\n\n` +
        `The current Java will be overwritten and the .java.before-fix backup will be deleted.`,
        { title: 'Undo AI fix', okText: 'Restore', danger: true }
    );
    if (!ok) return;
    try {
        const r = await fetch(`/api/unfix-java/${currentConversionId}/${encodeURIComponent(currentBrowserFile.cobolPath)}`, {
            method: 'POST'
        });
        const data = await r.json();
        if (!r.ok) {
            toast(data.error || 'Unfix failed', 'error');
            return;
        }
        // Refresh the Java pane so the user sees the restored code without a reload.
        try {
            await selectBrowserFile(currentBrowserFile, null);
        } catch {}
        // Let the user know whether the restored code still compiles.
        const compileNote = data.compileStatus === 'ok'
            ? 'Compiles cleanly.'
            : (data.compileStatus === 'fail' ? 'Restored code has compile errors — see the status panel.' : '');
        const accMsg = (typeof data.newAccuracy === 'number') ? ` Accuracy: ${data.newAccuracy}%.` : '';
        toast(`Restored pre-fix Java.${accMsg} ${compileNote}`, 'success');
    } catch (err) {
        toast('Unfix failed: ' + (err.message || err), 'error');
    }
}
window.undoFix = undoFix;

// Download the conversion output as a zip archive. The server streams it so
// we just navigate the browser to the endpoint; it triggers a file save.
/**
 * Partial re-run — starts a fresh conversion covering only the files that
 * FAILED in the current run. Reads the in-memory conversion report,
 * filters to the failure statuses, repopulates the selection list, and
 * calls actuallyStartConversion() with them.
 *
 * "Failed" = CONVERT_FAIL, COMPILE_FAIL, EXEC_FAIL, FAIL, COMPARE_FAIL
 * plus REJECTED_BY_REVIEW (reviewer rejected but the AI did produce
 * output — user might want to retry with a prompt tweak). Explicitly
 * NOT: SKIPPED_* (intentional omissions), SUCCESS (obviously).
 */
async function retryFailedFiles() {
    if (!currentConversionId) return;
    try {
        const r = await fetch(`/api/browser/${currentConversionId}`);
        if (!r.ok) { toast('Could not load the current conversion report.', 'error'); return; }
        const data = await r.json();
        const FAIL_STATUSES = new Set(['CONVERT_FAIL', 'COMPILE_FAIL', 'EXEC_FAIL', 'FAIL', 'COMPARE_FAIL', 'REJECTED_BY_REVIEW']);
        const failedFiles = (data.files || [])
            .filter(f => FAIL_STATUSES.has(f.status))
            .map(f => f.cobolPath || f.cobolSourcePath)
            .filter(Boolean);
        if (failedFiles.length === 0) {
            toast('No failed files to retry.', 'info');
            return;
        }
        // Look up the inputPath the current conversion is rooted at —
        // /api/status surfaces it under result / top-level — so we can
        // hand the same repo to the new conversion.
        const st = await fetch(`/api/status/${currentConversionId}`).then(x => x.json()).catch(() => ({}));
        const inputPath = (st && st.inputPath) || (st && st.result && st.result.outputDir)
            || repoInput.value.trim();
        if (!inputPath) {
            toast('Could not determine the original repo path.', 'error');
            return;
        }
        const ok = await confirmDialog(
            `Retry ${failedFiles.length} failed file${failedFiles.length === 1 ? '' : 's'} in a new conversion?\n\n` +
            `The current run stays intact; this starts fresh with just the failed files.`,
            { title: 'Retry failed', okText: `Retry ${failedFiles.length}`, danger: false }
        );
        if (!ok) return;
        // Hand off to the same code path a full conversion takes so we
        // inherit review-mode handling, scan-overlay, etc.
        try { await actuallyStartConversion(inputPath, failedFiles); }
        catch (err) { toast('Retry failed: ' + err.message, 'error'); }
    } catch (err) {
        toast('Retry failed: ' + err.message, 'error');
    }
}
window.retryFailedFiles = retryFailedFiles;

/**
 * Show/hide the "Retry failed" button based on whether the current
 * conversion report has any failed files. Called from paintKpiBar (once
 * the results view is active) so the count stays in sync.
 */
function updateRetryFailedButton(files) {
    const btn = document.getElementById('retryFailedBtn');
    const countEl = document.getElementById('retryFailedCount');
    if (!btn) return;
    const FAIL_STATUSES = new Set(['CONVERT_FAIL', 'COMPILE_FAIL', 'EXEC_FAIL', 'FAIL', 'COMPARE_FAIL', 'REJECTED_BY_REVIEW']);
    const count = (files || []).filter(f => FAIL_STATUSES.has(f.status)).length;
    if (count === 0) {
        btn.classList.add('hidden');
    } else {
        btn.classList.remove('hidden');
        if (countEl) countEl.textContent = '(' + count + ')';
    }
}

/**
 * Small dropdown toggle for the download-format menu. Matches the
 * settings-cog pattern: Escape + outside-click both dismiss, re-entrant
 * so a second click on the ▾ closes.
 */
function toggleDownloadMenu(force) {
    const menu = document.getElementById('downloadMenu');
    if (!menu) return;
    const shouldOpen = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !shouldOpen);
    if (shouldOpen) {
        const close = (e) => {
            const wrap = document.querySelector('.download-split');
            if (wrap && !wrap.contains(e.target)) toggleDownloadMenu(false);
        };
        const key = (e) => { if (e.key === 'Escape') toggleDownloadMenu(false); };
        menu.__close = close; menu.__key = key;
        setTimeout(() => document.addEventListener('click', close), 0);
        document.addEventListener('keydown', key);
    } else {
        if (menu.__close) document.removeEventListener('click', menu.__close);
        if (menu.__key) document.removeEventListener('keydown', menu.__key);
        menu.__close = null; menu.__key = null;
    }
}
window.toggleDownloadMenu = toggleDownloadMenu;

async function downloadConversionOutput(format) {
    if (!currentConversionId) {
        toast('No active conversion to download yet.', 'warning');
        return;
    }
    try {
        // Format matrix:
        //   undefined           → flat java/ layout
        //   'maven'             → Maven project (src/main/java + pom.xml)
        //   'maven-springbatch' → Maven + jobs/*.spring-batch.xml from JCL
        let qs = '';
        if (format === 'maven') {
            qs = '?format=maven';
        } else if (format === 'maven-springbatch') {
            qs = '?format=maven&orchestration=spring-batch';
        }
        // Pre-flight: HEAD the endpoint to surface errors (not-complete, missing)
        // nicely as a toast instead of a broken download.
        const head = await fetch(`/api/download/${currentConversionId}${qs}`, { method: 'GET' });
        if (!head.ok) {
            const err = await head.json().catch(() => ({}));
            toast(err.error || `Download failed (${head.status})`, 'error');
            return;
        }
        // Turn the response stream into a blob and trigger a save.
        const blob = await head.blob();
        const contentDisp = head.headers.get('Content-Disposition') || '';
        const nameMatch = /filename="?([^"]+)"?/i.exec(contentDisp);
        const filename = nameMatch ? nameMatch[1] : `conversion-${currentConversionId}.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast(`Downloaded ${filename}`, 'success');
    } catch (e) {
        toast('Download failed: ' + (e.message || e), 'error');
    }
}

// --- Pre-conversion HITL: file selection modal ---------------------------
let preConvertScan = null; // { inputPath, files, counts }
let preConvertSelected = new Set(); // relative paths

function openPreConvertModal(scan) {
    preConvertScan = scan;
    // Default selection: all COBOL files (the ones that will actually be converted)
    preConvertSelected = new Set(scan.files.filter(f => f.type === 'cobol').map(f => f.path));
    document.getElementById('preConvertCounts').innerHTML = `
        <span class="count-pill cobol">${scan.counts.cobol} COBOL</span>
        <span class="count-pill copybook">${scan.counts.copybook} copybook</span>
        <span class="count-pill jcl">${scan.counts.jcl} JCL</span>
        <span class="count-pill data">${scan.counts.data} data</span>
        <span class="count-pill other">${scan.counts.other} other</span>
    `;
    document.getElementById('preConvertModal').classList.remove('hidden');
    renderPreConvertList();

    // Wire search
    const searchEl = document.getElementById('preConvertSearch');
    if (searchEl) {
        searchEl.value = '';
        searchEl.oninput = () => renderPreConvertList(searchEl.value.trim().toLowerCase());
    }
}

function closePreConvertModal() {
    document.getElementById('preConvertModal').classList.add('hidden');
}

function renderPreConvertList(filter) {
    const list = document.getElementById('preConvertList');
    if (!list || !preConvertScan) return;
    const f = filter || '';
    const visible = preConvertScan.files.filter(x => !f || x.path.toLowerCase().includes(f));
    if (visible.length === 0) {
        list.innerHTML = '<div class="empty-state">No files match the filter.</div>';
        updatePreConvertSelectedCount();
        return;
    }
    list.innerHTML = visible.map(file => {
        const checked = preConvertSelected.has(file.path) ? 'checked' : '';
        const isCobol = file.type === 'cobol';
        const sizeKb = (file.sizeBytes / 1024).toFixed(1);
        const disabled = !isCobol ? 'disabled' : '';
        return `<label class="pc-row ${file.type} ${disabled}">
            <input type="checkbox" data-path="${escapeHtml(file.path)}" ${checked} ${disabled}>
            <span class="pc-type ${file.type}">${file.type}</span>
            <span class="pc-path">${escapeHtml(file.path)}</span>
            <span class="pc-size">${sizeKb} KB</span>
        </label>`;
    }).join('');
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const p = cb.dataset.path;
            if (cb.checked) preConvertSelected.add(p);
            else preConvertSelected.delete(p);
            updatePreConvertSelectedCount();
        });
    });
    updatePreConvertSelectedCount();
}

function updatePreConvertSelectedCount() {
    const el = document.getElementById('preConvertSelected');
    const btn = document.getElementById('preConvertStartBtn');
    if (el) el.textContent = `${preConvertSelected.size} selected`;
    if (btn) {
        btn.textContent = `Start conversion (${preConvertSelected.size})`;
        btn.disabled = preConvertSelected.size === 0;
    }
}

function preConvertSelectAll() {
    if (!preConvertScan) return;
    preConvertScan.files.filter(f => f.type === 'cobol').forEach(f => preConvertSelected.add(f.path));
    renderPreConvertList(document.getElementById('preConvertSearch').value);
}
function preConvertSelectNone() {
    preConvertSelected.clear();
    renderPreConvertList(document.getElementById('preConvertSearch').value);
}
function preConvertSelectCobol() { preConvertSelectAll(); }

async function preConvertStart() {
    if (!preConvertScan || preConvertSelected.size === 0) return;
    const inputPath = preConvertScan.inputPath;
    const selected = Array.from(preConvertSelected);

    // Cost warning: large selections spend real tokens. Compute total source
    // bytes (sizeBytes is on each scan entry) and warn when above the
    // "accidental-click" threshold — 50 files OR 500KB of COBOL source.
    // Ballpark token estimate: 1 char ~ 0.3 tokens for COBOL (it's verbose
    // with lots of fixed-format whitespace, so a bit less dense than English).
    const selectedSet = new Set(selected);
    const selectedEntries = preConvertScan.files.filter(f => selectedSet.has(f.path));
    const totalBytes = selectedEntries.reduce((s, f) => s + (f.sizeBytes || 0), 0);
    const WARN_COUNT = 50;
    const WARN_BYTES = 500 * 1024;
    if (selected.length >= WARN_COUNT || totalBytes >= WARN_BYTES) {
        const kb = Math.round(totalBytes / 1024);
        const estInTokens = Math.round(totalBytes * 0.3);
        // Rough upper bound: each file ~= input*2 + 4k output tokens (conv + likely repair)
        const estTotalTokens = estInTokens * 2 + selected.length * 4000;
        const msg =
            `${selected.length} files - ${kb} KB of COBOL source.\n\n` +
            `Estimated token cost: ~${estTotalTokens.toLocaleString()} tokens total (input + output, includes possible auto-repair passes).\n\n` +
            `Run the conversion?`;
        const go = await confirmDialog(msg, { title: 'Confirm large conversion', okText: 'Start anyway', cancelText: 'Cancel' });
        if (!go) return;
    }

    closePreConvertModal();
    // Pass the cloned/local inputPath as repoUrl so the converter doesn't re-clone
    await actuallyStartConversion(inputPath, selected);
}

window.openPreConvertModal = openPreConvertModal;
window.closePreConvertModal = closePreConvertModal;
window.preConvertSelectAll = preConvertSelectAll;
window.preConvertSelectNone = preConvertSelectNone;
window.preConvertSelectCobol = preConvertSelectCobol;
window.preConvertStart = preConvertStart;

// --- Post-conversion HITL: per-file sign-off in the browser pane ---------
let postReviewState = {}; // fileId -> { action, note, at }

async function postReviewFile(action) {
    if (!currentConversionId) return;
    // Use the currently-selected file in the browser
    const selected = document.querySelector('.tree-file.selected');
    if (!selected) {
        toast('Select a file in the tree first.', 'warning');
        return;
    }
    const fileId = selected.dataset.path;
    let note = null;
    if (action === 'reject') {
        const entered = await promptDialog('Optional reason for rejection (leave blank to skip):', { title: 'Reject file', okText: 'Reject', cancelText: 'Cancel' });
        // User cancelled the prompt — abort the whole reject action.
        if (entered === null) return;
        note = entered.trim() || null;
    }
    try {
        const r = await fetch(`/api/post-review/${currentConversionId}/${encodeURIComponent(fileId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, note })
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Sign-off failed: ' + (err.error || r.status), 'error');
            return;
        }
        postReviewState[fileId] = { action, note, at: Date.now() };
        // Visually mark the tree row
        selected.classList.remove('reviewed-approve', 'reviewed-reject');
        selected.classList.add('reviewed-' + action);
        updatePostReviewBadge();
    } catch (err) {
        toast('Sign-off failed: ' + err.message, 'error');
    }
}

function updatePostReviewBadge() {
    const badge = document.getElementById('postReviewBadge');
    if (!badge) return;
    const counts = { approve: 0, reject: 0 };
    Object.values(postReviewState).forEach(r => { if (counts[r.action] != null) counts[r.action]++; });
    badge.textContent = `${counts.approve} approved - ${counts.reject} rejected`;
    badge.classList.toggle('hidden', counts.approve + counts.reject === 0);
}

window.postReviewFile = postReviewFile;

// --- Stop conversion -----------------------------------------------------
async function stopConversion() {
    if (!currentConversionId) return;
    if (!(await confirmDialog('Cancel the current conversion? Files in flight will be marked as skipped.', { title: 'Cancel conversion', okText: 'Stop conversion', cancelText: 'Keep running', danger: true }))) return;
    try {
        const r = await fetch(`/api/cancel/${currentConversionId}`, { method: 'POST' });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Cancel failed: ' + (err.error || r.status), 'error');
        }
    } catch (err) {
        toast('Cancel failed: ' + err.message, 'error');
    }
}

function swapToConvertButton() {
    convertBtn.dataset.busy = '0';
    if (window.updateConvertEnabled) window.updateConvertEnabled();
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.title = 'No conversion is currently running';
    }
}

/**
 * Accuracy distribution histogram in the KPI bar.
 *
 * Splits per-file accuracy scores across 5 fixed buckets (0–19, 20–39,
 * 40–59, 60–79, 80–100) and scales each bar height to `count / max` so
 * the tallest bar fills the row. Bars are colored by bucket level
 * (low / medium / high) reusing the same palette as the file-row
 * accuracy badges.
 *
 * No-op when fewer than 2 scored files exist — a single-bucket
 * histogram is uninformative and just takes space. Hides the kpi-cell
 * entirely in that case so the flex row doesn't leave a gap.
 *
 * Called from paintKpiBar with the file list already fetched from
 * /api/browser/:id.
 */
/**
 * Rough per-run USD estimate from token counts. Hardcoded price table
 * keyed off the deployment family — we don't ping Azure's pricing API
 * (auth + extra latency for a back-of-envelope number isn't worth it).
 *
 * Prices are per-1M-tokens as of 2026-04 for the Azure OpenAI regional
 * pricing, matched to the deployment family we actually use. When the
 * deployment isn't recognized we fall back to gpt-4.1-mini (current
 * default in .env.example) — lower-bound estimate is better than
 * showing nothing.
 *
 * Returns a number (USD) or null if token counts are zero.
 */
function estimateRunCostUsd({ promptIn, completionOut }) {
    if (!promptIn && !completionOut) return null;
    const PRICE = {
        // $ per 1M tokens (input, output)
        'gpt-4.1':        [2.00, 8.00],
        'gpt-4.1-mini':   [0.40, 1.60],
        'gpt-4.1-nano':   [0.10, 0.40],
        'gpt-4o':         [2.50, 10.00],
        'gpt-4o-mini':    [0.15, 0.60],
        'gpt-35-turbo':   [0.50, 1.50],
    };
    // Inspect the deployment advertised by /api/ai/provider. We cached
    // it in window.__aiDeployment on checkAIStatus; if not set, fall
    // back to the default.
    const name = (window.__aiDeployment || 'gpt-4.1-mini').toLowerCase();
    // Match longest-prefix first so "gpt-4.1-mini-2025" still maps
    // to "gpt-4.1-mini" rather than "gpt-4.1".
    const family = Object.keys(PRICE)
        .sort((a, b) => b.length - a.length)
        .find(f => name.includes(f)) || 'gpt-4.1-mini';
    const [inPrice, outPrice] = PRICE[family];
    return (promptIn / 1_000_000) * inPrice + (completionOut / 1_000_000) * outPrice;
}

/**
 * Populates `window.cobolGraph.__fileData` — a {id → {durationMs, accuracy,
 * error}} map the graph tooltip reads on hover. Keys match what the
 * graph uses for node ids (relative file paths from conversion.graph).
 *
 * Duration comes from the fileTimeline's earliest→latest span so it
 * reflects actual pipeline time (convert → compile → [repair] → score),
 * not wall-clock from pending to done which might include HITL pause.
 */
function publishFileDataForTooltip(files, status) {
    if (!window.cobolGraph) return;
    const timelines = (status && status.fileTimeline) || {};
    const data = {};
    for (const f of (files || [])) {
        const tl = timelines[f.cobolPath] || [];
        let durationMs = null;
        if (tl.length >= 2) {
            const first = tl[0].at;
            const last = tl[tl.length - 1].at;
            if (first && last && last > first) durationMs = last - first;
        }
        data[f.cobolPath] = {
            durationMs,
            accuracy: (typeof f.accuracy === 'number') ? f.accuracy : null,
            error: f.error || null,
            status: f.status || null
        };
    }
    window.cobolGraph.__fileData = data;
}

function paintAccuracyHistogram(files) {
    const cell = document.getElementById('kpiAccuracyDistCell');
    if (!cell) return;
    // Only count files that actually have an accuracy score (SKIPPED_* and
    // FAIL rows don't). Empty / single-file case isn't worth rendering.
    const scored = (files || [])
        .map(f => (typeof f.accuracy === 'number' ? f.accuracy : null))
        .filter(a => a !== null);
    if (scored.length < 2) {
        cell.classList.add('hidden');
        return;
    }
    // 5 buckets of width 20 each; 100 goes into the top bucket.
    const buckets = [0, 0, 0, 0, 0];
    for (const a of scored) {
        const idx = Math.min(4, Math.max(0, Math.floor(a / 20)));
        buckets[idx]++;
    }
    const max = Math.max(...buckets, 1);
    const bars = cell.querySelectorAll('.h-bar');
    bars.forEach((bar, i) => {
        const fill = bar.querySelector('.h-bar-fill');
        const pct = Math.round((buckets[i] / max) * 100);
        if (fill) fill.style.height = pct + '%';
        // Count + range in the tooltip so the user gets concrete numbers.
        const range = bar.getAttribute('data-range') || '';
        bar.title = `${buckets[i]} file${buckets[i] === 1 ? '' : 's'} scored ${range}`;
        // Zero buckets get a minimum height so they read as "empty"
        // instead of missing — prevents the bars from visually disappearing.
        if (buckets[i] === 0 && fill) fill.style.height = '2px';
    });
    cell.classList.remove('hidden');
}

// --- KPI bar (post-completion) -------------------------------------------
async function paintKpiBar() {
    if (!currentConversionId) return;
    try {
        // /api/browser carries per-file accuracy; fetch alongside so we can
        // render the score-distribution histogram in the same pass.
        const [statusResp, graphResp, browserResp] = await Promise.all([
            fetch(`/api/status/${currentConversionId}`),
            fetch(`/api/graph/${currentConversionId}`),
            fetch(`/api/browser/${currentConversionId}`)
        ]);
        const status = await statusResp.json();
        const graph = await graphResp.json();
        const browser = await browserResp.json().catch(() => ({}));
        const r = (status.result || {});
        const summary = (r.report && r.report.summary) || {};
        const total = r.totalFiles || 0;
        const converted = r.converted || 0;
        const accuracy = summary.averageAccuracy || 0;
        const tokens = (graph.tokens && graph.tokens.total) || 0;
        const successRate = total > 0 ? Math.round((converted / total) * 100) : 0;
        // Use server-side timing if available, else fall back to client-side
        let duration = 0;
        if (status.startedAt) {
            const end = status.completedAt || Date.now();
            duration = Math.round((end - status.startedAt) / 1000);
        } else if (conversionStartedAt) {
            duration = Math.round((Date.now() - conversionStartedAt) / 1000);
        }

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('kpiTotal', total);
        set('kpiConverted', converted);
        set('kpiSuccessRate', successRate + '%');
        set('kpiAccuracy', accuracy + '%');
        set('kpiTokens', fmt(tokens));
        // USD estimate alongside the token count. We don't call the Azure
        // pricing API (would need an auth cred + adds latency); instead
        // we carry a small hardcoded price table keyed off deployment
        // family. When the deployment isn't recognized, fall back to the
        // cheapest current-gen entry so users see a lower-bound number
        // rather than nothing. See estimateRunCostUsd() for the table.
        const usd = estimateRunCostUsd({
            promptIn: (graph.tokens && graph.tokens.promptIn) || 0,
            completionOut: (graph.tokens && graph.tokens.completionOut) || 0
        });
        if (usd !== null) {
            const tokensLabel = document.querySelector('#kpiTokens')?.parentElement?.querySelector('.kpi-label');
            if (tokensLabel) tokensLabel.textContent = `LLM tokens • $${usd.toFixed(2)}`;
        }
        set('kpiDuration', duration < 60 ? duration + 's' : Math.floor(duration / 60) + 'm ' + (duration % 60) + 's');
        paintAccuracyHistogram(browser && browser.files);
        publishFileDataForTooltip(browser && browser.files, status);
        updateRetryFailedButton(browser && browser.files);
        document.getElementById('kpiBar').classList.remove('hidden');
    } catch (err) {
        console.warn('KPI paint failed', err);
    }
}

// Hook into completion: extend the existing onConversionComplete if it exists
const _prevComplete = window.onConversionComplete;
window.onConversionComplete = function () {
    swapToConvertButton();
    paintKpiBar();
    if (_prevComplete) {
        try { _prevComplete(); } catch {}
    }
};

window.stopConversion = stopConversion;

// --- Details drawer: per-file timeline view ------------------------------
let fileTimings = {}; // fileId -> { startedAt, endedAt, state }

function recordFileStateForDetails(fileStates, currentFiles) {
    const now = Date.now();
    Object.entries(fileStates).forEach(([id, state]) => {
        if (!fileTimings[id]) fileTimings[id] = {};
        const t = fileTimings[id];
        if (state === 'active' && !t.startedAt) t.startedAt = now;
        if ((state === 'done' || state === 'failed' || state === 'skipped') && t.startedAt && !t.endedAt) {
            t.endedAt = now;
        }
        t.state = state;
    });
    renderDetailsFiles();
}

function renderDetailsFiles() {
    // Old basic renderer is now a no-op — replaced by renderDetailsFilesRich.
    // Kept as a stub so older wraps that call it don't crash.
    if (typeof renderDetailsFilesRich === 'function') renderDetailsFilesRich();
}

// Hook the existing graph state updates so the details list also updates
const _origApplyStates = window.cobolGraph && window.cobolGraph.applyStates;
function wrapGraphForDetails() {
    if (!window.cobolGraph) return;
    const orig = window.cobolGraph.applyStates;
    if (orig._wrapped) return;
    window.cobolGraph.applyStates = function (fileStates, currentFiles) {
        orig.call(this, fileStates, currentFiles);
        recordFileStateForDetails(fileStates, currentFiles);
    };
    window.cobolGraph.applyStates._wrapped = true;
}

// Tab switching for the chat panel (Chat / Files / Stream)
document.addEventListener('click', (e) => {
    if (!e.target.classList || !e.target.classList.contains('chat-tab')) return;
    const tab = e.target.dataset.chatTab;
    document.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t.dataset.chatTab === tab));
    document.querySelectorAll('.chat-tab-panel').forEach(p => {
        const map = { files: 'chatTabFiles', stream: 'chatTabStream', history: 'chatTabHistory' };
        p.classList.toggle('active', p.id === map[tab]);
    });
});

// Reset timings on new conversion
const _prevSwap = window.swapToConvertButton;
const _origActuallyStart = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    fileTimings = {};
    renderDetailsFiles();
    setTimeout(wrapGraphForDetails, 100);
    return _origActuallyStart.apply(this, args);
};

// whiteLabel → public/js/helpers.js
window.whiteLabel = whiteLabel;

// --- Active-file breadcrumb in header ------------------------------------
function updateBreadcrumb(currentFiles, isCompleted) {
    const wrap = document.getElementById('activeFileBreadcrumb');
    const nameEl = document.getElementById('activeFileName');
    const extraEl = document.getElementById('activeFileExtra');
    if (!wrap) return;
    if (isCompleted || !currentFiles || currentFiles.length === 0) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    const first = currentFiles[0].split('/').pop();
    if (nameEl) nameEl.textContent = first;
    if (extraEl) extraEl.textContent = currentFiles.length > 1 ? `+${currentFiles.length - 1} more` : '';
}

// --- HITL queue badge on the Human review pill ---------------------------
function updateReviewQueueBadge(awaitingCount) {
    const badge = document.getElementById('reviewQueueBadge');
    if (!badge) return;
    if (!awaitingCount || awaitingCount === 0) {
        badge.classList.add('hidden');
        badge.textContent = '0';
    } else {
        badge.classList.remove('hidden');
        badge.textContent = String(awaitingCount);
    }
}

// showToast → public/js/dialogs.js
window.showToast = showToast;

// Wrap the existing graph state updates so the breadcrumb + queue badge update too
(function wrapGraphForHeaderState() {
    const tryWrap = () => {
        if (!window.cobolGraph || !window.cobolGraph.applyStates) return setTimeout(tryWrap, 200);
        const orig = window.cobolGraph.applyStates;
        if (orig._hdrWrapped) return;
        window.cobolGraph.applyStates = function (fileStates, currentFiles) {
            orig.call(this, fileStates, currentFiles);
            updateBreadcrumb(currentFiles, false);
            // Compute awaiting count for badge
            let awaiting = 0;
            for (const v of Object.values(fileStates || {})) if (v === 'awaiting_review') awaiting++;
            updateReviewQueueBadge(awaiting);
        };
        window.cobolGraph.applyStates._hdrWrapped = true;
    };
    tryWrap();
})();

// Hook completion: hide breadcrumb, fire toast
const _origComplete2 = window.onConversionComplete;
window.onConversionComplete = async function () {
    updateBreadcrumb([], true);
    updateReviewQueueBadge(0);
    if (_origComplete2) {
        try { _origComplete2(); } catch {}
    }
    // Fetch final result for the toast
    try {
        const r = await fetch(`/api/status/${currentConversionId}`);
        const d = await r.json();
        const res = d.result || {};
        const total = res.totalFiles || 0;
        const ok = res.converted || 0;
        const acc = ((res.report && res.report.summary) || {}).averageAccuracy || 0;
        const failed = res.skippedError || 0;
        const kind = failed > 0 ? 'warning' : (ok === 0 ? 'error' : 'success');
        // Single-line toast: title + summary on one friendly line.
        const summary = `${ok}/${total} converted - ${acc}% avg accuracy` + (failed > 0 ? ` - ${failed} failed` : '');
        toast(`Conversion complete — ${summary}`, kind, 5000);
    } catch {}
};

// HITL review-chat cluster → public/js/review-chat.js (loaded AFTER app.js)


// --- Run program (COBOL + Java side by side) -----------------------------
async function runSelectedFile() {
    if (!currentBrowserFile || !currentConversionId) return;
    const file = currentBrowserFile;
    const panel = document.getElementById('runOutputPanel');
    const fileLabel = document.getElementById('runOutputFile');
    const cobolEl = document.getElementById('runCobolOutput');
    const javaEl = document.getElementById('runJavaOutput');
    const cobolMeta = document.getElementById('runCobolMeta');
    const javaMeta = document.getElementById('runJavaMeta');
    const runBtn = document.getElementById('runBtn');

    if (panel) panel.classList.remove('hidden');
    if (fileLabel) fileLabel.textContent = file.cobolPath;
    if (cobolEl) cobolEl.querySelector('code').textContent = 'Running…';
    if (javaEl) javaEl.querySelector('code').textContent = 'Running…';
    if (cobolMeta) cobolMeta.textContent = '';
    if (javaMeta) javaMeta.textContent = '';
    if (runBtn) { runBtn.disabled = true; runBtn.querySelector('.btn-text') ? runBtn.querySelector('.btn-text').textContent = 'Running…' : runBtn.textContent = 'Running…'; }

    // Grab the stdin the user typed (if any). The server accepts commas +
    // literal "\n" as line separators and always pads with exit-ish values
    // (4 / q / 0 / n) to keep stuck programs from looping forever; we just
    // forward whatever the user typed verbatim.
    const stdinField = document.getElementById('runInputField');
    const userStdin = stdinField ? stdinField.value : '';

    try {
        const r = await fetch(`/api/run/${currentConversionId}/${encodeURIComponent(file.cobolPath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: userStdin })
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (cobolEl) cobolEl.querySelector('code').textContent = '[Run failed: ' + (err.error || r.status) + ']';
            if (javaEl) javaEl.querySelector('code').textContent = '[Run failed]';
            return;
        }
        const data = await r.json();
        // COBOL pane
        if (data.cobol) {
            if (data.cobol.error) {
                cobolEl.querySelector('code').textContent = data.cobol.error;
                cobolEl.parentElement.classList.add('failed');
                cobolMeta.textContent = 'unavailable';
            } else {
                cobolEl.querySelector('code').textContent = data.cobol.output;
                cobolEl.parentElement.classList.remove('failed');
                cobolMeta.textContent = `exit ${data.cobol.exitCode} - ${data.cobol.duration}ms`;
            }
            // Render the one-click typo-fix affordance when the server
            // has a structured suggestion — pairs with the text hint
            // already in data.cobol.error.
            renderCobolTypoFixButton(data.cobol.typoFix, file.cobolPath);
        }
        // Java pane
        if (data.java) {
            if (data.java.error && !data.java.output) {
                javaEl.querySelector('code').textContent = data.java.error;
                javaEl.parentElement.classList.add('failed');
                javaMeta.textContent = 'failed';
            } else {
                javaEl.querySelector('code').textContent = data.java.output;
                javaEl.parentElement.classList.remove('failed');
                javaMeta.textContent = `exit ${data.java.exitCode} - ${data.java.duration}ms`;
            }
        }
        // Render any program-written output files (PRTLINE, REPORT, REPOUT,
        // etc.). Many COBOL programs write their real output to a FILE via
        // WRITE statements, so stdout looks empty while the actual report
        // sits in the work dir. Showing these here is how users see the
        // real business output of both sides side-by-side.
        renderRunOutputFiles(data);
        // Show the effective stdin so the user can diagnose unexpected
        // loops / wrong menu paths (§19). Server sends { user, padded }
        // — user is what the user typed, padded is what we actually fed
        // to both programs (user + default exit values).
        renderEffectiveStdin(data.effectiveStdin);

        // Surface obvious divergence between COBOL and Java outputs so the user
        // knows when the Java is fabricating behavior (simulated CALLs, invented
        // HTTP handling, fake data) instead of matching the source program.
        renderRunDivergenceBanner(data);
    } catch (err) {
        if (cobolEl) cobolEl.querySelector('code').textContent = '[Network error]';
        if (javaEl) javaEl.querySelector('code').textContent = err.message;
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            const t = runBtn.querySelector('.btn-text');
            if (t) t.textContent = 'Run program';
            else runBtn.textContent = 'Run program';
        }
    }
}

// Render program-written output files (PRTLINE, REPORT, etc.) below the
// stdout panes. Many COBOL programs write to files via WRITE rather than
// DISPLAY to stdout; without this panel the Run view looks empty when the
// program actually produced a real report.
/**
 * One-click COBOL typo fix. Shown under the COBOL pane when cobc flagged
 * an undefined identifier and our hinter (curated dictionary or edit-
 * distance) proposed a canonical replacement. Click → POST /api/fix-cobol
 * → toast → re-Run so the user sees the fix land.
 */
function renderCobolTypoFixButton(typoFix, cobolPath) {
    const panel = document.getElementById('runOutputPanel');
    if (!panel) return;
    panel.querySelectorAll('.cobol-typo-fix-bar').forEach(n => n.remove());
    if (!typoFix || !typoFix.bad || !typoFix.suggestion) return;

    const bar = document.createElement('div');
    bar.className = 'cobol-typo-fix-bar';
    const source = typoFix.source === 'dictionary'
        ? 'known typo (vetted mapping)'
        : 'suggested by fuzzy match against declared identifiers';
    bar.innerHTML = `
        <div class="cobol-typo-fix-text">
            Suggested fix: <code>${escapeHtml(typoFix.bad)}</code> → <code>${escapeHtml(typoFix.suggestion)}</code>
            <span class="cobol-typo-fix-source">(${escapeHtml(source)})</span>
        </div>
        <button class="btn-pill btn-sm cobol-typo-fix-apply">Apply &amp; re-run</button>
    `;
    bar.querySelector('.cobol-typo-fix-apply').addEventListener('click', async () => {
        await applyCobolTypoFix(typoFix.bad, typoFix.suggestion, cobolPath);
    });
    panel.appendChild(bar);
}

async function applyCobolTypoFix(bad, suggestion, cobolPath) {
    if (!currentConversionId || !cobolPath) return;
    const ok = await confirmDialog(
        `Rewrite every occurrence of \`${bad}\` to \`${suggestion}\` in ${cobolPath.split('/').pop()}?\n\n` +
        `A backup is saved alongside the source; Undo from the Run panel afterwards.`,
        { title: 'Apply COBOL fix', okText: 'Apply', danger: false }
    );
    if (!ok) return;
    try {
        const r = await fetch(`/api/fix-cobol/${currentConversionId}/${encodeURIComponent(cobolPath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bad, suggestion })
        });
        const data = await r.json();
        if (!r.ok || !data.ok) {
            toast('Fix failed: ' + (data.error || r.status), 'error');
            return;
        }
        toast(`Rewrote ${data.replacements} occurrence${data.replacements === 1 ? '' : 's'}. Re-running…`, 'success');
        // Re-run so the user sees whether the fix actually cleared the
        // compile error. The stdin input is preserved (we don't touch it).
        runSelectedFile();
    } catch (err) {
        toast('Fix failed: ' + err.message, 'error');
    }
}
window.applyCobolTypoFix = applyCobolTypoFix;

/**
 * Surface the effective stdin the server fed to both programs. The user
 * typed "1,4" and the server turned it into "1\n4\n4\n4\n4\nq\n0\nn\n"
 * (user + the exit-value padding) — showing both sides explains why a
 * COBOL menu program walked through several extra prompts after the
 * intended answer. §19.
 *
 * Renders as a <details> so it doesn't compete for screen real estate
 * with the actual output. No-op when both fields are empty.
 */
function renderEffectiveStdin(eff) {
    const panel = document.getElementById('runOutputPanel');
    if (!panel) return;
    panel.querySelectorAll('.run-effective-stdin').forEach(n => n.remove());
    if (!eff) return;
    const user = eff.user || '';
    const padded = eff.padded || '';
    if (!padded) return;

    const wrap = document.createElement('details');
    wrap.className = 'run-effective-stdin';
    wrap.style.cssText = 'margin: .5rem .75rem 0; font-size: .8rem; color: var(--text-muted, #888);';
    const summary = document.createElement('summary');
    summary.textContent = user
        ? `stdin fed (your "${user.replace(/\n/g, '\\n').slice(0, 40)}" + default exit values)`
        : 'stdin fed (default exit values only — type above for custom input)';
    summary.style.cssText = 'cursor: pointer;';
    wrap.appendChild(summary);

    const pre = document.createElement('pre');
    pre.style.cssText = 'margin: .4rem 0 0; padding: .5rem .7rem; background: var(--c-bg-elevated, rgba(0,0,0,.15)); border-radius: 4px; white-space: pre-wrap; word-break: break-all; font-size: .75rem;';
    // Show explicit newlines so the user can see exactly where line breaks land.
    pre.textContent = padded.replace(/\n/g, '↵\n');
    wrap.appendChild(pre);
    panel.appendChild(wrap);
}

function renderRunOutputFiles(data) {
    const panel = document.getElementById('runOutputPanel');
    if (!panel) return;
    // Remove any previous output-files block.
    panel.querySelectorAll('.run-output-files').forEach(n => n.remove());

    const cobolFiles = (data.cobol && data.cobol.outputFiles) || [];
    const javaFiles  = (data.java  && data.java.outputFiles)  || [];
    if (cobolFiles.length === 0 && javaFiles.length === 0) return;

    const container = document.createElement('div');
    container.className = 'run-output-files';
    container.innerHTML = `
        <div class="run-output-files-header">
            <span class="run-output-files-title"> Program-written output files</span>
            <span class="run-output-files-hint">COBOL WRITE / Java <code>BufferedWriter</code> — not in stdout</span>
        </div>
        <div class="run-output-files-grid"></div>
    `;
    const grid = container.querySelector('.run-output-files-grid');

    const renderSide = (label, files, sideClass) => {
        const col = document.createElement('div');
        col.className = 'run-output-files-col ' + sideClass;
        col.innerHTML = `<div class="run-output-files-side-label">${label}</div>`;
        if (!files.length) {
            const empty = document.createElement('div');
            empty.className = 'run-output-files-empty';
            empty.textContent = '(no output files written)';
            col.appendChild(empty);
        } else {
            for (const f of files) {
                const item = document.createElement('details');
                item.className = 'run-output-file';
                const kb = (f.bytes / 1024).toFixed(1);
                item.innerHTML = `
                    <summary>
                        <span class="of-name">${escapeHtml(f.name)}</span>
                        <span class="of-size">${kb} KB</span>
                    </summary>
                    <pre class="of-body"><code></code></pre>
                `;
                item.querySelector('code').textContent = f.contentPreview || '(empty)';
                // Expand the first file by default so the user sees something immediately.
                if (files.indexOf(f) === 0) item.setAttribute('open', '');
                col.appendChild(item);
            }
        }
        grid.appendChild(col);
    };
    renderSide('COBOL wrote', cobolFiles, 'cobol-side');
    renderSide('Java wrote',  javaFiles,  'java-side');
    panel.appendChild(container);
}

// Show an AI-powered verdict comparing the COBOL and Java run outputs.
// Regex heuristics can't anticipate the N possible output shapes, so we ask
// the agent to decide if the two programs are behaving equivalently.
// The banner updates as soon as the AI responds (non-blocking).
async function renderRunDivergenceBanner(data) {
    const panel = document.getElementById('runOutputPanel');
    if (!panel) return;
    panel.querySelectorAll('.run-diverge-banner').forEach(n => n.remove());

    // Only run the comparison if we have something to compare. If either side
    // didn't run at all, skip the banner.
    if (!data.cobol || !data.java) return;
    if (!data.cobol.output && !data.java.output) return;

    // Placeholder while the AI is thinking — so the user knows we're analyzing.
    const placeholder = document.createElement('div');
    placeholder.className = 'run-diverge-banner run-diverge-info';
    placeholder.innerHTML = `<strong>Analyzing outputs…</strong><br><span class="subtle">AI is comparing the COBOL and Java runs.</span>`;
    const grid = panel.querySelector('.run-output-grid');
    if (grid) panel.insertBefore(placeholder, grid);
    else panel.appendChild(placeholder);

    const fileName = (currentBrowserFile && currentBrowserFile.cobolPath) || '';

    let verdict;
    try {
        const r = await fetch('/api/compare-runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cobolOutput: data.cobol.output || '',
                javaOutput:  data.java.output  || '',
                // Compile/runtime error strings matter — without them the AI
                // can't tell "COBOL compile failed" from "COBOL ran silently".
                cobolError:  data.cobol.error  || '',
                javaError:   data.java.error   || '',
                cobolExit:   data.cobol.exitCode,
                javaExit:    data.java.exitCode,
                cobolTimedOut: !!data.cobol.timedOut,
                javaTimedOut:  !!data.java.timedOut,
                fileName,
                // Identify the converted file so the backend can read source
                // straight from disk — lets the comparator reason about DISPLAY
                // statements and computations, not just output strings.
                conversionId: currentConversionId || undefined,
                relativePath: (currentBrowserFile && currentBrowserFile.cobolPath) || undefined
            })
        });
        verdict = await r.json();
    } catch (err) {
        verdict = {
            verdict: 'unknown', severity: 'info',
            title: 'Comparison unavailable',
            reasons: [err.message || 'Network error']
        };
    }

    // Refresh the banner — the placeholder may have been removed if the user
    // ran again; re-query the panel each time.
    const stillPanel = document.getElementById('runOutputPanel');
    if (!stillPanel) return;
    stillPanel.querySelectorAll('.run-diverge-banner').forEach(n => n.remove());

    const icon =
        verdict.severity === 'ok'      ? 'OK' :
        verdict.severity === 'warning' ? '[warn]' :
        verdict.severity === 'error'   ? 'x' :
                                          'i';

    const banner = document.createElement('div');
    banner.className = 'run-diverge-banner run-diverge-' + (verdict.severity || 'info');
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
    let html = `<strong>${icon} ${(verdict.title || 'Comparison').replace(/</g, '&lt;')}</strong>`;
    if (reasons.length > 0) {
        html += '<br>' + reasons
            .map(r => `- ${String(r).replace(/</g, '&lt;')}`)
            .join('<br>');
    }
    banner.innerHTML = html;
    const grid2 = stillPanel.querySelector('.run-output-grid');
    if (grid2) stillPanel.insertBefore(banner, grid2);
    else stillPanel.appendChild(banner);
}

function closeRunOutput() {
    const panel = document.getElementById('runOutputPanel');
    if (panel) panel.classList.add('hidden');
}

window.runSelectedFile = runSelectedFile;
window.closeRunOutput = closeRunOutput;

// --- Dependency intelligence helpers -------------------------------------
function gDeps() {
    return (window.cobolGraph && window.cobolGraph.rawGraph) || { nodes: [], edges: [] };
}

// Files this file depends on (calls/copies)
function getDependencies(fileId) {
    const g = gDeps();
    return g.edges.filter(e => e.source === fileId).map(e => ({ id: e.target, kind: e.kind }));
}
// Files that depend on this file (its callers / copy parents)
function getDependents(fileId) {
    const g = gDeps();
    return g.edges.filter(e => e.target === fileId).map(e => ({ id: e.source, kind: e.kind }));
}
// True if no other program calls this one (it's a runnable entry point)
function isEntryPoint(fileId) {
    const g = gDeps();
    return !g.edges.some(e => e.target === fileId && e.kind === 'call');
}
// Returns the dependencies (call edges only) that are still blocking.
// A dep is blocking ONLY if it's still 'pending' or 'awaiting_review'.
// 'active' = approved and being written to disk → not blocking.
// 'done' / 'skipped' / 'failed' = user has moved past it → not blocking.
function getBlockingDeps(fileId) {
    const states = (window.cobolGraph && window.cobolGraph.fileStates) || {};
    return getDependencies(fileId)
        .filter(d => d.kind === 'call')
        .filter(d => {
            const s = states[d.id];
            return s === 'pending' || s === 'awaiting_review';
        });
}
// Lookup helper for label
function nodeLabel(fileId) {
    const g = gDeps();
    const n = g.nodes.find(x => x.id === fileId);
    return n ? n.label : fileId.split('/').pop();
}

// --- Rich Files-tab renderer (overrides the basic one) ------------------
// Reads from multiple sources to be resilient: prefers the live graph state,
// falls back to fileTimings, then to whatever the rawGraph nodes list shows.
function renderDetailsFilesRich(maybeStates) {
    const list = document.getElementById('detailsFilesList');
    if (!list) return;
    // Source 1: explicit arg (passed from a wrap)
    let states = maybeStates && Object.keys(maybeStates).length ? maybeStates : null;
    // Source 2: cobolGraph getter
    if (!states) {
        const fromGraph = (window.cobolGraph && window.cobolGraph.fileStates) || null;
        if (fromGraph && Object.keys(fromGraph).length) states = fromGraph;
    }
    // Source 3: derive from fileTimings (the older state map)
    if (!states && typeof fileTimings === 'object' && Object.keys(fileTimings).length) {
        states = {};
        Object.entries(fileTimings).forEach(([id, t]) => { states[id] = t.state || 'pending'; });
    }
    // Source 4: derive from raw graph node list (everything pending)
    if (!states) {
        const raw = (window.cobolGraph && window.cobolGraph.rawGraph) || null;
        if (raw && raw.nodes && raw.nodes.length) {
            states = {};
            raw.nodes.forEach(n => { states[n.id] = 'pending'; });
        }
    }
    if (!states || Object.keys(states).length === 0) {
        list.innerHTML = '<div class="empty-state">Per-file activity will appear here once a conversion starts. Click any amber node on the graph to review its conversion.</div>';
        return;
    }
    const ids = Object.keys(states);

    // Order: awaiting_review first, then active, then pending, then failed, then done, then skipped
    const ORDER = ['awaiting_review', 'active', 'pending', 'failed', 'done', 'skipped'];
    const sorted = ids.slice().sort((a, b) => {
        const ai = ORDER.indexOf(states[a]);
        const bi = ORDER.indexOf(states[b]);
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
    });

    list.innerHTML = sorted.map(id => {
        const state = states[id];
        const label = nodeLabel(id);
        const t = fileTimings[id] || {};
        const dur = (t.startedAt && t.endedAt)
            ? ((t.endedAt - t.startedAt) / 1000).toFixed(1) + 's'
            : (state === 'active' ? '…' : '');

        const deps = getDependencies(id).filter(d => d.kind === 'call');
        const blockers = getBlockingDeps(id);
        const dependents = getDependents(id).filter(d => d.kind === 'call');
        const isEntry = isEntryPoint(id);

        let intel = '';
        if (state === 'awaiting_review' && blockers.length > 0) {
            intel = `<div class="detail-intel blocked">Approve first: ${blockers.map(b => `<code>${escapeHtml(nodeLabel(b.id))}</code>`).join(', ')}</div>`;
        } else if (state === 'awaiting_review' && blockers.length === 0) {
            intel = `<div class="detail-intel ready">Ready to approve${dependents.length ? ` - unblocks ${dependents.length} file${dependents.length === 1 ? '' : 's'}` : ''}</div>`;
        } else if (state === 'pending' && deps.length > 0) {
            intel = `<div class="detail-intel waits">Waiting on ${deps.length} dep${deps.length === 1 ? '' : 's'}</div>`;
        } else if (state === 'done' && dependents.length > 0) {
            intel = `<div class="detail-intel unblocks">Unblocks ${dependents.length} dependent${dependents.length === 1 ? '' : 's'}</div>`;
        } else if (state === 'pending' && isEntry) {
            intel = `<div class="detail-intel entry">Entry point</div>`;
        }

        const icon = ({
            'active': '', 'done': 'OK', 'failed': 'FAIL', 'skipped': '-',
            'awaiting_review': '', 'pending': '-'
        })[state] || '-';

        return `<div class="detail-file ${state}" data-file-id="${escapeHtml(id)}">
            <div class="detail-row-main">
                <span class="detail-icon">${icon}</span>
                <span class="detail-name" title="${escapeHtml(id)}">${escapeHtml(label)}${isEntry ? ' <span class="entry-badge" title="Entry point — runnable program">main</span>' : ''}</span>
                <span class="detail-state">${state.replace('_', ' ')}</span>
                ${dur ? `<span class="detail-dur">${dur}</span>` : ''}
            </div>
            ${intel}
        </div>`;
    }).join('');

    // Wire click → open review modal if awaiting_review
    list.querySelectorAll('.detail-file.awaiting_review').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
            const fid = el.dataset.fileId;
            openReviewModal(fid, nodeLabel(fid));
        });
    });
}

// Replace the simple renderer with the rich one whenever states update
window.renderDetailsFiles = renderDetailsFilesRich;
// Also re-render when graph state changes (re-wrap applyStates) — pass fileStates
// directly so we don't depend on the cobolGraph getter being populated.
(function wrapForRichRender() {
    const tryWrap = () => {
        if (!window.cobolGraph || !window.cobolGraph.applyStates) return setTimeout(tryWrap, 200);
        const orig = window.cobolGraph.applyStates;
        if (orig._richWrapped) return;
        window.cobolGraph.applyStates = function (fileStates, currentFiles) {
            orig.call(this, fileStates, currentFiles);
            renderDetailsFilesRich(fileStates);
        };
        window.cobolGraph.applyStates._richWrapped = true;
    };
    tryWrap();
})();
// Also force a render right after onConversionComplete fires + auto-switch to Files tab
const _origCompleteForRich = window.onConversionComplete;
window.onConversionComplete = async function () {
    if (_origCompleteForRich) {
        try { await _origCompleteForRich(); } catch {}
    }
    // One last render to make sure final states are visible in the Files tab
    setTimeout(() => renderDetailsFilesRich(), 50);
    setTimeout(() => renderDetailsFilesRich(), 500);

    // Auto-activate the Files tab so the user sees the per-file results immediately
    setTimeout(() => {
        document.querySelectorAll('.chat-tab').forEach(t =>
            t.classList.toggle('active', t.dataset.chatTab === 'files'));
        document.querySelectorAll('.chat-tab-panel').forEach(p =>
            p.classList.toggle('active', p.id === 'chatTabFiles'));
        // Scroll the activity panel into view if it's below the fold
        const panel = document.getElementById('reviewChatPanel');
        if (panel) {
            const rect = panel.getBoundingClientRect();
            const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
            if (!visible) {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
        // Pulse the panel briefly to draw attention
        if (panel) {
            panel.classList.add('panel-pulse');
            setTimeout(() => panel.classList.remove('panel-pulse'), 1800);
        }
    }, 100);
};

// --- Run button: gate to entry points only -------------------------------
// Make sure rawGraph is loaded — fall back to a fresh fetch if it isn't.
async function ensureGraphLoaded() {
    if (window.cobolGraph && window.cobolGraph.rawGraph && window.cobolGraph.rawGraph.nodes && window.cobolGraph.rawGraph.nodes.length) return;
    if (!currentConversionId) return;
    try {
        const r = await fetch(`/api/graph/${currentConversionId}?full=1`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.graph && window.cobolGraph) {
            // Manually stash via the IIFE-private setter — hack: refresh raw graph
            // by invoking applyStates which sets it. Instead, we re-call load which is safer.
            window._fallbackRawGraph = d.graph;
        }
    } catch {}
}
// Patch gDeps to also consider _fallbackRawGraph
const _origGDeps = gDeps;
gDeps = function () {
    if (window.cobolGraph && window.cobolGraph.rawGraph && window.cobolGraph.rawGraph.nodes && window.cobolGraph.rawGraph.nodes.length) {
        return window.cobolGraph.rawGraph;
    }
    if (window._fallbackRawGraph) return window._fallbackRawGraph;
    return { nodes: [], edges: [] };
};
window.gDeps = gDeps;

const _origSelectBrowserFile = selectBrowserFile;
selectBrowserFile = async function (file, el) {
    await _origSelectBrowserFile.call(this, file, el);
    const runBtn = document.getElementById('runBtn');
    if (!runBtn || !file) return;

    // Always ensure we have fresh graph data before deciding
    await ensureGraphLoaded();

    if (file.status !== 'SUCCESS' || !file.javaPath) {
        runBtn.disabled = true;
        runBtn.title = 'This file was not converted successfully';
        return;
    }
    const entry = isEntryPoint(file.cobolPath);
    const callers = getDependents(file.cobolPath).filter(d => d.kind === 'call').map(d => nodeLabel(d.id));
    console.log('[runGate]', file.cobolPath, 'entry=', entry, 'callers=', callers);

    if (!entry) {
        runBtn.disabled = true;
        runBtn.title = callers.length
            ? 'This is a subroutine called by: ' + callers.join(', ') + '. Run its main program instead.'
            : 'This file is not a runnable entry point.';
    } else {
        runBtn.disabled = false;
        runBtn.title = 'Run COBOL and Java side by side';
    }
};

// --- Review modal: gate Approve when dependencies are blocking ----------
// Recomputes the banner + button enabled state for the file currently in the modal.
// Called once on open AND on every state poll while the modal is visible, so an
// approval elsewhere immediately unblocks the open modal.
function refreshReviewBlockerBanner() {
    const modal = document.getElementById('reviewModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (!currentReviewFileId) return;
    const actions = document.querySelector('.review-actions');
    if (!actions) return;

    const blockers = getBlockingDeps(currentReviewFileId);
    let banner = actions.parentElement.querySelector('.review-blocker-banner');
    if (banner) banner.remove();

    if (blockers.length > 0) {
        const list = blockers.map(b => `<code>${escapeHtml(nodeLabel(b.id))}</code>`).join(', ');
        banner = document.createElement('div');
        banner.className = 'review-blocker-banner';
        banner.innerHTML = `<strong>Hold on:</strong> approve these dependencies first — ${list}. They're called by this file and should be reviewed in order.`;
        actions.parentElement.insertBefore(banner, actions);
        actions.querySelectorAll('.btn-pill').forEach(btn => {
            const t = (btn.textContent || '').toLowerCase();
            if (t.includes('approve') || t.includes('save')) {
                btn.disabled = true;
                btn.title = 'Approve dependencies first';
            }
        });
    } else {
        // No blockers — re-enable approve/save buttons
        actions.querySelectorAll('.btn-pill').forEach(btn => {
            const t = (btn.textContent || '').toLowerCase();
            if (t.includes('approve') || t.includes('save')) {
                btn.disabled = false;
                btn.title = '';
            }
        });
    }
}
window.refreshReviewBlockerBanner = refreshReviewBlockerBanner;

const _origOpenReviewModal = openReviewModal;
openReviewModal = async function (fileId, label) {
    await _origOpenReviewModal.call(this, fileId, label);
    refreshReviewBlockerBanner();
};
window.openReviewModal = openReviewModal;

// Re-check on every graph state poll so the banner clears as soon as the
// blocking dependency reaches a non-blocking state.
(function wrapApplyStatesForBanner() {
    const tryWrap = () => {
        if (!window.cobolGraph || !window.cobolGraph.applyStates) return setTimeout(tryWrap, 200);
        const orig = window.cobolGraph.applyStates;
        if (orig._bannerWrapped) return;
        window.cobolGraph.applyStates = function (fileStates, currentFiles) {
            orig.call(this, fileStates, currentFiles);
            refreshReviewBlockerBanner();
        };
        window.cobolGraph.applyStates._bannerWrapped = true;
    };
    tryWrap();
})();

// --- Right drawer (Activity / Stream / History) --------------------------
function toggleRightDrawer() {
    const d = document.getElementById('rightDrawer');
    const btn = document.getElementById('drawerToggleBtn');
    if (!d) return;
    d.classList.toggle('hidden');
    const isOpen = !d.classList.contains('hidden');
    if (btn) btn.classList.toggle('active', isOpen);
    // Flip the always-visible handle: `<` = open (click to close),
    // `>` = closed (click to open). Mirrors the common drawer idiom.
    const handle = document.getElementById('drawerHandle');
    const glyph = document.getElementById('drawerHandleGlyph');
    if (glyph) glyph.textContent = isOpen ? '>' : '<';
    if (handle) {
        handle.classList.toggle('drawer-open', isOpen);
        handle.title = isOpen ? 'Hide activity drawer' : 'Show activity drawer';
    }
    if (isOpen) {
        // Reset attention badge when opened
        const badge = document.getElementById('drawerBadge');
        if (badge) { badge.classList.add('hidden'); badge.textContent = '0'; }
    }
}
window.toggleRightDrawer = toggleRightDrawer;

function bumpDrawerBadge() {
    const d = document.getElementById('rightDrawer');
    if (!d || !d.classList.contains('hidden')) return; // only when drawer is closed
    const badge = document.getElementById('drawerBadge');
    if (!badge) return;
    const n = parseInt(badge.textContent || '0', 10) + 1;
    badge.textContent = String(n);
    badge.classList.remove('hidden');
}

// Auto-open drawer when conversion starts
const _origActuallyStartForDrawer = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    const d = document.getElementById('rightDrawer');
    if (d) d.classList.remove('hidden');
    const btn = document.getElementById('drawerToggleBtn');
    if (btn) btn.classList.add('active');
    return _origActuallyStartForDrawer.apply(this, args);
};

// --- History tab: poll review history + render ---------------------------
async function refreshHistoryTab() {
    if (!currentConversionId) return;
    const list = document.getElementById('historyList');
    if (!list) return;
    try {
        const r = await fetch(`/api/reviews/${currentConversionId}/history`);
        if (!r.ok) return;
        const data = await r.json();
        const history = data.history || [];
        if (history.length === 0) {
            list.innerHTML = '<div class="empty-state">Approve / edit / reject decisions will appear here as you review files.</div>';
            return;
        }
        // Newest first
        const items = history.slice().reverse();
        list.innerHTML = items.map(h => {
            const time = new Date(h.at).toLocaleTimeString();
            const action = h.action;
            const cls = action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'edit';
            const bulkTag = h.bulk ? ' <span class="hist-tag bulk">bulk</span>' : '';
            const note = h.note ? `<div class="hist-note">${escapeHtml(h.note)}</div>` : '';
            const name = (h.fileId || '').split('/').pop();
            return `<div class="hist-item ${cls}">
                <div class="hist-row">
                    <span class="hist-action">${action}</span>${bulkTag}
                    <span class="hist-name" title="${escapeHtml(h.fileId)}">${escapeHtml(name)}</span>
                    <span class="hist-time">${time}</span>
                </div>
                ${note}
            </div>`;
        }).join('');
    } catch { /* swallow */ }
}

// Re-poll history every 1.5s while a conversion is active
let historyTimer = null;
function startHistoryPolling() {
    if (historyTimer) clearInterval(historyTimer);
    historyTimer = setInterval(refreshHistoryTab, 1500);
    refreshHistoryTab();
}
function stopHistoryPolling() {
    if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
}
const _origCompleteForHistory = window.onConversionComplete;
window.onConversionComplete = async function () {
    if (_origCompleteForHistory) {
        try { await _origCompleteForHistory(); } catch {}
    }
    refreshHistoryTab(); // one final pull after completion
    setTimeout(stopHistoryPolling, 2000);
};
const _origStartForHistory = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    startHistoryPolling();
    return _origStartForHistory.apply(this, args);
};

// --- Custom input field: pass-through to /api/run ------------------------
const _origRunSelectedFile = runSelectedFile;
runSelectedFile = async function () {
    if (!currentBrowserFile || !currentConversionId) return;
    const file = currentBrowserFile;
    const inputField = document.getElementById('runInputField');
    const customInput = inputField ? inputField.value : '';
    const panel = document.getElementById('runOutputPanel');
    const fileLabel = document.getElementById('runOutputFile');
    const cobolEl = document.getElementById('runCobolOutput');
    const javaEl = document.getElementById('runJavaOutput');
    const cobolMeta = document.getElementById('runCobolMeta');
    const javaMeta = document.getElementById('runJavaMeta');
    const runBtn = document.getElementById('runBtn');

    if (panel) panel.classList.remove('hidden');
    if (fileLabel) fileLabel.textContent = file.cobolPath;
    if (cobolEl) cobolEl.querySelector('code').textContent = 'Running…';
    if (javaEl) javaEl.querySelector('code').textContent = 'Running…';
    if (cobolMeta) cobolMeta.textContent = '';
    if (javaMeta) javaMeta.textContent = '';
    if (runBtn) {
        runBtn.disabled = true;
        const t = runBtn.querySelector('.btn-text');
        if (t) t.textContent = 'Running…'; else runBtn.textContent = 'Running…';
    }

    try {
        const r = await fetch(`/api/run/${currentConversionId}/${encodeURIComponent(file.cobolPath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: customInput })
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (cobolEl) cobolEl.querySelector('code').textContent = '[Run failed: ' + (err.error || r.status) + ']';
            if (javaEl) javaEl.querySelector('code').textContent = '[Run failed]';
            return;
        }
        const data = await r.json();
        if (data.cobol) {
            if (data.cobol.error && !data.cobol.output) {
                cobolEl.querySelector('code').textContent = data.cobol.error;
                cobolEl.parentElement.classList.add('failed');
                cobolMeta.textContent = 'unavailable';
            } else {
                cobolEl.querySelector('code').textContent = data.cobol.output;
                cobolEl.parentElement.classList.remove('failed');
                cobolMeta.textContent = `exit ${data.cobol.exitCode} - ${data.cobol.duration}ms`;
            }
        }
        if (data.java) {
            if (data.java.error && !data.java.output) {
                javaEl.querySelector('code').textContent = data.java.error;
                javaEl.parentElement.classList.add('failed');
                javaMeta.textContent = 'failed';
            } else {
                javaEl.querySelector('code').textContent = data.java.output;
                javaEl.parentElement.classList.remove('failed');
                javaMeta.textContent = `exit ${data.java.exitCode} - ${data.java.duration}ms`;
            }
        }
        renderRunDivergenceBanner(data);
    } catch (err) {
        if (cobolEl) cobolEl.querySelector('code').textContent = '[Network error]';
        if (javaEl) javaEl.querySelector('code').textContent = err.message;
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            const t = runBtn.querySelector('.btn-text');
            if (t) t.textContent = 'Run program'; else runBtn.textContent = 'Run program';
        }
    }
};
window.runSelectedFile = runSelectedFile;

// =======================================================================
// Unified Details timeline — replaces Files/Stream/History tabs with
// one chronological feed of everything that happens during a conversion.
// =======================================================================
let timelineEvents = []; // [{ at, type, html }]
let lastLogLength = 0;
let lastHistoryLength = 0;
let timelineTimer = null;
let prevFileStatesSnapshot = {};

// Activity view mode + filter state. Both persist across reloads via
// localStorage so a user who prefers Grouped + Errors-only gets that
// back on the next page load.
let timelineViewMode = localStorage.getItem('tl_view') || 'grouped';
let timelineFilter   = localStorage.getItem('tl_filter') || 'all';

function tlPush(type, html, fileId) {
    const at = Date.now();
    timelineEvents.push({ at, type, html, fileId: fileId || null });
    renderTimeline();
    bumpDrawerBadge();
}

function renderTimeline() {
    const el = document.getElementById('detailsTimeline');
    if (!el) return;
    if (timelineEvents.length === 0) {
        el.innerHTML = '<div class="empty-state">Activity will appear here once a conversion starts.</div>';
        return;
    }
    // Render the control strip once; reuse on subsequent updates.
    const controls = `
        <div class="tl-controls">
            <div class="tl-view-toggle" role="tablist">
                <button class="tl-view-btn ${timelineViewMode === 'grouped' ? 'active' : ''}" onclick="setTimelineView('grouped')">Grouped</button>
                <button class="tl-view-btn ${timelineViewMode === 'stream'  ? 'active' : ''}" onclick="setTimelineView('stream')">Stream</button>
            </div>
            <div class="tl-filter-chips">
                <button class="tl-filter-chip ${timelineFilter === 'all'       ? 'active' : ''}" onclick="setTimelineFilter('all')">All</button>
                <button class="tl-filter-chip ${timelineFilter === 'inflight'  ? 'active' : ''}" onclick="setTimelineFilter('inflight')">In-flight</button>
                <button class="tl-filter-chip ${timelineFilter === 'errors'    ? 'active' : ''}" onclick="setTimelineFilter('errors')">Errors</button>
            </div>
        </div>
    `;
    if (timelineViewMode === 'stream') {
        el.innerHTML = controls + renderTimelineStream();
    } else {
        el.innerHTML = controls + renderTimelineGrouped();
    }
    // Grouped + stream views have opposite scroll affordances. Stream
    // auto-scrolls to bottom (latest-line-first reading); grouped is
    // user-navigable so we leave scroll alone.
    if (timelineViewMode === 'stream') el.scrollTop = el.scrollHeight;
}

/**
 * Flat stream view — the original rendering. Applies the current filter.
 */
function renderTimelineStream() {
    const visible = filterTimelineEvents(timelineEvents).slice(-200);
    return visible.map(e => {
        const time = new Date(e.at).toLocaleTimeString();
        return `<div class="tl-event tl-${e.type}">
            <span class="tl-time">${time}</span>
            <div class="tl-body">${e.html}</div>
        </div>`;
    }).join('');
}

/**
 * Group-by-file view (§24.8). One collapsible row per file showing:
 *   - latest state pill + duration since first event
 *   - event count
 *   Expand → full per-file history.
 * Non-file-scoped events (raw log lines) collapse into a single
 * "General" group at the top so they stay visible.
 */
function renderTimelineGrouped() {
    const filtered = filterTimelineEvents(timelineEvents);
    if (filtered.length === 0) {
        return '<div class="empty-state">No events match the current filter.</div>';
    }
    // Group events by fileId (null → "General"). Preserve insertion
    // order of first appearance so cards land in the order files
    // started processing.
    const byFile = new Map();
    for (const e of filtered) {
        const key = e.fileId || '__general__';
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(e);
    }

    const cards = [];
    // General (log) group first, if any.
    if (byFile.has('__general__')) {
        const events = byFile.get('__general__');
        cards.push(renderTimelineGroupCard('General', events, null));
        byFile.delete('__general__');
    }
    for (const [fileId, events] of byFile) {
        cards.push(renderTimelineGroupCard(fileId, events, fileId));
    }
    return cards.join('');
}

function renderTimelineGroupCard(title, events, fileId) {
    const last = events[events.length - 1];
    const first = events[0];
    const durationMs = last.at - first.at;
    const duration = durationMs > 0
        ? (durationMs < 1000 ? `${durationMs}ms` : durationMs < 60_000 ? `${Math.round(durationMs / 1000)}s` : `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`)
        : '';
    const latestTime = new Date(last.at).toLocaleTimeString();
    // Extract the latest "state pill" out of the body if it exists so
    // the collapsed header reads at a glance.
    const latestLabel = last.html.match(/class="tl-state-pill (\w+)">([^<]+)</);
    const latestPill = latestLabel
        ? `<span class="tl-state-pill ${latestLabel[1]}">${escapeHtml(latestLabel[2])}</span>`
        : `<span class="tl-state-pill log">latest</span>`;
    const fileShort = fileId ? fileId.split('/').pop() : title;

    const rows = events.map(e => {
        const time = new Date(e.at).toLocaleTimeString();
        return `<div class="tl-event tl-${e.type}">
            <span class="tl-time">${time}</span>
            <div class="tl-body">${e.html}</div>
        </div>`;
    }).join('');

    return `
        <details class="tl-group" ${events.length <= 3 ? 'open' : ''}>
            <summary class="tl-group-head">
                <span class="tl-group-name" title="${escapeHtml(fileId || title)}">${escapeHtml(fileShort)}</span>
                ${latestPill}
                <span class="tl-group-count">${events.length} event${events.length === 1 ? '' : 's'}</span>
                ${duration ? `<span class="tl-group-duration">${duration}</span>` : ''}
                <span class="tl-group-time">${latestTime}</span>
            </summary>
            <div class="tl-group-events">${rows}</div>
        </details>`;
}

function filterTimelineEvents(events) {
    if (timelineFilter === 'all') return events;
    if (timelineFilter === 'errors') {
        // Match on the classes we emit for failed / rejected / compile
        // errors + any explicit error-marker text.
        return events.filter(e =>
            /tl-state-pill (failed|reject|compile-fail)|error/i.test(e.html));
    }
    if (timelineFilter === 'inflight') {
        // In-flight = latest event for this file shows active / awaiting_review.
        // Compute the LAST event per file; include only events belonging to
        // files whose last event is in-flight. For unfiled (log) events we
        // just include those when the conversion is still running.
        const lastByFile = new Map();
        for (const e of events) {
            const key = e.fileId || '__general__';
            lastByFile.set(key, e);
        }
        const inflightKeys = new Set();
        for (const [k, e] of lastByFile) {
            if (/tl-state-pill (active|awaiting_review)/.test(e.html)) inflightKeys.add(k);
        }
        return events.filter(e => inflightKeys.has(e.fileId || '__general__'));
    }
    return events;
}

function setTimelineView(mode) {
    timelineViewMode = mode;
    localStorage.setItem('tl_view', mode);
    renderTimeline();
}
window.setTimelineView = setTimelineView;

function setTimelineFilter(f) {
    timelineFilter = f;
    localStorage.setItem('tl_filter', f);
    renderTimeline();
}
window.setTimelineFilter = setTimelineFilter;

function resetTimeline() {
    timelineEvents = [];
    lastLogLength = 0;
    lastHistoryLength = 0;
    prevFileStatesSnapshot = {};
    window._filePhaseTracker = {};
    // Also clear the raw logs output so old text doesn't leak into the new run
    const logsEl = document.getElementById('logsOutput');
    if (logsEl) logsEl.textContent = '';
    renderTimeline();
}

// Poll: scrape new log lines, file state changes, review history into the timeline
function pollTimeline() {
    if (!currentConversionId) return;

    // 1. New log lines
    const logsEl = document.getElementById('logsOutput');
    if (logsEl) {
        const text = logsEl.textContent || '';
        if (text.length > lastLogLength) {
            const newText = text.slice(lastLogLength).trim();
            lastLogLength = text.length;
            if (newText) {
                // Split into meaningful lines, skip empty
                const lines = newText.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    tlPush('log', `<span class="tl-log-text">${escapeHtml(line.trim())}</span>`);
                }
            }
        }
    }

    // 2. File state changes (with context-aware labels)
    const states = (window.cobolGraph && window.cobolGraph.fileStates) || {};
    if (!window._filePhaseTracker) window._filePhaseTracker = {}; // tracks which files have been through review
    for (const [id, state] of Object.entries(states)) {
        const prev = prevFileStatesSnapshot[id];
        if (prev !== state && state !== 'pending') {
            // Track if this file has been through awaiting_review
            if (state === 'awaiting_review') window._filePhaseTracker[id] = 'reviewed';

            const name = id.split('/').pop();
            const wasReviewed = window._filePhaseTracker[id] === 'reviewed';

            let label;
            if (state === 'active' && !wasReviewed) {
                label = 'Converting';
            } else if (state === 'active' && wasReviewed) {
                label = 'Finalizing';
            } else if (state === 'awaiting_review') {
                label = 'Ready for review';
            } else if (state === 'done' && wasReviewed) {
                label = 'Approved & saved';
            } else if (state === 'done') {
                label = 'Converted';
            } else if (state === 'failed') {
                label = 'Failed';
            } else if (state === 'skipped') {
                label = 'Skipped';
            } else {
                label = state;
            }

            tlPush('state', `<span class="tl-state-pill ${state}">${label}</span> <span class="tl-file-name">${escapeHtml(name)}</span>`, id);
        }
    }
    prevFileStatesSnapshot = { ...states };

    // 3. Review history (new entries)
    (async () => {
        try {
            const r = await fetch(`/api/reviews/${currentConversionId}/history`);
            if (!r.ok) return;
            const data = await r.json();
            const history = data.history || [];
            if (history.length > lastHistoryLength) {
                const newEntries = history.slice(lastHistoryLength);
                lastHistoryLength = history.length;
                for (const h of newEntries) {
                    const name = (h.fileId || '').split('/').pop();
                    const cls = h.action === 'approve' ? 'approve' : h.action === 'reject' ? 'reject' : 'edit';
                    const bulk = h.bulk ? ' (bulk)' : '';
                    const note = h.note ? ` — ${escapeHtml(h.note)}` : '';
                    tlPush('review', `<span class="tl-review-action ${cls}">${h.action}${bulk}</span> <span class="tl-file-name">${escapeHtml(name)}</span>${note}`, h.fileId);
                }
            }
        } catch {}
    })();
}

function startTimelinePolling() {
    if (timelineTimer) clearInterval(timelineTimer);
    timelineTimer = setInterval(pollTimeline, 1200);
}
function stopTimelinePolling() {
    if (timelineTimer) { clearInterval(timelineTimer); timelineTimer = null; }
    // One last poll
    setTimeout(pollTimeline, 100);
}

// Hook into conversion lifecycle
const _origStartForTimeline = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    resetTimeline();
    tlPush('system', 'Conversion started');
    startTimelinePolling();
    return _origStartForTimeline.apply(this, args);
};

const _origCompleteForTimeline = window.onConversionComplete;
window.onConversionComplete = async function () {
    if (_origCompleteForTimeline) {
        try { await _origCompleteForTimeline(); } catch {}
    }
    tlPush('system', 'Conversion complete');
    setTimeout(stopTimelinePolling, 1500);
};

// --- Graph zoom controls -------------------------------------------------
function graphZoom(factor) {
    const cy = window.cobolGraph && window.cobolGraph._cy;
    if (!cy) return;
    const z = cy.zoom();
    cy.animate({ zoom: z * factor, duration: 200 });
}
function graphFit() {
    const cy = window.cobolGraph && window.cobolGraph._cy;
    if (!cy) return;
    cy.fit(undefined, 50);
}
window.graphZoom = graphZoom;
window.graphFit = graphFit;

// --- Diff view in review modal -------------------------------------------
let reviewOriginalJava = ''; // stashed when review modal opens

// Stash original AI output when opening the modal
const _origOpenForDiff = openReviewModal;
openReviewModal = async function (fileId, label) {
    reviewOriginalJava = '';
    await _origOpenForDiff.call(this, fileId, label);
    // After the modal loads, stash the AI's original Java
    const javaEl = document.getElementById('reviewJavaCode');
    if (javaEl) reviewOriginalJava = javaEl.value;
};
window.openReviewModal = openReviewModal;

function showReviewDiff() {
    const panel = document.getElementById('reviewDiffPanel');
    const content = document.getElementById('reviewDiffContent');
    if (!panel || !content) return;
    const javaEl = document.getElementById('reviewJavaCode');
    const edited = javaEl ? javaEl.value : '';
    if (!reviewOriginalJava && !edited) {
        content.textContent = 'No content to compare.';
        panel.classList.remove('hidden');
        return;
    }
    if (reviewOriginalJava === edited) {
        content.textContent = 'No changes — the code is identical to the AI output.';
        panel.classList.remove('hidden');
        return;
    }
    // Simple line-by-line diff
    const origLines = reviewOriginalJava.split('\n');
    const editLines = edited.split('\n');
    const maxLen = Math.max(origLines.length, editLines.length);
    let html = '';
    for (let i = 0; i < maxLen; i++) {
        const o = origLines[i];
        const e = editLines[i];
        if (o === undefined) {
            html += `<div class="diff-line diff-add">+ ${escapeHtml(e)}</div>`;
        } else if (e === undefined) {
            html += `<div class="diff-line diff-del">- ${escapeHtml(o)}</div>`;
        } else if (o !== e) {
            html += `<div class="diff-line diff-del">- ${escapeHtml(o)}</div>`;
            html += `<div class="diff-line diff-add">+ ${escapeHtml(e)}</div>`;
        } else {
            html += `<div class="diff-line">  ${escapeHtml(o)}</div>`;
        }
    }
    content.innerHTML = html;
    panel.classList.remove('hidden');
}
function hideReviewDiff() {
    const panel = document.getElementById('reviewDiffPanel');
    if (panel) panel.classList.add('hidden');
}
window.showReviewDiff = showReviewDiff;
window.hideReviewDiff = hideReviewDiff;

// applyTheme, toggleTheme → public/js/helpers.js
window.toggleTheme = toggleTheme;
// Restore saved theme on load. Always call applyTheme so the icon gets
// painted — without the saved-theme branch, the button would render
// empty because helpers.js only touches #themeIcon from applyTheme.
(function () {
    const saved = localStorage.getItem('theme') || 'dark';
    applyTheme(saved);
})();

// =======================================================================
// Workflow stepper: tracks the current phase of the conversion process
// and shows/hides UI sections accordingly.
// =======================================================================
const PHASES = ['input', 'select', 'analyze', 'convert', 'review', 'results'];
let currentPhase = 'input';
let completedPhases = new Set();

function setPhase(phase) {
    // Mark all previous phases as completed
    const idx = PHASES.indexOf(phase);
    for (let i = 0; i < idx; i++) completedPhases.add(PHASES[i]);
    currentPhase = phase;
    updateStepper();
    updatePhaseVisibility();
}

function updateStepper() {
    document.querySelectorAll('.wf-step').forEach(el => {
        const step = el.dataset.step;
        const idx = PHASES.indexOf(step);
        const curIdx = PHASES.indexOf(currentPhase);
        el.classList.remove('active', 'completed', 'upcoming');
        if (step === currentPhase) {
            el.classList.add('active');
        } else if (completedPhases.has(step) || idx < curIdx) {
            el.classList.add('completed');
        } else {
            el.classList.add('upcoming');
        }
    });
    // Connectors
    document.querySelectorAll('.wf-connector').forEach((el, i) => {
        const curIdx = PHASES.indexOf(currentPhase);
        el.classList.toggle('filled', i < curIdx);
    });
}

function updatePhaseVisibility() {
    document.querySelectorAll('.phase-hide').forEach(el => {
        const showPhases = (el.dataset.showPhases || '').split(' ');
        const visible = showPhases.includes(currentPhase);
        el.classList.toggle('phase-visible', visible);
    });
    // Workspace grid: if sidebar is hidden, let canvas fill the width
    const sidebar = document.querySelector('.sidebar');
    const workspace = document.querySelector('.workspace');
    if (sidebar && workspace) {
        const sidebarVisible = sidebar.classList.contains('phase-visible');
        workspace.style.gridTemplateColumns = sidebarVisible ? '280px 1fr' : '1fr';
        workspace.style.gap = sidebarVisible ? '' : '0';
    }
}

// Hook into the conversion lifecycle to advance phases
const _origStartConvForPhase = startConversion;
startConversion = async function () {
    setPhase('input');
    return _origStartConvForPhase.apply(this, arguments);
};
window.startConversion = startConversion;

// When pre-convert modal opens → select phase
const _origOpenPreConvertForPhase = openPreConvertModal;
openPreConvertModal = function (scan) {
    setPhase('select');
    return _origOpenPreConvertForPhase.apply(this, arguments);
};
window.openPreConvertModal = openPreConvertModal;

// When conversion actually starts → analyze phase, then convert
const _origActuallyStartForPhase = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    setPhase('analyze');
    // Move to convert phase after a short delay (graph needs to build first)
    setTimeout(() => {
        if (currentPhase === 'analyze') setPhase('convert');
    }, 5000);
    return _origActuallyStartForPhase.apply(this, args);
};

// When files start awaiting review → review phase
(function wrapForReviewPhase() {
    const tryWrap = () => {
        if (!window.cobolGraph || !window.cobolGraph.applyStates) return setTimeout(tryWrap, 200);
        const orig = window.cobolGraph.applyStates;
        if (orig._phaseWrapped) return;
        window.cobolGraph.applyStates = function (fileStates, currentFiles) {
            orig.call(this, fileStates, currentFiles);
            // If any file is awaiting_review, switch to review phase
            const hasAwaiting = Object.values(fileStates || {}).some(s => s === 'awaiting_review');
            const hasActive = Object.values(fileStates || {}).some(s => s === 'active');
            if (hasAwaiting && currentPhase === 'convert') setPhase('review');
            // If converting and no awaiting, stay in convert
            if (hasActive && !hasAwaiting && currentPhase !== 'analyze') {
                if (currentPhase !== 'convert' && currentPhase !== 'review') setPhase('convert');
            }
        };
        window.cobolGraph.applyStates._phaseWrapped = true;
    };
    tryWrap();
})();

// When conversion completes → results phase
const _origCompleteForPhase = window.onConversionComplete;
window.onConversionComplete = async function () {
    if (_origCompleteForPhase) {
        try { await _origCompleteForPhase(); } catch {}
    }
    setPhase('results');
};

// Initialize on page load
setPhase('input');

// --- Quick win: auto-focus repo input on page load -----------------------
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('repoInput');
    if (input) setTimeout(() => input.focus(), 100);
});

// --- Quick win: persist last repo URL in localStorage --------------------
(function persistRepoUrl() {
    const input = document.getElementById('repoInput');
    if (!input) return;
    const saved = localStorage.getItem('lastRepoUrl');
    if (saved && !input.value) {
        input.value = saved;
        if (window.updateConvertEnabled) window.updateConvertEnabled();
    }
    input.addEventListener('change', () => {
        if (input.value.trim()) localStorage.setItem('lastRepoUrl', input.value.trim());
    });
})();

// --- Quick win: keyboard shortcuts ---------------------------------------
document.addEventListener('keydown', (e) => {
    // Ignore key events originating from form fields so Cmd+Enter inside the
    // repo input still triggers Convert (existing behavior) but "?" typed
    // into a textarea doesn't open the cheatsheet.
    const target = e.target;
    const typingInField = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
    );

    // Cmd/Ctrl + Enter → Convert (if enabled) — allowed from within inputs.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const btn = document.getElementById('convertBtn');
        if (btn && !btn.disabled) btn.click();
        return;
    }
    // "?" → toggle the keyboard-shortcut cheatsheet. Skip while typing.
    if (e.key === '?' && !typingInField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleShortcutCheatsheet();
        return;
    }
    // Escape → close any open modal
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
        const drawer = document.getElementById('rightDrawer');
        if (drawer && !drawer.classList.contains('hidden')) {
            toggleRightDrawer();
        }
    }
});

/**
 * Keyboard shortcut cheatsheet — "?" toggles. Modal is created lazily.
 * Keep the list in sync with the actual handlers above and the ones in
 * other modules (e.g. the Cmd/Ctrl+Enter in convert, Escape dispatch).
 */
function toggleShortcutCheatsheet() {
    let modal = document.getElementById('shortcutCheatsheet');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'shortcutCheatsheet';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 520px;">
                <div class="modal-header">
                    <h3>Keyboard shortcuts</h3>
                    <button class="modal-close" onclick="document.getElementById('shortcutCheatsheet').classList.add('hidden')" aria-label="Close">x</button>
                </div>
                <div class="modal-body" style="padding: 1rem 1.25rem;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tbody>
                            <tr><td style="padding: .4rem 0;"><kbd>?</kbd></td><td>Show / hide this cheatsheet</td></tr>
                            <tr><td style="padding: .4rem 0;"><kbd>Esc</kbd></td><td>Close modals or the right drawer</td></tr>
                            <tr><td style="padding: .4rem 0;"><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>Start conversion (when the Convert button is enabled)</td></tr>
                            <tr><td style="padding: .4rem 0;"><kbd>Enter</kbd></td><td>Confirm a dialog (when no input is focused)</td></tr>
                        </tbody>
                    </table>
                    <p style="margin-top: 1rem; color: var(--text-muted, #888); font-size: .85rem;">
                        Shortcuts are disabled while typing in a form field.
                    </p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        // Backdrop click closes.
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    }
    modal.classList.toggle('hidden');
}
window.toggleShortcutCheatsheet = toggleShortcutCheatsheet;

// --- Quick win: copy-to-clipboard on code panels -------------------------
function addCopyButton(preEl, label) {
    if (!preEl || preEl.parentElement.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.title = 'Copy ' + label + ' to clipboard';
    btn.addEventListener('click', async () => {
        const code = preEl.querySelector('code') || preEl;
        try {
            await navigator.clipboard.writeText(code.textContent);
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch {
            btn.textContent = 'Failed';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        }
    });
    // If the pane has a header, insert Copy as a flex child so it lines up
    // next to other header buttons (e.g. "Fix with AI"). Otherwise fall back
    // to the absolute-positioned floating corner button.
    const header = preEl.parentElement.querySelector('.pane-header');
    if (header) {
        btn.classList.add('copy-btn--inline');
        header.appendChild(btn);
    } else {
        preEl.parentElement.style.position = 'relative';
        preEl.parentElement.appendChild(btn);
    }
}
// Observe browser panes and add copy buttons when content loads
const _origSelectForCopy = selectBrowserFile;
selectBrowserFile = async function (...args) {
    await _origSelectForCopy.apply(this, args);
    setTimeout(() => {
        addCopyButton(document.getElementById('browserCobolCode'), 'COBOL');
        addCopyButton(document.getElementById('browserJavaCode'), 'Java');
    }, 200);
};

// --- Quick win: progress in browser tab title ----------------------------
const originalTitle = document.title;
function updateTabTitle(text) { document.title = text; }
function resetTabTitle() { document.title = originalTitle; }

(function wrapForTabTitle() {
    const tryWrap = () => {
        if (!window.cobolGraph || !window.cobolGraph.applyStates) return setTimeout(tryWrap, 200);
        const orig = window.cobolGraph.applyStates;
        if (orig._titleWrapped) return;
        window.cobolGraph.applyStates = function (fileStates, currentFiles) {
            orig.call(this, fileStates, currentFiles);
            const total = Object.keys(fileStates || {}).length;
            if (total === 0) return;
            const done = Object.values(fileStates).filter(s => s === 'done').length;
            const pct = Math.round((done / total) * 100);
            updateTabTitle(`Converting ${pct}% | Coditation`);
        };
        window.cobolGraph.applyStates._titleWrapped = true;
    };
    tryWrap();
})();

const _origCompleteForTitle = window.onConversionComplete;
window.onConversionComplete = async function () {
    if (_origCompleteForTitle) {
        try { await _origCompleteForTitle(); } catch {}
    }
    updateTabTitle('Done | Coditation');
    setTimeout(resetTabTitle, 5000);
};

// --- Syntax highlighting via Prism.js ------------------------------------
function highlightCode(preEl, code, lang) {
    if (!preEl) return;
    const codeEl = preEl.querySelector('code') || preEl;
    if (typeof Prism !== 'undefined' && Prism.languages[lang]) {
        codeEl.className = `language-${lang}`;
        codeEl.textContent = code;
        Prism.highlightElement(codeEl);
        preEl.classList.add('line-numbers');
    } else {
        codeEl.textContent = code;
    }
}

// Patch selectBrowserFile to use highlighting
const _origSelectForHighlight = selectBrowserFile;
selectBrowserFile = async function (file, el) {
    // Call the existing chain (includes copy button + run gating)
    await _origSelectForHighlight.apply(this, arguments);

    // Re-highlight the code that was loaded
    setTimeout(() => {
        const cobolEl = document.getElementById('browserCobolCode');
        const javaEl = document.getElementById('browserJavaCode');
        if (cobolEl && cobolEl.querySelector('code')) {
            const code = cobolEl.querySelector('code').textContent;
            if (code && !code.startsWith('[') && !code.startsWith('Select')) {
                highlightCode(cobolEl, code, 'cobol');
            }
        }
        if (javaEl && javaEl.querySelector('code')) {
            const code = javaEl.querySelector('code').textContent;
            if (code && !code.startsWith('[') && !code.startsWith('Select')) {
                highlightCode(javaEl, code, 'java');
            }
        }
    }, 300);
};

// --- Export report as JSON download --------------------------------------
async function exportReport() {
    if (!currentConversionId) return;
    try {
        const [statusResp, graphResp, browserResp, historyResp] = await Promise.all([
            fetch(`/api/status/${currentConversionId}`),
            fetch(`/api/graph/${currentConversionId}?full=1`),
            fetch(`/api/browser/${currentConversionId}`),
            fetch(`/api/reviews/${currentConversionId}/history`)
        ]);
        const status = await statusResp.json();
        const graph = await graphResp.json();
        const browser = await browserResp.json();
        const history = await historyResp.json();

        const report = {
            exportedAt: new Date().toISOString(),
            conversionId: currentConversionId,
            summary: (status.result && status.result.report && status.result.report.summary) || {},
            tokens: graph.tokens || {},
            risks: graph.risks || [],
            files: (browser.files || []),
            reviewHistory: history.history || [],
            graph: { nodeCount: (graph.graph && graph.graph.nodes) ? graph.graph.nodes.length : 0, edgeCount: (graph.graph && graph.graph.edges) ? graph.graph.edges.length : 0 }
        };

        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cobol-conversion-report-${currentConversionId}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        toast('Export failed: ' + err.message, 'error');
    }
}
window.exportReport = exportReport;

// --- Hero animation: typing COBOL / Java code snippets -------------------
(function heroAnimation() {
    const cobolSnippet = `IDENTIFICATION DIVISION.
PROGRAM-ID. ACCOUNTS.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 BALANCE PIC 9(8)V99.
01 AMOUNT  PIC 9(8)V99.
PROCEDURE DIVISION.
    DISPLAY "Processing..."
    PERFORM CALCULATE
    DISPLAY BALANCE
    STOP RUN.`;

    const javaSnippet = `import java.math.*;

public class Accounts {
    BigDecimal balance;
    BigDecimal amount;

    public static void main() {
        System.out.println(
            "Processing...");
        calculate();
        System.out.println(
            balance);
    }
}`;

    function typeWriter(el, text, speed) {
        if (!el) return;
        let i = 0;
        el.textContent = '';
        function tick() {
            if (i < text.length) {
                el.textContent = text.slice(0, i + 1);
                i++;
                setTimeout(tick, speed);
            } else {
                // Pause then restart
                setTimeout(() => { i = 0; tick(); }, 3000);
            }
        }
        tick();
    }

    // Start after a short delay
    setTimeout(() => {
        typeWriter(document.getElementById('heroCobolCode'), cobolSnippet, 40);
        setTimeout(() => {
            typeWriter(document.getElementById('heroJavaCode'), javaSnippet, 40);
        }, 2000);
    }, 500);
})();

// --- Hero animation v2: sequenced entrance -------------------------------
// Overrides the v1 typeWriter. Sequence:
// 0.0s  COBOL box slides in + code starts typing
// 2.5s  Coditation AI engine bounces in
// 3.5s  Particles start flowing
// 4.0s  Java box slides in + Java code starts typing
// 10.0s Everything fades out
// 11.0s Restart
(function heroAnimationV2() {
    const cobolSnippet = `IDENTIFICATION DIVISION.
PROGRAM-ID. ACCOUNTS.

DATA DIVISION.
WORKING-STORAGE SECTION.
01 BALANCE PIC 9(8)V99.
01 AMOUNT  PIC 9(8)V99.

PROCEDURE DIVISION.
    DISPLAY "Processing..."
    PERFORM CALCULATE
    DISPLAY BALANCE
    STOP RUN.`;

    const javaSnippet = `import java.math.BigDecimal;

public class Accounts {
  BigDecimal balance;
  BigDecimal amount;

  public void calculate() {
    // business logic
  }

  public static void main(
      String[] args) {
    new Accounts().calculate();
    System.out.println(balance);
  }
}`;

    const cobolBox = document.querySelector('.hero-anim-box.cobol');
    const javaBox = document.querySelector('.hero-anim-box.java');
    const arrow = document.querySelector('.hero-anim-arrow');
    const cobolCode = document.getElementById('heroCobolCode');
    const javaCode = document.getElementById('heroJavaCode');

    if (!cobolBox || !javaBox || !arrow) return;

    let animTimer = null;

    function typeText(el, text, speed, cb) {
        if (!el) { if (cb) cb(); return; }
        let i = 0;
        el.textContent = '';
        function tick() {
            if (i <= text.length) {
                el.textContent = text.slice(0, i);
                i++;
                setTimeout(tick, speed);
            } else {
                if (cb) cb();
            }
        }
        tick();
    }

    function resetAll() {
        cobolBox.classList.remove('entered');
        javaBox.classList.remove('entered');
        arrow.classList.remove('entered');
        if (cobolCode) cobolCode.textContent = '';
        if (javaCode) javaCode.textContent = '';
    }

    function runSequence() {
        resetAll();

        // Phase 1: COBOL box enters + types
        setTimeout(() => {
            cobolBox.classList.add('entered');
            typeText(cobolCode, cobolSnippet, 35);
        }, 300);

        // Phase 2: Engine bounces in
        setTimeout(() => {
            arrow.classList.add('entered');
        }, 2500);

        // Phase 3: Java box enters + types
        setTimeout(() => {
            javaBox.classList.add('entered');
            typeText(javaCode, javaSnippet, 35);
        }, 3800);

        // Phase 4: Hold for viewing
        // Phase 5: Fade out and restart
        setTimeout(() => {
            cobolBox.style.transition = 'opacity 800ms';
            javaBox.style.transition = 'opacity 800ms';
            arrow.style.transition = 'opacity 800ms';
            cobolBox.style.opacity = '0';
            javaBox.style.opacity = '0';
            arrow.style.opacity = '0';

            setTimeout(() => {
                cobolBox.style.transition = '';
                javaBox.style.transition = '';
                arrow.style.transition = '';
                cobolBox.style.opacity = '';
                javaBox.style.opacity = '';
                arrow.style.opacity = '';
                runSequence();
            }, 1000);
        }, 12000);
    }

    // Only run when the hero is visible (input phase)
    function checkAndRun() {
        const hero = document.getElementById('canvasEmptyState');
        if (hero && (hero.classList.contains('phase-visible') || hero.style.display !== 'none')) {
            runSequence();
        } else {
            setTimeout(checkAndRun, 500);
        }
    }
    setTimeout(checkAndRun, 300);
})();

// --- Hero animation v3: override v2 with smooth CSS reveal (no typing) --
(function heroAnimationV3() {
    const cobolText = `IDENTIFICATION DIVISION.
PROGRAM-ID. ACCOUNTS.

DATA DIVISION.
WORKING-STORAGE SECTION.
01 BALANCE PIC 9(8)V99.
01 AMOUNT  PIC 9(8)V99.

PROCEDURE DIVISION.
    DISPLAY "Processing..."
    PERFORM CALCULATE
    DISPLAY BALANCE
    STOP RUN.`;

    const javaText = `import java.math.BigDecimal;

public class Accounts {
  BigDecimal balance;
  BigDecimal amount;

  public void calculate() {
    // business logic
  }

  public static void main(
      String[] args) {
    new Accounts().calculate();
    System.out.println(balance);
  }
}`;

    const cobolBox = document.querySelector('.hero-anim-box.cobol');
    const javaBox = document.querySelector('.hero-anim-box.java');
    const arrow = document.querySelector('.hero-anim-arrow');
    const cobolCode = document.getElementById('heroCobolCode');
    const javaCode = document.getElementById('heroJavaCode');

    if (!cobolBox || !javaBox || !arrow) return;

    // Pre-fill the text (no typing, CSS clip-path reveals it)
    if (cobolCode) cobolCode.textContent = cobolText;
    if (javaCode) javaCode.textContent = javaText;

    function resetAll() {
        cobolBox.classList.remove('entered');
        javaBox.classList.remove('entered');
        arrow.classList.remove('entered');
        // Reset clip-path animations by removing/re-adding entered
        void cobolBox.offsetWidth; // trigger reflow
    }

    function runSequence() {
        resetAll();

        // Phase 1: COBOL box slides in, code reveals via CSS clip-path
        setTimeout(() => cobolBox.classList.add('entered'), 400);

        // Phase 2: Engine bounces in
        setTimeout(() => arrow.classList.add('entered'), 2800);

        // Phase 3: Java box slides in, code reveals
        setTimeout(() => javaBox.classList.add('entered'), 4200);

        // Phase 4: Hold → fade → restart
        setTimeout(() => {
            [cobolBox, javaBox, arrow].forEach(el => {
                el.style.transition = 'opacity 900ms ease';
                el.style.opacity = '0';
            });
            setTimeout(() => {
                [cobolBox, javaBox, arrow].forEach(el => {
                    el.style.transition = '';
                    el.style.opacity = '';
                });
                runSequence();
            }, 1200);
        }, 13000);
    }

    // Only run when hero is visible
    function tryStart() {
        const hero = document.getElementById('canvasEmptyState');
        if (hero && hero.classList.contains('phase-visible')) {
            runSequence();
        } else {
            setTimeout(tryStart, 400);
        }
    }
    setTimeout(tryStart, 200);
})();

// --- Kill all prior hero animation versions ------------------------------
// v1 and v2 typeWriters are still in the file. Neutralize them by
// clearing any timers they started and preventing their DOM writes.
window._heroAnimStopped = true;
// Override the typeWriter/typeText functions to be no-ops
if (typeof typeWriter !== 'undefined') window.typeWriter = function(){};
// Clear ALL timers aggressively to stop lingering typewriter callbacks
(function killOldTimers() {
    const highestId = setTimeout(() => {}, 0);
    // Only clear recent timers (last 200) to avoid killing unrelated ones
    for (let i = highestId; i > highestId - 200; i--) {
        clearTimeout(i);
    }
})();

// Now restart ONLY v3 cleanly
(function heroAnimFinal() {
    const cobolText = `IDENTIFICATION DIVISION.
PROGRAM-ID. ACCOUNTS.

DATA DIVISION.
WORKING-STORAGE SECTION.
01 BALANCE PIC 9(8)V99.
01 AMOUNT  PIC 9(8)V99.

PROCEDURE DIVISION.
    DISPLAY "Processing..."
    PERFORM CALCULATE
    DISPLAY BALANCE
    STOP RUN.`;

    const javaText = `import java.math.BigDecimal;

public class Accounts {
  BigDecimal balance;
  BigDecimal amount;

  public void calculate() {
    // converted business logic
  }

  public static void main(
      String[] args) {
    new Accounts().calculate();
    System.out.println(balance);
  }
}`;

    const cobolBox = document.querySelector('.hero-anim-box.cobol');
    const javaBox = document.querySelector('.hero-anim-box.java');
    const arrow = document.querySelector('.hero-anim-arrow');
    const cobolCode = document.getElementById('heroCobolCode');
    const javaCode = document.getElementById('heroJavaCode');

    if (!cobolBox || !javaBox || !arrow) return;

    // Set text once, statically. CSS clip-path handles the reveal.
    if (cobolCode) cobolCode.textContent = cobolText;
    if (javaCode) javaCode.textContent = javaText;

    let loopTimer = null;

    function reset() {
        cobolBox.classList.remove('entered');
        javaBox.classList.remove('entered');
        arrow.classList.remove('entered');
        [cobolBox, javaBox, arrow].forEach(el => {
            el.style.transition = '';
            el.style.opacity = '';
        });
    }

    function run() {
        reset();
        // Staggered entrances
        setTimeout(() => cobolBox.classList.add('entered'), 500);
        setTimeout(() => arrow.classList.add('entered'), 3000);
        setTimeout(() => javaBox.classList.add('entered'), 4500);

        // Fade out after holding
        loopTimer = setTimeout(() => {
            [cobolBox, javaBox, arrow].forEach(el => {
                el.style.transition = 'opacity 1s ease';
                el.style.opacity = '0';
            });
            loopTimer = setTimeout(run, 1500);
        }, 14000);
    }

    // Only run when hero is visible
    function tryStart() {
        const hero = document.getElementById('canvasEmptyState');
        if (hero && hero.classList.contains('phase-visible')) {
            run();
        } else {
            setTimeout(tryStart, 500);
        }
    }
    setTimeout(tryStart, 300);

    // Stop when phase changes away from input
    const origSetPhase = setPhase;
    setPhase = function(phase) {
        if (phase !== 'input' && loopTimer) {
            clearTimeout(loopTimer);
            loopTimer = null;
            reset();
        }
        return origSetPhase.apply(this, arguments);
    };
    window.setPhase = setPhase;
})();

// =======================================================================
// Session persistence: save conversionId to localStorage, restore on load
// =======================================================================

// Save session when conversion starts
const _origStartForSession = actuallyStartConversion;
actuallyStartConversion = async function (...args) {
    const result = await _origStartForSession.apply(this, args);
    // After conversion starts, save the ID
    if (currentConversionId) {
        localStorage.setItem('lastConversionId', currentConversionId);
        localStorage.setItem('lastConversionPhase', currentPhase);
    }
    return result;
};

// Save phase changes
const _origSetPhaseForSession = setPhase;
setPhase = function (phase) {
    _origSetPhaseForSession.apply(this, arguments);
    if (currentConversionId) {
        localStorage.setItem('lastConversionPhase', phase);
    }
};
window.setPhase = setPhase;

// Restore session on page load
async function restoreSession() {
    // Bookmark URL: if the user landed on /c/<conversionId>, that wins
    // over whatever localStorage remembers. The server serves index.html
    // for any /c/* path; we parse it here so the SPA drives into the
    // right conversion.
    const bookmarkMatch = window.location.pathname.match(/^\/c\/([^/]+)\/?$/);
    const savedId = bookmarkMatch ? bookmarkMatch[1] : localStorage.getItem('lastConversionId');
    const savedPhase = bookmarkMatch ? 'results' : localStorage.getItem('lastConversionPhase');
    if (!savedId) return;

    try {
        // Check if the conversion still exists on the server
        const r = await fetch(`/api/status/${savedId}`);
        if (!r.ok) {
            localStorage.removeItem('lastConversionId');
            localStorage.removeItem('lastConversionPhase');
            return;
        }
        const data = await r.json();

        // Restore the conversion ID
        currentConversionId = savedId;

        // If the conversion is completed, go straight to results
        if (data.status === 'completed') {
            // Load graph data
            if (window.cobolGraph) {
                window.cobolGraph.load(savedId, {
                    onNodeClick: (nodeData) => {
                        const node = window.cobolGraph._cy && window.cobolGraph._cy.getElementById(nodeData.id);
                        const isAwaiting = node && node.length && node.hasClass('awaiting_review');
                        if (isAwaiting) {
                            openReviewModal(nodeData.id, nodeData.label);
                            return;
                        }
                        if (typeof showFileInBrowser === 'function') {
                            showFileInBrowser(nodeData.id, nodeData.label);
                        }
                    },
                    onStateUpdate: (counts) => {
                        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
                        set('liveTotal', counts.total);
                        set('liveDone', counts.done);
                        set('liveActive', counts.active);
                        set('liveFailed', counts.failed);
                        set('liveSkipped', counts.skipped);
                        set('liveAwaiting', counts.awaiting_review || 0);
                    }
                });
            }

            // Show live counts
            const liveCountsEl = document.getElementById('liveCounts');
            if (liveCountsEl) liveCountsEl.classList.remove('hidden');

            // Set to results phase
            setPhase('results');

            // Paint KPIs
            conversionStartedAt = Date.now() - 1000; // approximate
            if (typeof paintKpiBar === 'function') setTimeout(paintKpiBar, 500);

            // Load browser
            if (typeof loadBrowser === 'function') setTimeout(loadBrowser, 600);

            // Show tokens
            try {
                const gr = await fetch(`/api/graph/${savedId}`);
                if (gr.ok) {
                    const gd = await gr.json();
                    if (gd.tokens && window.updateTokenPanel) window.updateTokenPanel(gd.tokens);
                    if (gd.risks && window.updateRisksPanel) window.updateRisksPanel(gd.risks);
                }
            } catch {}

            // Restore timeline from saved server logs
            restoreTimelineFromLogs(data);

            console.log('[session] Restored completed conversion:', savedId);

        } else if (data.status === 'running') {
            // Conversion still in progress — reconnect
            setPhase(savedPhase || 'convert');

            const liveCountsEl = document.getElementById('liveCounts');
            if (liveCountsEl) liveCountsEl.classList.remove('hidden');

            if (window.cobolGraph) {
                window.cobolGraph.load(savedId, {
                    onNodeClick: (nodeData) => {
                        const node = window.cobolGraph._cy && window.cobolGraph._cy.getElementById(nodeData.id);
                        const isAwaiting = node && node.length && node.hasClass('awaiting_review');
                        if (isAwaiting) {
                            openReviewModal(nodeData.id, nodeData.label);
                            return;
                        }
                    },
                    onStateUpdate: (counts) => {
                        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
                        set('liveTotal', counts.total);
                        set('liveDone', counts.done);
                        set('liveActive', counts.active);
                        set('liveFailed', counts.failed);
                        set('liveSkipped', counts.skipped);
                        set('liveAwaiting', counts.awaiting_review || 0);
                    }
                });
            }

            // Re-enable stop button
            const stopBtn = document.getElementById('stopBtn');
            if (stopBtn) { stopBtn.disabled = false; stopBtn.title = 'Cancel the current conversion'; }
            convertBtn.dataset.busy = '1';
            if (window.updateConvertEnabled) window.updateConvertEnabled();

            console.log('[session] Reconnected to running conversion:', savedId);
        }
    } catch (err) {
        console.warn('[session] Restore failed:', err);
    }
}

// Reset session
function resetSession() {
    localStorage.removeItem('lastConversionId');
    localStorage.removeItem('lastConversionPhase');
    currentConversionId = null;
    setPhase('input');

    // Hide all results
    document.getElementById('kpiBar')?.classList.add('hidden');
    document.getElementById('browserSection')?.classList.add('hidden');
    document.getElementById('runOutputPanel')?.classList.add('hidden');
    document.getElementById('liveCounts')?.classList.add('hidden');
    document.getElementById('risksPanel')?.classList.add('hidden');
    document.getElementById('tokenPanel')?.classList.add('hidden');
    if (window.cobolGraph) window.cobolGraph.destroy();

    // Clear the URL / repo input box
    if (repoInput) repoInput.value = '';

    // Clear the Activity timeline and its unread badge
    const timeline = document.getElementById('detailsTimeline');
    if (timeline) {
        timeline.innerHTML = '<div class="empty-state">Activity will appear here once a conversion starts.</div>';
    }
    const drawerBadge = document.getElementById('drawerBadge');
    if (drawerBadge) { drawerBadge.textContent = '0'; drawerBadge.classList.add('hidden'); }

    // Reset legacy log / file / history containers kept alive for compatibility
    const logs = document.getElementById('logsOutput');          if (logs) logs.textContent = '';
    const fileList = document.getElementById('detailsFilesList'); if (fileList) fileList.innerHTML = '';
    const history  = document.getElementById('historyList');     if (history)  history.innerHTML = '';

    // Reset chat panel state (HITL chat messages + status pill)
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) { chatMessages.innerHTML = ''; chatMessages.classList.add('hidden'); }
    const chatStatus = document.getElementById('chatStatusPill');
    if (chatStatus) { chatStatus.textContent = 'Idle'; chatStatus.className = 'chat-status idle'; }

    // Reset any review-mode bookkeeping the frontend keeps in globals
    window._filePhaseTracker = {};
    if (window.cobolGraph) { try { window.cobolGraph.fileStates = {}; } catch {} }

    convertBtn.dataset.busy = '0';
    if (window.updateConvertEnabled) window.updateConvertEnabled();
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) { stopBtn.disabled = true; }

    // Exit maximized results view if it's currently open
    if (document.body.classList.contains('browser-maximized')) {
        document.body.classList.remove('browser-maximized');
    }
}
window.resetSession = resetSession;

// Run restore after a short delay (let all scripts initialize first)
setTimeout(restoreSession, 500);
