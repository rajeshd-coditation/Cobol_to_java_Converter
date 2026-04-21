/**
 * Small pure-ish helpers shared across the frontend. Loaded before app.js
 * so top-level declarations are available as globals.
 *
 *   escapeHtml(str)              HTML-attribute-safe string escape.
 *   fmt(n)                       compact number formatter (1.3k / 2.47M).
 *   formatDiff(diffText)         diff text → spans with CSS classes.
 *   renderMarkdown(text)         lightweight md → HTML renderer for the
 *                                AI-analysis panel. Escapes first, then
 *                                reintroduces fenced code, inline code,
 *                                bold, ATX headings, lists, paragraphs.
 *                                Not CommonMark-complete — scoped to the
 *                                subset the analyst actually emits.
 *   whiteLabel(text)             strip vendor + emoji noise from streamed
 *                                log lines so the Stream tab reads as a
 *                                clean narrative. Called on every log line.
 *   applyTheme(theme)            set body class + localStorage ('light' | 'dark').
 *   toggleTheme()                flip between the two.
 *
 * Previously app.js declared escapeHtml twice — once for formatDiff (using
 * innerHTML of a detached div, which doesn't escape quotes and is unsafe
 * as an attribute value) and once later for attribute contexts. Hoisting
 * made the second win. Consolidated here with the attribute-safe version.
 */

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
    if (n == null) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}

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

function renderMarkdown(text) {
    // Escape first so subsequent `<pre>` / `<code>` / `<h*>` / etc. the
    // regexes emit aren't themselves escaped back to text.
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Fenced code blocks — `lang` goes on the wrapper class for prism.
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="code-block ${lang}"><code>${code.trim()}</code></pre>`;
    });

    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // ATX headings. Match deeper levels first so `####` doesn't get eaten
    // by the `###` rule before it can match.
    html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Lists — we emit bare <li> without wrapping <ul> because the analyst's
    // output is free-form and sometimes mixes lists with paragraphs. The
    // surrounding <p>…</p> keeps the rendering stable either way.
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');

    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    return `<p>${html}</p>`;
}

function whiteLabel(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/Powered by Azure AI Agent/gi, 'Powered by Coditation AI')
        .replace(/Azure OpenAI/gi, 'Coditation AI')
        .replace(/Azure AI Foundry/gi, 'Coditation AI')
        .replace(/Azure AI/gi, 'Coditation AI')
        .replace(/AI Foundry/gi, 'Coditation AI')
        .replace(/OpenAI/gi, 'Coditation AI')
        .replace(/\bAzure\b/g, 'Coditation')
        .replace(/GnuCOBOL/gi, 'COBOL toolchain')
        .replace(/\bcobj\b/g, 'compiler')
        .replace(/\bcobc\b/g, 'compiler')
        // Strip emoji / pictograph blocks. Covers misc symbols + emoticons +
        // transport/map + dingbats + enclosed + symbols-ext-A.
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{2600}-\u{27BF}]/gu, '')
        .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
        .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/\uFE0F/g, '')
        // Tighten double-spaces left behind by removed emoji.
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+$/gm, '');
}

function applyTheme(theme) {
    document.body.classList.toggle('theme-light', theme === 'light');
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = theme === 'light' ? '' : '';
    localStorage.setItem('theme', theme);
}

function toggleTheme() {
    const current = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
}
