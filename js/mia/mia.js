// Mia v3.4 — tool-name scrubber on rendered reply.
//
// Phase 8.5 fix: 8B leaked 'calling the get_accuracy_stats tool' in prose.
// We now scrub raw tool names out of the visible text on every paint AND
// on the final saved message, replacing them with friendly action verbs
// (or just removing the leaky scaffolding entirely).

import { runTurn } from './agent.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';
import { renderMarkdown } from './markdown.js';
import { loadSettings, saveSettings, isConfigured, clearSettings } from './settings.js';
import { renderWelcome, MIA_LOGO_SVG } from './welcome.js';
import { renderUsageMeter } from './usage-meter.js';
import { webllm as webllmShim, getRoutingSummary } from './llm-client.js';
import { flagUnverifiedNumbers } from './guard.js';

let currentSignal = null;
let panelOpen = false;
let activeAbort = null;

const CLEAR_HOLD_MS = 3000;
const CLEAR_HOLD_DELAY_MS = 500;

const RENDER_CPS = 70;
const BASE_DELAY_MS = 1000 / RENDER_CPS;

const ACTION_VERBS = {
    get_app_state: 'reading the page',
    get_current_signal: 'reading the current signal',
    get_calibration: 'checking calibration',
    get_accuracy_stats: 'reading accuracy stats',
    analyze_symbol: 'running analysis',
    compare_symbols: 'comparing tickers',
    get_hot_picks: 'checking hot picks',
    get_market_conditions: 'checking the market',
    get_news_and_sentiment: 'checking the news',
    get_macro_series: 'checking macro data',
    get_reddit_sentiment: 'checking Reddit',
    get_sec_filings: 'checking SEC filings',
    get_options_view: 'checking options flow',
    get_crypto_derivatives: 'checking derivatives',
    research_symbol: 'doing deep research',
    web_search: 'searching the web',
    select_symbol: 'loading the symbol',
    switch_mode: 'switching tab',
    switch_timeframe: 'switching timeframe',
    cycle_theme: 'switching theme',
    toggle_pl_calculator: 'toggling P&L panel',
    refresh_hot_picks: 'refreshing hot picks',
    rerun_analysis: 'rerunning analysis',
};
function actionVerbFor(toolName) { return ACTION_VERBS[toolName] || 'working'; }

const TOOL_NAMES = Object.keys(ACTION_VERBS);

// Pre-compile a scrubber regex matching any tool name with optional surrounding
// scaffolding ("call the X tool", "by calling X", "I'll use X"). Covers the
// most common leak patterns 8B emits.
const TOOL_NAME_RE = new RegExp('\\b(' + TOOL_NAMES.join('|') + ')\\b', 'gi');
const SCAFFOLDING_PATTERNS = [
    // "by calling the get_accuracy_stats tool" → "by checking the accuracy stats"
    new RegExp('\\b(?:by\\s+)?calling\\s+the\\s+(' + TOOL_NAMES.join('|') + ')\\s+tool\\b', 'gi'),
    new RegExp('\\bcalling\\s+the\\s+(' + TOOL_NAMES.join('|') + ')\\b', 'gi'),
    new RegExp('\\b(?:I\\'ll|I will|let me|I can)\\s+(?:call|use|run|invoke)\\s+(?:the\\s+)?(' + TOOL_NAMES.join('|') + ')(?:\\s+tool)?\\b', 'gi'),
    new RegExp('\\busing\\s+(?:the\\s+)?(' + TOOL_NAMES.join('|') + ')(?:\\s+tool)?\\b', 'gi'),
    new RegExp('\\b(' + TOOL_NAMES.join('|') + ')\\s+tool\\b', 'gi'),
];

/**
 * Replace any leaked tool-name mention in the visible reply with the
 * friendly action verb. Also clean up dangling scaffolding phrases.
 */
function scrubToolNames(text) {
    if (!text) return text;
    let out = text;
    // First pass: replace common scaffolding phrases entirely.
    for (const re of SCAFFOLDING_PATTERNS) {
        out = out.replace(re, (_m, name) => actionVerbFor(name.toLowerCase()));
    }
    // Second pass: any remaining bare tool-name mention → action verb.
    out = out.replace(TOOL_NAME_RE, (m) => actionVerbFor(m.toLowerCase()));
    return out;
}

const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4 1.06L4.5 11l8 1-8 1L2 19.34a1 1 0 0 0 1.4 1.06z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';

const ECG_THINKING_SVG = `
<svg class="mia-ecg-thinking" viewBox="0 0 80 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path class="mia-ecg-thinking-trace" d="M0 9 L20 9 L24 9 L26 4 L28 14 L30 9 L36 9 L38 2 L40 16 L42 9 L48 9 L50 5 L52 13 L54 9 L80 9" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="mia-ecg-thinking-blip" d="M0 9 L20 9 L24 9 L26 4 L28 14 L30 9 L36 9 L38 2 L40 16 L42 9 L48 9 L50 5 L52 13 L54 9 L80 9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function setLatestSignal(sig) { currentSignal = sig; window.__miaLatestSignal = sig || null; }
export function initMia() { document.getElementById('mia-launcher')?.addEventListener('click', togglePanel); initLauncherReadyDot(); }
function initLauncherReadyDot() {
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return;
    if (!launcher.querySelector('.mia-launcher-ready-dot')) {
        const dot = document.createElement('span');
        dot.className = 'mia-launcher-ready-dot';
        dot.dataset.state = isConfigured() ? 'ready' : 'idle';
        launcher.appendChild(dot);
    }
    launcher.title = isConfigured() ? 'Ask Mia — your Market Intelligence Analyst (ready)' : 'Ask Mia — set up an API key to begin';
}
function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById('mia-panel');
    if (!panel) return;
    if (panelOpen) { panel.setAttribute('aria-hidden', 'false'); panel.classList.add('open'); renderRoot(); }
    else { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
}
function renderRoot() {
    const panel = document.getElementById('mia-panel');
    if (!isConfigured()) { renderWelcome(panel, () => renderChat()); return; }
    renderChat();
}

function renderChat() {
    const panel = document.getElementById('mia-panel');
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">${MIA_LOGO_SVG}</span>
                <div><div class="mia-name">Mia</div><div class="mia-role">Market Intelligence Analyst</div></div>
            </div>
            <div class="mia-head-actions">
                <button class="mia-icon-btn" id="mia-thinking-btn" title="Toggle thinking mode">🧠⁺</button>
                <button class="mia-icon-btn" id="mia-settings-btn" title="Settings">⚙️</button>
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-usage-wrap" id="mia-usage-wrap"></div>
        <div class="mia-thread" id="mia-thread"></div>
        <div class="mia-foot">
            <textarea id="mia-input" rows="2" placeholder="Ask Mia about a stock, an indicator, or what the signal means..."></textarea>
            <button id="mia-action" class="mia-action-btn" data-state="send" title="Send (long-press to clear chat)" aria-label="Send message">
                <svg class="mia-action-ring" viewBox="0 0 44 44" aria-hidden="true">
                    <circle class="mia-action-ring-bg" cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-width="2" opacity="0"/>
                    <circle class="mia-action-ring-fg" cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="125.66" stroke-dashoffset="125.66" transform="rotate(-90 22 22)"/>
                </svg>
                <span class="mia-action-icon" id="mia-action-icon">${ICON_SEND}</span>
            </button>
        </div>
        <div class="mia-disclaimer">Numbers come from the on-screen signal or tools she calls — not financial advice. Long-press send to clear chat.</div>
    `;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-settings-btn').addEventListener('click', renderSettings);
    document.getElementById('mia-thinking-btn').addEventListener('click', toggleThinking);
    wireActionButton();
    document.getElementById('mia-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onPrimaryAction(); }
        if (e.key === 'K' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); performClear(); }
    });
    refreshThinkingBadge();
    renderUsageMeter(document.getElementById('mia-usage-wrap'));
    renderThread(loadHistory());
}

let holdTimer = null;
let holdStartTs = 0;
let holdRingTimer = null;
let holdState = 'idle';

function wireActionButton() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    const start = (e) => { if (e.button !== undefined && e.button !== 0) return; e.preventDefault(); beginHold(); };
    const end = () => endHold();
    const cancel = () => cancelHold();
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('mouseup', end);
    btn.addEventListener('touchend', end);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('touchcancel', cancel);
}
function beginHold() {
    holdStartTs = Date.now();
    holdState = 'pressing';
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    holdRingTimer = setTimeout(() => {
        if (holdState !== 'pressing') return;
        btn.classList.add('mia-action-arming');
        setActionIcon(ICON_TRASH);
    }, CLEAR_HOLD_DELAY_MS);
    holdTimer = setTimeout(() => {
        if (holdState !== 'pressing') return;
        holdState = 'firing';
        performClear();
        const b = document.getElementById('mia-action');
        if (b) {
            b.classList.remove('mia-action-arming');
            b.classList.add('mia-action-cleared');
            setTimeout(() => b.classList.remove('mia-action-cleared'), 600);
            renderActionState();
        }
        holdState = 'idle';
    }, CLEAR_HOLD_MS);
}
function endHold() {
    if (holdState !== 'pressing') { clearHoldTimers(); return; }
    const heldMs = Date.now() - holdStartTs;
    clearHoldTimers();
    const btn = document.getElementById('mia-action');
    if (btn) btn.classList.remove('mia-action-arming');
    holdState = 'idle';
    if (heldMs < CLEAR_HOLD_DELAY_MS) onPrimaryAction();
    else renderActionState();
}
function cancelHold() {
    clearHoldTimers();
    const btn = document.getElementById('mia-action');
    if (btn) btn.classList.remove('mia-action-arming');
    holdState = 'idle';
    renderActionState();
}
function clearHoldTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdRingTimer) { clearTimeout(holdRingTimer); holdRingTimer = null; }
}
function performClear() {
    try { activeAbort?.abort(); } catch (_) {}
    clearHistory();
    renderThread([]);
}
function setActionIcon(svg) { const el = document.getElementById('mia-action-icon'); if (el) el.innerHTML = svg; }
function renderActionState() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    const stateName = btn.dataset.state || 'send';
    if (stateName === 'streaming') { setActionIcon(ICON_STOP); btn.title = 'Stop (long-press to clear chat)'; btn.setAttribute('aria-label', 'Stop generating'); }
    else { setActionIcon(ICON_SEND); btn.title = 'Send (long-press to clear chat)'; btn.setAttribute('aria-label', 'Send message'); }
}
function onPrimaryAction() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    if (btn.dataset.state === 'streaming') { try { activeAbort?.abort(); } catch (_) {} return; }
    void doSend();
}
function toggleThinking() { const s = loadSettings(); saveSettings({ thinkingMode: !s.thinkingMode }); refreshThinkingBadge(); }
function refreshThinkingBadge() {
    const s = loadSettings();
    const btn = document.getElementById('mia-thinking-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!s.thinkingMode);
    btn.title = s.thinkingMode ? 'Thinking mode ON — deeper, slower' : 'Thinking mode OFF — faster, lighter';
}
function renderThread(history) {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    if (history.length === 0) {
        thread.innerHTML = `
            <div class="mia-greet">
                <p>Hi, I’m <strong>Mia</strong>. I read the same signal data you see on the page, can call the engine and external sources, and I can drive the app on your behalf — my numbers always match what's on screen.</p>
                <p class="mia-greet-hint">Try asking:</p>
                <div class="mia-suggest-list">
                    <button class="mia-suggest">Show me NVDA and explain the signal.</button>
                    <button class="mia-suggest">Compare AAPL, MSFT, and GOOGL.</button>
                    <button class="mia-suggest">Any breaking news on the symbol I'm looking at?</button>
                    <button class="mia-suggest">What’s the 10y yield doing this month?</button>
                </div>
            </div>`;
        thread.querySelectorAll('.mia-suggest').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById('mia-input');
                input.value = btn.textContent;
                onPrimaryAction();
            });
        });
        return;
    }
    thread.innerHTML = history.map(m => {
        if (m.role === 'user') return `<div class="mia-msg user"><div class="mia-msg-bubble">${escapeHtml(m.content)}</div></div>`;
        return `<div class="mia-msg assistant"><div class="mia-msg-bubble mia-md">${renderMarkdown(m.content)}</div></div>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
}

class PacedRenderer {
    constructor(bubbleId) {
        this.bubbleId = bubbleId;
        this.queue = '';
        this.shown = '';
        this.running = false;
        this.aborted = false;
        this.firstTokenSeen = false;
        this._drainResolvers = [];
    }
    push(chunk) {
        this.queue += chunk;
        if (!this.running) this.tick();
    }
    abort() { this.aborted = true; this._notifyDrain(); }
    waitForDrain() {
        if (!this.running && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this._drainResolvers.push(resolve));
    }
    flushRemaining() {
        if (this.queue.length > 0) {
            this.shown += this.queue;
            this.queue = '';
            this.paint();
        }
        this._notifyDrain();
    }
    _notifyDrain() {
        const r = this._drainResolvers;
        this._drainResolvers = [];
        r.forEach(fn => { try { fn(); } catch (_) {} });
    }
    paint() {
        const el = document.getElementById(this.bubbleId);
        if (!el) return;
        if (!this.firstTokenSeen) {
            el.innerHTML = '';
            this.firstTokenSeen = true;
        }
        // Scrub leaked tool names on every paint so the user never sees them.
        el.innerHTML = renderMarkdown(scrubToolNames(stripAgentNoise(this.shown)));
        const thread = document.getElementById('mia-thread');
        if (thread) thread.scrollTop = thread.scrollHeight;
    }
    async tick() {
        this.running = true;
        while (this.queue.length > 0 && !this.aborted) {
            const ch = this.queue[0];
            this.queue = this.queue.slice(1);
            this.shown += ch;
            this.paint();
            let delay = BASE_DELAY_MS;
            if (ch === '.' || ch === '!' || ch === '?') delay = BASE_DELAY_MS * 3;
            else if (ch === ',' || ch === ';' || ch === ':') delay = BASE_DELAY_MS * 2;
            else if (ch === '\n') delay = BASE_DELAY_MS * 2;
            await new Promise(r => setTimeout(r, delay));
        }
        this.running = false;
        this._notifyDrain();
    }
}

async function doSend() {
    const input = document.getElementById('mia-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    input.value = '';

    const history = loadHistory();
    history.push({ role: 'user', content: text });
    saveHistory(history);
    renderThread(history);

    const bubbleId = 'mia-stream-' + Date.now();
    appendStreamingBubble(bubbleId);

    setSendState('streaming');
    activeAbort = new AbortController();
    const renderer = new PacedRenderer(bubbleId);
    let acc = '';
    const toolResults = [];

    try {
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(currentSignal);
        for await (const ev of runTurn({ system, messages: history, signal: activeAbort.signal, onProgress: m => updateProgress(m) })) {
            if (ev.type === 'tool') {
                toolResults.push(ev);
                showToolBadge(bubbleId, ev.name, ev.kind);
                continue;
            }
            if (ev.type !== 'delta') continue;
            const delta = ev.text;
            if (!delta) continue;
            acc += delta;
            renderer.push(delta);
        }
        await renderer.waitForDrain();

        // Scrub the saved version too so the persisted history never contains leaked names.
        const cleaned = scrubToolNames(stripAgentNoise(acc).trim());
        const ctxText = buildContextBlock(currentSignal);
        const flagged = flagUnverifiedNumbers(cleaned, [ctxText, ...toolResults.map(t => JSON.stringify(t))]);
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: flagged || '(empty reply)' });
        saveHistory(updated);
        renderThread(updated);
    } catch (e) {
        renderer.abort();
        const updated = loadHistory();
        const aborted = e?.name === 'AbortError' || /abort/i.test(e?.message || '');
        if (acc.trim() && aborted) updated.push({ role: 'assistant', content: scrubToolNames(stripAgentNoise(acc).trim()) + '\n\n_(stopped early by you)_' });
        else updated.push({ role: 'assistant', content: aborted ? '_Stopped by you._' : `Sorry — I hit an error: ${e.message}` });
        saveHistory(updated);
        renderThread(updated);
    } finally {
        setSendState('idle');
        activeAbort = null;
        renderUsageMeter(document.getElementById('mia-usage-wrap'));
        document.getElementById('mia-input')?.focus();
    }
}

function stripAgentNoise(s) {
    return String(s || '').replace(/^TOOL:.*$/gim, '').replace(/^RESULT:.*$/gim, '').replace(/\n{3,}/g, '\n\n');
}
function appendStreamingBubble(bubbleId) {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    if (document.getElementById(bubbleId)) return;
    thread.insertAdjacentHTML('beforeend', `
        <div class="mia-msg assistant">
            <div class="mia-msg-bubble mia-md" id="${bubbleId}">
                ${ECG_THINKING_SVG}
                <span class="mia-progress" id="mia-progress">thinking…</span>
                <div class="mia-progress-bar" id="mia-progress-bar" hidden><div class="mia-progress-bar-fill" id="mia-progress-bar-fill"></div></div>
            </div>
        </div>
    `);
    thread.scrollTop = thread.scrollHeight;
}
function showToolBadge(bubbleId, name, kind = 'read') {
    const el = document.getElementById(bubbleId);
    if (!el) return;
    const verb = actionVerbFor(name);
    const icon = kind === 'control' ? '🎹' : '⚡';
    const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
    el.insertAdjacentHTML('beforeend', `<div class="mia-tool-badge">${icon} ${cap}…</div>`);
    const pg = document.getElementById('mia-progress');
    if (pg) pg.textContent = `${cap}…`;
}
function updateProgress(msg) {
    const text = document.getElementById('mia-progress');
    const bar = document.getElementById('mia-progress-bar');
    const fill = document.getElementById('mia-progress-bar-fill');
    if (typeof msg === 'object' && msg) {
        const friendly = msg.friendly || msg.text || 'Working…';
        const pct = Math.max(0, Math.min(100, Math.round(msg.percent || 0)));
        if (text) text.textContent = friendly;
        if (msg.phase === 'loading' || msg.phase === 'downloading') {
            if (bar) bar.hidden = false;
            if (fill) fill.style.width = pct + '%';
        } else { if (bar) bar.hidden = true; }
        return;
    }
    if (typeof msg === 'string') {
        const cleaned = msg.replace(/\bcalling\s+([a-z_]+)/i, (_m, tn) => actionVerbFor(tn));
        if (text) text.textContent = cleaned;
        if (bar) bar.hidden = true;
    }
}
function setSendState(stateName) {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    btn.dataset.state = stateName;
    renderActionState();
}
function renderSettings() {
    const panel = document.getElementById('mia-panel');
    const s = loadSettings();
    const routing = getRoutingSummary();
    const fbHint = routing.fallback ? `auto-fallback to ${routing.fallback}` : 'no fallback configured';
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">${MIA_LOGO_SVG}</span>
                <div><div class="mia-name">Mia Settings</div><div class="mia-role">backend, keys, cleanup</div></div>
            </div>
            <div class="mia-head-actions">
                <button class="mia-icon-btn" id="mia-back" title="Back">←</button>
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-settings">
            <div class="mia-setting-row"><span>Primary backend</span><span class="mia-setting-val">${s.backend || '(unset)'}</span></div>
            <div class="mia-setting-row"><span>Routing</span><span class="mia-setting-val">${fbHint}</span></div>
            <div class="mia-setting-row"><span>Thinking mode</span><span class="mia-setting-val">${s.thinkingMode ? 'on' : 'off'}</span></div>
            <div class="mia-setting-row"><span>Auto-fallback</span><span class="mia-setting-val">${s.fallbackEnabled ? 'on' : 'off'}</span></div>
            <button class="mia-save-btn" id="mia-resetup">Switch backend / re-set up</button>
            <button class="mia-save-btn" id="mia-toggle-fallback">${s.fallbackEnabled ? 'Disable' : 'Enable'} auto-fallback</button>
            <button class="mia-clear-btn" id="mia-forget-keys">Forget API keys</button>
            <button class="mia-clear-btn" id="mia-clear-models">Clear legacy WebLLM cache (if any)</button>
            <p class="mia-help">Keys and chat history live in this browser only. Clearing site data wipes everything.</p>
        </div>`;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-back').addEventListener('click', renderChat);
    document.getElementById('mia-resetup').addEventListener('click', () => { clearSettings(); renderRoot(); });
    document.getElementById('mia-toggle-fallback').addEventListener('click', () => { saveSettings({ fallbackEnabled: !s.fallbackEnabled }); renderSettings(); });
    document.getElementById('mia-forget-keys').addEventListener('click', () => { saveSettings({ groqKey: '', cfKey: '', cfAccountId: '' }); renderSettings(); });
    document.getElementById('mia-clear-models').addEventListener('click', async () => { try { await webllmShim.clearCache(); alert('Legacy WebLLM cache (if any) cleared.'); } catch (e) { alert('Clear failed: ' + e.message); } });
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
