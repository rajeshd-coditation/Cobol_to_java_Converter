/**
 * HITL review assistant — closed-loop chat panel for the conversion run.
 *
 * Loaded AFTER app.js (see index.html) so this module can reach the
 * app.js-owned globals it depends on: currentConversionId, openReviewModal,
 * closeReviewModal, currentReviewFileId, actuallyStartConversion,
 * window.onConversionComplete.
 *
 * What it does:
 *   - Polls /api/reviews/:id every 1.5s while a conversion is running in
 *     review mode. New files entering the queue get narrated into the
 *     chat (`<file> ready for review`).
 *   - Exposes per-file actions (Approve / Reject / Edit / View code) and
 *     bulk actions when > 1 file is pending. Clicks POST to the matching
 *     /api/review or /api/reviews/:id/bulk endpoint.
 *   - Monkey-patches three app.js hooks so it integrates cleanly:
 *       actuallyStartConversion  → reset chat state + kick off polling
 *                                  only when review mode is on.
 *       onConversionComplete     → stop polling + render final summary.
 *       closeReviewModal         → mark the currently-reviewed file as
 *                                  handled so the poll loop doesn't
 *                                  re-prompt for it.
 *
 * `chatViewCode`, `chatAct`, `chatBulk` are intentionally attached to
 * window — they're referenced from inline onclick attributes in the
 * action-bar HTML this module emits.
 */

// --- Review Assistant: closed-loop chat panel ----------------------------
let chatAnnouncedFiles = new Set();   // file IDs we've already announced as awaiting
let chatHandledFiles = new Set();     // file IDs we've recorded an action for
let chatPollTimer = null;
let chatActiveFile = null;            // the file currently in focus for actions

function showReviewChat() {
    const p = document.getElementById('reviewChatPanel');
    if (p) p.classList.remove('hidden');
}
function hideReviewChat() {
    const p = document.getElementById('reviewChatPanel');
    if (p) p.classList.add('hidden');
}

function chatMessage(role, html, meta) {
    const msgs = document.getElementById('chatMessages');
    if (!msgs) return;
    // Drop the empty placeholder once we start
    const empty = msgs.querySelector('.chat-empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    if (meta && meta.kind) div.classList.add('kind-' + meta.kind);
    div.innerHTML = `
        <div class="chat-msg-bubble">${html}</div>
        <div class="chat-msg-time">${new Date().toLocaleTimeString()}</div>
    `;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

function setChatStatus(text, kind) {
    const pill = document.getElementById('chatStatusPill');
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'chat-status ' + (kind || 'idle');
}

function renderChatActions(pendingCount) {
    const bar = document.getElementById('chatActions');
    if (!bar) return;
    if (!chatActiveFile && pendingCount === 0) {
        bar.innerHTML = `<div class="chat-actions-empty">Waiting for the next file…</div>`;
        return;
    }
    const focus = chatActiveFile || '(no file selected)';
    const focusName = focus.split('/').pop();
    bar.innerHTML = `
        <div class="chat-focus">
            <span class="chat-focus-label">Currently reviewing</span>
            <span class="chat-focus-name" title="${escapeHtml(focus)}">${escapeHtml(focusName)}</span>
        </div>
        <div class="chat-action-row">
            <button class="btn-pill chat-btn view" onclick="chatViewCode()">View code</button>
            <button class="btn-pill chat-btn approve" onclick="chatAct('approve')">OK Approve</button>
            <button class="btn-pill chat-btn edit" onclick="chatAct('edit')">edit Edit</button>
            <button class="btn-pill chat-btn reject" onclick="chatAct('reject')">FAIL Reject</button>
        </div>
        ${pendingCount > 1 ? `
        <div class="chat-action-row chat-bulk-row">
            <span class="chat-bulk-label">Or for all ${pendingCount} pending:</span>
            <button class="btn-pill chat-btn approve-all" onclick="chatBulk('approve')">Approve all</button>
            <button class="btn-pill chat-btn reject-all" onclick="chatBulk('reject')">Reject all</button>
        </div>` : ''}
    `;
}

async function pollChatQueue() {
    if (!currentConversionId) return;
    try {
        const r = await fetch(`/api/reviews/${currentConversionId}`);
        if (r.ok) {
            const d = await r.json();
            const pending = d.pending || [];

            // Announce any new files entering the queue
            for (const item of pending) {
                if (chatAnnouncedFiles.has(item.fileId)) continue;
                chatAnnouncedFiles.add(item.fileId);
                // Fetch sizes for the announcement
                let cobolBytes = 0, javaBytes = 0;
                try {
                    const detail = await fetch(`/api/review/${currentConversionId}/${encodeURIComponent(item.fileId)}`);
                    if (detail.ok) {
                        const dd = await detail.json();
                        cobolBytes = (dd.cobolSource || '').length;
                        javaBytes = (dd.javaCode || '').length;
                    }
                } catch {}
                const name = item.fileId.split('/').pop();
                chatMessage('system', `
                    <div class="msg-strong"><code>${escapeHtml(name)}</code> ready for review</div>
                    <div class="msg-meta">
                        ${(cobolBytes / 1024).toFixed(1)} KB COBOL - ${(javaBytes / 1024).toFixed(1)} KB Java
                    </div>
                `, { kind: 'pending' });
            }

            // Set the active focus to the oldest pending file we haven't handled
            const next = pending.find(p => !chatHandledFiles.has(p.fileId));
            chatActiveFile = next ? next.fileId : null;

            renderChatActions(pending.length);
            if (pending.length > 0) setChatStatus(`${pending.length} pending`, 'busy');
            else setChatStatus('Idle', 'idle');
        }
    } catch { /* swallow */ }
    chatPollTimer = setTimeout(pollChatQueue, 1500);
}

function startChatPolling() {
    if (chatPollTimer) clearTimeout(chatPollTimer);
    pollChatQueue();
}
function stopChatPolling() {
    if (chatPollTimer) { clearTimeout(chatPollTimer); chatPollTimer = null; }
}

// --- Chat actions --------------------------------------------------------
function chatViewCode() {
    if (!chatActiveFile) return;
    openReviewModal(chatActiveFile, chatActiveFile.split('/').pop());
}

async function chatAct(action) {
    if (!chatActiveFile || !currentConversionId) return;
    const fileId = chatActiveFile;
    const name = fileId.split('/').pop();

    // For "edit" we route through the existing modal so the user can change the Java
    if (action === 'edit') {
        chatMessage('user', `Edit <code>${escapeHtml(name)}</code>`);
        chatMessage('system', `Opening the editor — save and approve from inside the modal.`);
        openReviewModal(fileId, name);
        return;
    }

    chatMessage('user', `${action === 'approve' ? 'Approve' : 'Reject'} <code>${escapeHtml(name)}</code>`);
    try {
        const r = await fetch(`/api/review/${currentConversionId}/${encodeURIComponent(fileId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        if (!r.ok) {
            chatMessage('system', `<span class="msg-err">Failed to ${action}: ${r.status}</span>`, { kind: 'error' });
            return;
        }
        chatHandledFiles.add(fileId);
        if (action === 'approve') {
            chatMessage('system', `Approved — written to disk. Conversion is resuming.`, { kind: 'done' });
        } else {
            chatMessage('system', `Rejected — marked as failed in the report.`, { kind: 'failed' });
        }
    } catch (err) {
        chatMessage('system', `<span class="msg-err">Network error: ${err.message}</span>`, { kind: 'error' });
    }
}

async function chatBulk(action) {
    if (!currentConversionId) return;
    if (action === 'reject' && !(await confirmDialog('Reject ALL pending files at once?', { title: 'Reject all', okText: 'Reject all', danger: true }))) return;
    chatMessage('user', `${action === 'approve' ? 'Approve all' : 'Reject all'}`);

    // Snapshot pending file IDs BEFORE the call so we can mark them handled
    let pendingSnapshot = [];
    try {
        const listResp = await fetch(`/api/reviews/${currentConversionId}`);
        if (listResp.ok) {
            const listData = await listResp.json();
            pendingSnapshot = (listData.pending || []).map(p => p.fileId);
        }
    } catch {}

    try {
        const r = await fetch(`/api/reviews/${currentConversionId}/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const d = await r.json();
        if (!r.ok) {
            chatMessage('system', `<span class="msg-err">Bulk failed: ${d.error || r.status}</span>`, { kind: 'error' });
            return;
        }
        // Mark every previously-pending file as handled so the poll loop doesn't re-prompt
        pendingSnapshot.forEach(fid => chatHandledFiles.add(fid));
        chatActiveFile = null;
        renderChatActions(0);
        chatMessage('system', `${action === 'approve' ? 'Approved' : 'Rejected'} ${d.count} file${d.count === 1 ? '' : 's'}.`, { kind: action === 'approve' ? 'done' : 'failed' });
    } catch (err) {
        chatMessage('system', `<span class="msg-err">Network error: ${err.message}</span>`, { kind: 'error' });
    }
}

window.chatViewCode = chatViewCode;
window.chatAct = chatAct;
window.chatBulk = chatBulk;

// Show the chat panel + start polling whenever a conversion starts in review mode
const _origActuallyStartForChat = actuallyStartConversion;
actuallyStartConversion = async function (inputPath, selectedFiles) {
    // Reset chat state for the new run
    chatAnnouncedFiles = new Set();
    chatHandledFiles = new Set();
    chatActiveFile = null;
    const msgs = document.getElementById('chatMessages');
    if (msgs) msgs.innerHTML = '';

    // Always narrate progress in the chat (panel is always visible)
    const reviewToggle = document.getElementById('reviewModeToggle');
    const reviewMode = reviewToggle && reviewToggle.checked;
    chatMessage('system', reviewMode
        ? `Conversion started — I'll narrate progress and queue files for your review.`
        : `Conversion started — review mode is OFF, files will convert without pausing.`,
        { kind: 'info' });
    if (reviewMode) startChatPolling();
    else stopChatPolling();
    return _origActuallyStartForChat.apply(this, arguments);
};

// Stop polling on completion + final summary
const _origCompleteForChat = window.onConversionComplete;
window.onConversionComplete = async function () {
    stopChatPolling();
    setChatStatus('Done', 'done');
    if (chatAnnouncedFiles.size > 0) {
        chatMessage('system', `Conversion finished. You reviewed ${chatHandledFiles.size} of ${chatAnnouncedFiles.size} files.`, { kind: 'done' });
        renderChatActions(0);
    }
    if (_origCompleteForChat) {
        try { await _origCompleteForChat(); } catch {}
    }
};

// When the review modal closes after a Save/Approve, mark the file handled in chat
const _origCloseReview = window.closeReviewModal;
window.closeReviewModal = function () {
    if (currentReviewFileId) chatHandledFiles.add(currentReviewFileId);
    if (_origCloseReview) _origCloseReview();
};
