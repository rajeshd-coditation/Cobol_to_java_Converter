/**
 * In-app replacements for native alert/confirm/prompt + toast notifications.
 *
 * Why custom and not browser-native? Native dialogs say "localhost:3000 says…"
 * and look jarring; they also block the main thread. These match the app's
 * visual language and are async Promise-based so callers can `await` them.
 *
 * Loaded BEFORE app.js in index.html. Top-level declarations here become
 * globals — no module wrapper — which is how the rest of the app reaches
 * them.
 *
 * DOM contract — these elements MUST exist in index.html:
 *   #toastContainer         — where toasts stack
 *   #appDialog              — the shared dialog modal wrapper
 *   #appDialogTitle         — title slot
 *   #appDialogMessage       — body slot
 *   #appDialogInput         — input (hidden for confirm, shown for prompt)
 *   #appDialogOkBtn         — primary button
 *   #appDialogCancelBtn     — secondary button
 *
 * Public API:
 *   toast(message, type?, duration?)
 *       Ephemeral notification. Returns a dismiss() function for sticky
 *       toasts (duration=0).
 *   confirmDialog(message, opts?)   → Promise<boolean>
 *   promptDialog(message, opts?)    → Promise<string|null>
 *       `null` means Cancel / Escape; `""` means OK with empty input.
 */

/**
 * Show an ephemeral toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {number} [duration=4500] ms; 0 = sticky until manually dismissed.
 * @returns {(() => void) | undefined}  dismiss fn, useful for sticky toasts
 */
function toast(message, type = 'info', duration = 4500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { info: 'i', success: 'OK', warning: '!', error: 'x' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `
        <span class="toast-icon">${icons[type] || 'i'}</span>
        <span class="toast-message"></span>
        <button class="toast-close" aria-label="Dismiss">x</button>
    `;
    el.querySelector('.toast-message').textContent = String(message);
    const dismiss = () => {
        if (el.classList.contains('toast-leaving')) return;
        el.classList.add('toast-leaving');
        setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.toast-close').addEventListener('click', dismiss);
    container.appendChild(el);
    if (duration > 0) setTimeout(dismiss, duration);
    return dismiss;
}

// Internal: open the shared dialog modal. Returns a Promise that resolves
// with the user's choice (boolean for confirm, string|null for prompt).
function _openDialog({ title, message, showInput, okText, cancelText, danger, defaultValue }) {
    return new Promise(resolve => {
        const modal = document.getElementById('appDialog');
        if (!modal) { resolve(null); return; }
        const titleEl  = document.getElementById('appDialogTitle');
        const msgEl    = document.getElementById('appDialogMessage');
        const inputEl  = document.getElementById('appDialogInput');
        const okBtn    = document.getElementById('appDialogOkBtn');
        const cancelBtn = document.getElementById('appDialogCancelBtn');

        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        okBtn.textContent = okText || 'OK';
        cancelBtn.textContent = cancelText || 'Cancel';
        okBtn.classList.toggle('danger', !!danger);

        if (showInput) {
            inputEl.classList.remove('hidden');
            inputEl.value = defaultValue || '';
        } else {
            inputEl.classList.add('hidden');
            inputEl.value = '';
        }

        modal.classList.remove('hidden');
        // Focus input when prompting, otherwise OK button. Delayed so the
        // focus ring lands after the CSS transition kicks in.
        setTimeout(() => (showInput ? inputEl : okBtn).focus(), 30);

        const close = (outcome) => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
            inputEl.removeEventListener('keydown', onInputKey);
            resolve(outcome);
        };
        const onOk = () => close(showInput ? (inputEl.value || '') : true);
        const onCancel = () => close(showInput ? null : false);
        const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
        const onKey = (e) => {
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter' && !showInput) onOk();
        };
        const onInputKey = (e) => { if (e.key === 'Enter') onOk(); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        inputEl.addEventListener('keydown', onInputKey);
    });
}

/**
 * In-app confirm dialog.
 * Usage: if (!await confirmDialog('Cancel conversion?')) return;
 */
function confirmDialog(message, { title = 'Confirm', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
    return _openDialog({ title, message, showInput: false, okText, cancelText, danger });
}

/**
 * In-app prompt dialog. Empty string = OK with no input; null = Cancel/Escape.
 */
function promptDialog(message, { title = 'Input required', okText = 'OK', cancelText = 'Cancel', defaultValue = '' } = {}) {
    return _openDialog({ title, message, showInput: true, okText, cancelText, danger: false, defaultValue });
}

/**
 * Legacy toast wrapper — kept because several callers pass rich HTML
 * (e.g. `<div class="toast-title">…</div><div class="toast-detail">…</div>`).
 * Strips HTML to plain text so the message lays out cleanly in the grid-
 * based toast container, then forwards to the platform toast.
 *
 * New code should call toast() directly. Keeping this on window. for the
 * benefit of older inline-HTML onclick handlers that still reach it by
 * name.
 */
function showToast(message, kind) {
    let text = String(message || '');
    text = text
        .replace(/<\/?(?:div|p|br|li)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const typeMap = { success: 'success', warning: 'warning', error: 'error', info: 'info' };
    return toast(text, typeMap[kind] || 'info', 5500);
}
