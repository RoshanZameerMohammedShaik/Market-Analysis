// Floating Debug App panel — visible only when dev mode is on.
//
// Mounts a small chip in the corner of the main app showing live
// error / warning counts. Click expands into the same console UI
// the /dev page renders, scoped to THIS tab's debug buffer (the only
// way the user can see logs from the page they're actually using —
// each tab has its own window and its own buffer).
//
// The buffer itself is captured by js/debug-capture.js which is
// loaded inline at the top of index.html before any module. This
// module is just the renderer + UI on top of that buffer.

const STORAGE_KEY = 'ma-dev-mode';
const COLLAPSED_KEY = 'ma-debug-panel-collapsed';

function isDevMode() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
}

function fmtTime(ts) {
    return new Date(ts).toISOString().slice(11, 23);
}

function escapeHTML(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

let panelMounted = false;
let unsubscribe = null;
let state = {
    expanded: false,
    search: '',
    level: '',
    tag: '',
};

export function initDebugPanel() {
    // Re-evaluate on every init call — toggling dev mode in the
    // /dev page sets localStorage but doesn't re-run app bootstrap;
    // page reload picks up the change.
    if (!isDevMode()) return;
    if (panelMounted) return;

    mount();
    panelMounted = true;

    const cap = window.__debugCapture;
    if (cap) {
        unsubscribe = cap.subscribe(render);
        render();
    }
}

function mount() {
    const root = document.createElement('div');
    root.id = 'debug-panel-root';
    root.dataset.expanded = 'false';
    root.innerHTML = `
        <button class="dbg-chip" id="dbg-chip" type="button" title="Toggle Debug App (dev mode)">
            <span class="dbg-chip-icon">🛠</span>
            <span class="dbg-chip-counts" id="dbg-chip-counts">0 / 0</span>
        </button>
        <div class="dbg-panel" id="dbg-panel" aria-hidden="true">
            <div class="dbg-head">
                <span class="dbg-head-title">Debug App</span>
                <a class="dbg-head-link" href="dev/" target="_blank" rel="noopener" title="Open the Dev Hub">Dev Hub ↗</a>
                <button class="dbg-head-min" id="dbg-min" type="button" title="Collapse">_</button>
            </div>
            <div class="dbg-toolbar">
                <input id="dbg-search" placeholder="filter…" autocomplete="off" spellcheck="false">
                <select id="dbg-level">
                    <option value="">all levels</option>
                    <option value="error">errors</option>
                    <option value="warn">warnings</option>
                    <option value="info">info</option>
                    <option value="log">log</option>
                    <option value="debug">debug</option>
                </select>
                <select id="dbg-tag">
                    <option value="">all sources</option>
                </select>
                <button id="dbg-copy" type="button" title="Copy buffer (already redacted)">Copy</button>
                <button id="dbg-clear" type="button" title="Clear buffer">Clear</button>
            </div>
            <div class="dbg-body" id="dbg-body"></div>
            <div class="dbg-counts" id="dbg-counts"></div>
        </div>
    `;
    document.body.appendChild(root);

    // Restore last collapsed/expanded state.
    let collapsed = true;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) !== '0'; } catch (_) {}
    state.expanded = !collapsed;
    syncExpanded();

    document.getElementById('dbg-chip').addEventListener('click', () => {
        state.expanded = !state.expanded;
        try { localStorage.setItem(COLLAPSED_KEY, state.expanded ? '0' : '1'); } catch (_) {}
        syncExpanded();
        if (state.expanded) render();
    });
    document.getElementById('dbg-min').addEventListener('click', () => {
        state.expanded = false;
        try { localStorage.setItem(COLLAPSED_KEY, '1'); } catch (_) {}
        syncExpanded();
    });

    document.getElementById('dbg-search').addEventListener('input', (e) => {
        state.search = e.target.value;
        render();
    });
    document.getElementById('dbg-level').addEventListener('change', (e) => {
        state.level = e.target.value;
        render();
    });
    document.getElementById('dbg-tag').addEventListener('change', (e) => {
        state.tag = e.target.value;
        render();
    });
    document.getElementById('dbg-copy').addEventListener('click', async () => {
        try {
            await window.__debugCapture?.copyAll();
            const btn = document.getElementById('dbg-copy');
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = orig, 1200);
        } catch (e) {
            alert('Copy failed: ' + e.message);
        }
    });
    document.getElementById('dbg-clear').addEventListener('click', () => {
        window.__debugCapture?.clear();
    });
}

function syncExpanded() {
    const root = document.getElementById('debug-panel-root');
    const panel = document.getElementById('dbg-panel');
    if (!root || !panel) return;
    root.dataset.expanded = state.expanded ? 'true' : 'false';
    panel.setAttribute('aria-hidden', state.expanded ? 'false' : 'true');
}

const seenTags = new Set();
function ensureTagInDropdown(tag) {
    if (seenTags.has(tag)) return;
    seenTags.add(tag);
    const sel = document.getElementById('dbg-tag');
    if (!sel) return;
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    sel.appendChild(opt);
}

function render() {
    const cap = window.__debugCapture;
    if (!cap) return;
    const entries = cap.entries;

    // Counts (always — the chip shows them even when collapsed).
    let errCount = 0, warnCount = 0;
    for (const e of entries) {
        ensureTagInDropdown(e.tag);
        if (e.level === 'error') errCount++;
        else if (e.level === 'warn') warnCount++;
    }
    const chipCounts = document.getElementById('dbg-chip-counts');
    if (chipCounts) chipCounts.textContent = `${errCount}E / ${warnCount}W`;
    const chip = document.getElementById('dbg-chip');
    if (chip) chip.dataset.alert = errCount > 0 ? 'error' : (warnCount > 0 ? 'warn' : 'ok');

    if (!state.expanded) return; // skip body render when collapsed

    const q = state.search.trim().toLowerCase();
    const lvl = state.level;
    const tag = state.tag;
    const html = [];
    for (const e of entries) {
        if (lvl && e.level !== lvl) continue;
        if (tag && e.tag !== tag) continue;
        if (q && !e.text.toLowerCase().includes(q) && !e.tag.toLowerCase().includes(q)) continue;
        html.push(
            `<div class="dbg-row" data-level="${e.level}">` +
            `<span class="dbg-row-time">${fmtTime(e.ts)}</span>` +
            `<span class="dbg-row-tag">[${escapeHTML(e.tag)}]</span>` +
            `<span class="dbg-row-text">${escapeHTML(e.text)}</span>` +
            `</div>`
        );
    }
    const body = document.getElementById('dbg-body');
    if (!body) return;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    body.innerHTML = html.join('');
    if (atBottom) body.scrollTop = body.scrollHeight;

    const counts = document.getElementById('dbg-counts');
    if (counts) counts.innerHTML =
        `<span>${entries.length} entries</span>` +
        `<span class="err">${errCount} err</span>` +
        `<span class="warn">${warnCount} warn</span>`;
}
