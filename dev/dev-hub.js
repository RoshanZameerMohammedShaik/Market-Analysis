// Dev Hub controller. Reads from window.__debugCapture (installed by
// js/debug-capture.js, loaded inline at the top of dev/index.html so
// it's running before this module imports). Renders the live console
// + handles mode-toggle buttons.

const STORAGE_KEY = 'ma-dev-mode';

// ── Mode toggle ──────────────────────────────────────────────────
const statusEl = document.getElementById('dev-status');
function refreshStatus() {
    let on = false;
    try { on = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
    statusEl.dataset.on = on ? 'true' : 'false';
    statusEl.textContent = on ? 'on' : 'off';
}
document.getElementById('dev-toggle-on').addEventListener('click', () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
    refreshStatus();
});
document.getElementById('dev-toggle-off').addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    refreshStatus();
});
refreshStatus();

// ── Console viewer ───────────────────────────────────────────────
const cap = window.__debugCapture;
const body = document.getElementById('dev-console-body');
const counts = document.getElementById('dev-console-counts');
const searchEl = document.getElementById('dev-console-search');
const levelEl = document.getElementById('dev-console-level');
const tagEl = document.getElementById('dev-console-tag');

if (!cap) {
    body.innerHTML = '<div style="color:#fca5a5; padding: 20px;">Debug capture not installed. Reload the page.</div>';
} else {
    // Track which tags we've seen so the dropdown can offer them.
    const seenTags = new Set();
    function ensureTagInDropdown(tag) {
        if (seenTags.has(tag)) return;
        seenTags.add(tag);
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        tagEl.appendChild(opt);
    }

    function fmtTime(ts) {
        return new Date(ts).toISOString().slice(11, 23);
    }

    function escapeHTML(s) {
        return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }

    function render() {
        const q = searchEl.value.trim().toLowerCase();
        const lvl = levelEl.value;
        const tag = tagEl.value;
        const entries = cap.entries;
        let errCount = 0, warnCount = 0, netCount = 0;
        const html = [];
        // Render in reverse so newest is at the bottom (terminal-style),
        // but we need to walk forward to count too.
        for (const e of entries) {
            ensureTagInDropdown(e.tag);
            if (e.level === 'error') errCount++;
            else if (e.level === 'warn') warnCount++;
            if (e.tag === 'fetch') netCount++;
            if (lvl && e.level !== lvl) continue;
            if (tag && e.tag !== tag) continue;
            if (q && !e.text.toLowerCase().includes(q) && !e.tag.toLowerCase().includes(q)) continue;
            html.push(
                `<div class="dev-log-row" data-level="${e.level}">` +
                `<span class="dev-log-time">${fmtTime(e.ts)}</span>` +
                `<span class="dev-log-tag">[${escapeHTML(e.tag)}]</span>` +
                `<span class="dev-log-text">${escapeHTML(e.text)}</span>` +
                `</div>`
            );
        }
        // Scroll-stick: if user is already at the bottom, stay there
        // when new entries land. Otherwise leave their scroll position
        // alone so they can read mid-buffer without snapping away.
        const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
        body.innerHTML = html.join('');
        if (atBottom) body.scrollTop = body.scrollHeight;

        counts.innerHTML =
            `<span>${entries.length} entries</span>` +
            `<span class="err">${errCount} errors</span>` +
            `<span class="warn">${warnCount} warnings</span>` +
            `<span class="net">${netCount} fetch issues</span>`;
    }

    cap.subscribe(render);
    searchEl.addEventListener('input', render);
    levelEl.addEventListener('change', render);
    tagEl.addEventListener('change', render);

    document.getElementById('dev-console-copy').addEventListener('click', async () => {
        try {
            await cap.copyAll();
            const btn = document.getElementById('dev-console-copy');
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = orig, 1200);
        } catch (e) {
            alert('Copy failed: ' + e.message);
        }
    });
    document.getElementById('dev-console-clear').addEventListener('click', () => {
        cap.clear();
    });

    render();
}
