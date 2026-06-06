// Mia v3.6 — trading-bar thinking animation.
//
// Phase 8.7 fix: ECG sweep felt medical. Replaced with six pulsing
// candlestick-style bars that rise/fall in a wave (mimics a price chart
// breath). All other behavior preserved.

import { runTurn } from './agent.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';
import { renderMarkdown } from './markdown.js';
import { loadSettings, saveSettings, isConfigured, clearSettings } from './settings.js';
import { renderWelcome, MIA_LOGO_SVG } from './welcome.js';
import { renderUsageMeter } from './usage-meter.js';
import { webllm as webllmShim, getRoutingSummary } from './llm-client.js';
import { flagUnverifiedNumbers, UNVERIFIED_TOKEN_RE } from './guard.js';
import { initVoice, attachVoiceButton } from './voice.js';
import { registerSidePanel, openSidePanel, closeSidePanel, isSidePanelOpen } from '../ui/side-panel-stack.js';
import { flashShimmer } from '../ui/flash-shimmer.js';
import { morphToggleToSend, morphSendToToggle } from '../ui/mia-morph.js';
import { setLauncherVis } from '../ui/launcher-vis.js';
import { startThinking, stopThinking, setSoundEnabled, isSoundEnabled, tick as soundTick, complete as soundComplete } from './sound.js';
import { isUiSoundEnabled, setUiSoundEnabled, click as uiClick } from '../ui/ui-sound.js';

let currentSignal = null;
let panelOpen = false;
let activeAbort = null;
// Tracks an in-flight LLM turn so we can resume the streaming UI when
// the panel is closed mid-stream and reopened. closing the panel
// preserves the DOM (it's hidden via the side-panel stack, not
// unmounted) but reopen calls renderChat() which wipes innerHTML —
// the in-flight stream then writes to a bubble that no longer exists,
// and the user sees nothing until the call completes. By keeping the
// renderer + last-known status text here, reopen can re-create a
// streaming bubble and re-point the renderer at it.
let activeStream = null; // { renderer, status }

const CLEAR_HOLD_MS = 3000;
const CLEAR_HOLD_DELAY_MS = 500;

const RENDER_CPS = 70;
const BASE_DELAY_MS = 1000 / RENDER_CPS;

const ACTION_VERBS = {
    get_app_state: 'reading the page',
    get_current_signal: 'reading the current signal',
    get_calibration: 'checking calibration',
    get_accuracy_stats: 'reading accuracy stats',
    explain_prediction: 'pulling the top drivers',
    find_similar_setups: 'searching past similar setups',
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
    set_penny_filter: 'filtering hot picks',
    open_spikers: 'opening Spikers',
    open_about: 'opening About',
    toggle_currency: 'switching currency',
    scroll_to: 'jumping to that section',
    pl_calculate: 'running the P&L calculator',
    find_spikers: 'scanning for spike candidates',
    get_prediction_log: 'reading prediction history',
    get_source_accuracy: 'checking source accuracy',
    get_ledger_history: 'reading live ledger history',
    get_live_calibration: 'checking live calibration',
    get_top_losers: "scanning today's biggest movers",
    get_portfolio: 'reading your portfolio',
    place_trade: 'placing the trade',
    compute: 'crunching the math',
    set_theme: 'switching theme',
    focus_search: 'jumping to search',
    clear_chat: 'clearing the chat',
    copy_to_clipboard: 'copying that for you',
};
export function actionVerbFor(toolName) { return ACTION_VERBS[toolName] || 'looking it up'; }

const TOOL_NAMES = Object.keys(ACTION_VERBS);
const TOOL_NAMES_RE_BODY = TOOL_NAMES.join('|');

const SNAKE_TOOL_RE = /\b(?:get|set|fetch|run|load|save|refresh|switch|select|toggle|cycle|rerun|compare|analyze|check|read|search|invoke|call|use)_[a-z][a-z0-9_]{2,}\b/gi;

const SCAFFOLDING_PATTERNS = [
    new RegExp(`\\b(?:by\\s+|via\\s+|through\\s+)?calling\\s+(?:the\\s+)?(${TOOL_NAMES_RE_BODY})(?:\\s+tool)?\\b`, 'gi'),
    new RegExp(`\\b(?:I'll|I will|let me|I can|I should|I'd|I would|I'm going to|going to)\\s+(?:call|use|run|invoke|consult|hit|query|trigger|fire)\\s+(?:the\\s+)?(${TOOL_NAMES_RE_BODY})(?:\\s+tool)?\\b`, 'gi'),
    new RegExp(`\\b(?:using|with|via|through)\\s+(?:the\\s+)?(${TOOL_NAMES_RE_BODY})(?:\\s+tool)?\\b`, 'gi'),
    new RegExp(`\\b(?:the\\s+)?(${TOOL_NAMES_RE_BODY})\\s+tool\\b`, 'gi'),
    new RegExp(`\\b(?:you\\s+can\\s+see|available|retrieved|fetched|obtained|seen)\\s+(?:by|from|via|through)\\s+(?:the\\s+)?(${TOOL_NAMES_RE_BODY})(?:\\s+tool)?\\b`, 'gi'),
    new RegExp(`\\b(?:from|by|via)\\s+(?:the\\s+)?(${TOOL_NAMES_RE_BODY})(?:\\s+tool)?\\b`, 'gi'),
    new RegExp(`\\b(?:the\\s+)?(${TOOL_NAMES_RE_BODY})\\s+(?:function|command|method|api|endpoint)\\b`, 'gi'),
];

const CODE_FORMATTED_RE = new RegExp('`(' + TOOL_NAMES_RE_BODY + ')`', 'gi');
const BOLD_FORMATTED_RE = new RegExp('\\*\\*(' + TOOL_NAMES_RE_BODY + ')\\*\\*', 'gi');
const BARE_KNOWN_RE = new RegExp('\\b(' + TOOL_NAMES_RE_BODY + ')\\b', 'gi');

function scrubToolNames(text) {
    if (!text) return text;
    let out = text;
    // Safety net: any "TOOL:" prefix that slipped past agent.js (partial JSON,
    // unusual streaming chunk boundary) gets stripped from the visible reply.
    // Drop anything from "TOOL:" through end-of-line, plus any bare-name
    // invocation lines (e.g. "rerun_analysis {}") that look like calls.
    out = out.replace(/(?:^|\s)TOOL:[^\n]*/gim, '');
    out = out.replace(/^\s*[a-z][a-z0-9_]+\s*\{[^\n]*\}\s*$/gim, '');
    for (const re of SCAFFOLDING_PATTERNS) {
        out = out.replace(re, (_m, name) => actionVerbFor((name || '').toLowerCase()));
    }
    out = out.replace(CODE_FORMATTED_RE, (_m, name) => actionVerbFor(name.toLowerCase()));
    out = out.replace(BOLD_FORMATTED_RE, (_m, name) => actionVerbFor(name.toLowerCase()));
    out = out.replace(BARE_KNOWN_RE, (m) => actionVerbFor(m.toLowerCase()));
    out = out.replace(SNAKE_TOOL_RE, () => 'looking it up');
    out = out.replace(/\bthe\s+(reading|checking|running|comparing|searching|loading|switching|toggling|refreshing|rerunning|doing\s+deep\s+research|looking\s+it\s+up)\b/gi, '$1');
    out = out.replace(/\s{2,}/g, ' ');
    out = out.replace(/\s+([.,;:!?])/g, '$1');
    return out;
}

const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4 1.06L4.5 11l8 1-8 1L2 19.34a1 1 0 0 0 1.4 1.06z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';

// Trading-bar thinking indicator: six pulsing candlestick-style bars.
// Visually says "market" instead of "hospital". CSS does the animation.
const THINKING_INDICATOR_HTML = `<span class="mia-thinking-bars" aria-label="Mia is thinking"><i></i><i></i><i></i><i></i><i></i><i></i></span>`;

export function setLatestSignal(sig) { currentSignal = sig; window.__miaLatestSignal = sig || null; }
export function initMia() {
    registerSidePanel('mia', {
        width: () => Math.min(400, window.innerWidth * 0.96), // matches .mia-panel width
        getElement: () => document.getElementById('mia-panel'),
        onLayout: () => {
            const panel = document.getElementById('mia-panel');
            if (!panel) return;
            const open = isSidePanelOpen('mia');
            panel.classList.toggle('open', open);
            panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        },
    });
    document.getElementById('mia-launcher')?.addEventListener('click', togglePanel);
    initLauncherReadyDot();
    initVoice();
}
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
    // Source of truth is the stack, NOT the local panelOpen flag.
    // Voice mode opens the Mia panel directly via openSidePanel('mia'),
    // bypassing this function — so panelOpen would desync and the ✕
    // would do the wrong thing on first click. Reading from the stack
    // guarantees the click always toggles whatever's actually visible.
    const panel = document.getElementById('mia-panel');
    if (!panel) return;
    const wasOpen = isSidePanelOpen('mia');
    panelOpen = !wasOpen;
    if (panelOpen) {
        // Route through the side-panel stack so Mia and Portfolio
        // coordinate position when both are open. Stack handles the
        // .open class + aria-hidden via the registered onLayout
        // callback; we just need to render inside.
        openSidePanel('mia');
        // Hide the launcher while chat panel is open in chat mode —
        // we'd be competing with the panel header otherwise. Voice
        // mode and agentic stage override this back to 'orb'.
        setLauncherVis('hidden');
        renderRoot();
        // Toggle → send-button morph runs in parallel with the panel
        // slide-in. The morph helper grabs the send-button's rect on
        // the next frame (after renderChat() mounts it) and animates
        // a clone of the toggle to land on it.
        morphToggleToSend();
        // One-shot shimmer on Mia's name in the chat header so the
        // user's eye lands on the destination right after the panel
        // slides in. Theme-aware via .flash-shimmer in mia.css.
        requestAnimationFrame(() => {
            flashShimmer(document.querySelector('#mia-panel .mia-name'));
        });
    } else {
        // Reverse morph BEFORE the panel slides out so the send button
        // is still mounted and we can read its rect.
        morphSendToToggle();
        closeSidePanel('mia');
        setLauncherVis('visible');
    }
}
function renderRoot() {
    const panel = document.getElementById('mia-panel');
    if (!isConfigured()) { renderWelcome(panel, () => renderChat()); return; }
    renderChat();
    // If a stream is in flight (user closed the panel mid-thinking),
    // re-attach the streaming bubble so the user sees it resume
    // instead of waiting silently until the call completes.
    if (activeStream?.renderer) resumeActiveStream();
}

// Re-creates the streaming bubble after a panel re-render and points
// the in-flight PacedRenderer at the new bubble. Preserves whatever
// the renderer already painted (renderer.shown) and the latest status
// caption so reopen feels like the panel never left.
function resumeActiveStream() {
    const stream = activeStream;
    if (!stream) return;
    const newBubbleId = 'mia-stream-' + Date.now();
    appendStreamingBubble(newBubbleId);
    // Re-point the renderer's target to the new bubble. paint() reads
    // bubbleId at call time, so swapping it here is sufficient — the
    // next push() (or our explicit repaint below) lands in the new
    // node. firstTokenSeen=true because we want paint() to overwrite
    // with the accumulated text, not preserve the thinking indicator.
    stream.renderer.bubbleId = newBubbleId;
    if (stream.renderer.shown) {
        stream.renderer.firstTokenSeen = true;
        stream.renderer.paint();
    }
    // Restore the status caption ("Reading the news…", "thinking…", etc.).
    const text = document.getElementById('mia-progress');
    if (text && stream.status) text.textContent = stream.status;
    setSendState('streaming');
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
    `;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-settings-btn').addEventListener('click', renderSettings);
    wireActionButton();
    document.getElementById('mia-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onPrimaryAction(); }
        if (e.key === 'K' && e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); performClear(); }
    });
    renderUsageMeter(document.getElementById('mia-usage-wrap'));
    renderThread(loadHistory());
    attachVoiceButton();
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
// Note: the manual "thinking mode" toggle was removed in favor of auto
// tier-fallback (Flash-Lite ↔ Flash). The intent classifier picks the
// right tier per query and the cooldown map auto-falls-back when one
// tier is rate-limited. settings.thinkingMode still exists in storage
// as an internal escape hatch — if a future power-user toggle is needed,
// re-add the button bound to a setter and the existing routing logic
// will respect it.
export function renderThread(history) {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    if (history.length === 0) {
        thread.innerHTML = `
            <div class="mia-greet">
                <p>Hi, I’m <strong>Mia</strong>. Ask me anything — I can call the engine, pull external sources, and drive the app for you.</p>
                <p class="mia-greet-hint">Try asking:</p>
                <div class="mia-suggest-list">
                    <button class="mia-suggest mia-suggest-brief" data-prompt="Brief me on the market right now. Check my watchlist for any signals that flipped, today's top hot picks, the current macro regime, and any notable upcoming earnings. Give me a tight, scannable morning briefing — lead with what changed or what's most actionable, use the tools to ground every number, and keep it to a few short sections. Don't dump raw tool output; synthesize it like an analyst checking in.">☀️ Brief me — what's moving right now</button>
                    <button class="mia-suggest">Deep-dive NVDA: signal, news, and your read.</button>
                    <button class="mia-suggest">Filter Hot Picks to under $5.</button>
                    <button class="mia-suggest">If I put $1,000 in TSLA at $200, P&L at $250?</button>
                    <button class="mia-suggest">Compare AAPL, MSFT, and GOOGL.</button>
                </div>
            </div>`;
        thread.querySelectorAll('.mia-suggest').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById('mia-input');
                // A chip may carry a richer hidden instruction via data-prompt
                // (e.g. "Brief me" expands to a full briefing directive Mia
                // orchestrates her own tools to fulfil); else use its label.
                input.value = btn.dataset.prompt || btn.textContent;
                onPrimaryAction();
            });
        });
        return;
    }
    thread.innerHTML = history.map(m => {
        if (m.role === 'user') return `<div class="mia-msg user"><div class="mia-msg-bubble">${escapeHtml(m.content)}</div></div>`;
        return `<div class="mia-msg assistant"><div class="mia-msg-bubble mia-md">${renderWithFootnote(m.content)}</div></div>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
}

// Strip the §§MIA_UNVERIFIED:...§§ sentinel before markdown rendering
// and append a real (unescaped) footnote div after the rendered HTML.
// The sentinel exists because guard.js can't emit raw HTML: the markdown
// renderer escapes everything, so any HTML the guard injected would show
// up as literal "<div..." text.
function renderWithFootnote(content) {
    const m = String(content || '').match(UNVERIFIED_TOKEN_RE);
    if (!m) return renderMarkdown(content);
    const stripped = content.replace(UNVERIFIED_TOKEN_RE, '').trim();
    const list = m[1];
    const note = `<div class="mia-unverified-note" title="These numbers weren't in tool results or signal data—double-check them."><span class="mia-unverified-icon">⚠</span> Verify: ${escapeHtml(list)}</div>`;
    return renderMarkdown(stripped) + note;
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

    // Fresh math scope per turn so named variables don't leak across turns.
    try {
        const m = await import('./math-tool.js');
        m.resetMathScope?.();
    } catch (_) {}

    const history = loadHistory();
    history.push({ role: 'user', content: text });
    saveHistory(history);
    renderThread(history);

    const bubbleId = 'mia-stream-' + Date.now();
    appendStreamingBubble(bubbleId);

    setSendState('streaming');
    activeAbort = new AbortController();
    const renderer = new PacedRenderer(bubbleId);
    activeStream = { renderer, status: 'thinking…' };
    let acc = '';
    const toolResults = [];
    // Soft "dubudbud" thinking shimmer while Mia generates / runs tools.
    // Stopped the instant the first text delta arrives (she's answering
    // now, not thinking) and unconditionally in the finally block. The
    // text path never speaks, so the sound engine's speaking-gate is a
    // no-op here.
    startThinking();

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
            // First real text → she's answering, not thinking. Hush the loop.
            if (!acc) stopThinking();
            acc += delta;
            renderer.push(delta);
        }
        await renderer.waitForDrain();
        // Note: the `lastProgressAt` watchdog from earlier was reverted
        // because it was firing on transient pauses and abort-classifying
        // legitimate Gemini calls. If responses hang again we'll diagnose
        // via console logs first, not blanket-kill turns.

        const cleaned = scrubToolNames(stripAgentNoise(acc).trim());
        const ctxText = buildContextBlock(currentSignal);
        const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
        const flagged = flagUnverifiedNumbers(cleaned, [ctxText, lastUserMsg, ...toolResults.map(t => JSON.stringify(t))]);
        const updated = loadHistory();
        // If the LLM returned literally nothing (empty stream — Gemini
        // sometimes does this on filter trips, weird quota states, or
        // truncated responses), surface a real "try again" instead of
        // saving a "(empty reply)" placeholder that poisons subsequent
        // turns. Logged in the console so we can see the empty-stream
        // case from F12 → Console.
        if (!flagged) {
            console.warn('[mia] LLM returned an empty reply for user message:', lastUserMsg);
            updated.push({ role: 'assistant', content: 'Hmm, I drew a blank on that one — could you ask again?' });
        } else {
            updated.push({ role: 'assistant', content: flagged });
            // Soft "done" chime when a real answer lands (text path only;
            // the sound engine self-gates while voice TTS is speaking).
            try { soundComplete(); } catch (_) {}
        }
        saveHistory(updated);
        renderThread(updated);
    } catch (e) {
        renderer.abort();
        const updated = loadHistory();
        const aborted = e?.name === 'AbortError' || /abort/i.test(e?.message || '');
        const partial = acc.trim();

        // Preserve the partial answer the user already saw on-screen. If a
        // stream errored mid-flight (rate limit, network blip, etc.) the
        // sensible thing is to keep what was rendered and append a small
        // note — not wipe the whole bubble and replace it with an error.
        if (partial) {
            const cleaned = scrubToolNames(stripAgentNoise(partial).trim());
            const ctxText = buildContextBlock(currentSignal);
            const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
            const flaggedPartial = flagUnverifiedNumbers(cleaned, [ctxText, lastUserMsg, ...toolResults.map(t => JSON.stringify(t))]);
            // Never expose "rate-limited" wording to the user — auto-tier
            // fallback handles quota internally. By the time we land
            // here with a partial reply, the next tier was either
            // cooling too or also hit; we swallow the specifics and
            // tell the user "ask again to continue" which works in
            // both cases.
            const note = aborted
                ? '_(stopped early by you)_'
                : '_(reply cut off — ask again to continue)_';
            updated.push({ role: 'assistant', content: flaggedPartial + '\n\n' + note });
        } else {
            // No partial output. The user-visible message also avoids
            // mentioning "rate limit" specifically — they just see
            // "had trouble; try again" unless it's an auth/key error
            // they need to actually fix.
            let userMsg;
            if (aborted) {
                // Abort fired but no partial output landed. We don't know
                // WHO aborted (manual stop, panel close, watchdog, race) —
                // but the user sees the symptom either way. Surface the
                // raw error message so they (and I) can actually diagnose
                // instead of staring at a polite '_Stopped by you._' lie.
                console.warn('[mia] Turn aborted:', e?.message || '(no message)', e);
                const detail = e?.message ? ` — ${e.message}` : '';
                userMsg = `_Turn was interrupted${detail}. Check the browser console for [mia] entries and try again._`;
            } else if (e?.status === 401 || e?.status === 403 || /API key/i.test(e?.message || '')) {
                userMsg = `Sorry — ${e.message}`;
            } else if (e?.status === 429 || e?.tierCooling) {
                // Hit ALL fallbacks and they're all cooling. This is the
                // only case where the user genuinely needs to know quota
                // was exhausted, but we say it gently without exposing
                // which tier. Cooldown badge in the usage meter shows
                // the technical detail.
                userMsg = "I'm rate-limited across all backends right now — give me a minute and try again.";
            } else {
                // Catch-all. Surface the real error so the next person
                // who hits this (often Roshan) doesn't have to dig
                // through the console to find out what happened. Also
                // log explicitly so a `[mia]` filter shows it.
                console.warn('[mia] Turn failed:', e?.status, e?.message || '(no message)', e);
                const detail = e?.message ? ` — ${e.message}` : '';
                userMsg = `Sorry, I hit an error${detail}. Check the browser console for [mia] entries.`;
            }
            updated.push({ role: 'assistant', content: userMsg });
        }
        saveHistory(updated);
        renderThread(updated);
    } finally {
        stopThinking();   // safety: ensure the loop never strands on
        setSendState('idle');
        activeAbort = null;
        activeStream = null;
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
                ${THINKING_INDICATOR_HTML}
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
        if (activeStream) activeStream.status = friendly;
        return;
    }
    if (typeof msg === 'string') {
        const cleaned = msg.replace(/\bcalling\s+([a-z_]+)/i, (_m, tn) => actionVerbFor(tn));
        if (text) text.textContent = cleaned;
        if (bar) bar.hidden = true;
        if (activeStream) activeStream.status = cleaned;
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
            <div class="mia-setting-row"><span>Voice</span><span class="mia-setting-val">${s.voiceLive ? 'Gemini Live (auto-fallback to browser TTS)' : 'Browser TTS only'}</span></div>
            <div class="mia-setting-row"><span>Mia sounds</span><span class="mia-setting-val">${s.soundEnabled !== false ? 'on' : 'off'}</span></div>
            <div class="mia-setting-row"><span>UI sounds</span><span class="mia-setting-val">${s.uiSoundEnabled !== false ? 'on' : 'off'}</span></div>
            <button class="mia-save-btn" id="mia-resetup">Switch backend / re-set up</button>
            <button class="mia-save-btn" id="mia-toggle-fallback">${s.fallbackEnabled ? 'Disable' : 'Enable'} auto-fallback</button>
            <button class="mia-save-btn" id="mia-toggle-sound">${s.soundEnabled !== false ? 'Mute' : 'Unmute'} Mia sounds</button>
            <button class="mia-save-btn" id="mia-toggle-uisound">${s.uiSoundEnabled !== false ? 'Mute' : 'Unmute'} UI sounds</button>
            <button class="mia-clear-btn" id="mia-forget-keys">Forget API keys</button>
            <button class="mia-clear-btn" id="mia-clear-models">Clear legacy WebLLM cache (if any)</button>
            <p class="mia-help">Keys and chat history live in this browser only. Clearing site data wipes everything.</p>
        </div>`;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-back').addEventListener('click', renderChat);
    document.getElementById('mia-resetup').addEventListener('click', () => { clearSettings(); renderRoot(); });
    document.getElementById('mia-toggle-fallback').addEventListener('click', () => { saveSettings({ fallbackEnabled: !s.fallbackEnabled }); renderSettings(); });
    document.getElementById('mia-toggle-sound').addEventListener('click', () => {
        const next = !isSoundEnabled();
        setSoundEnabled(next);          // persists + silences any active loop
        if (next) { try { soundTick(); } catch (_) {} }   // little confirmation pop on enable
        renderSettings();
    });
    document.getElementById('mia-toggle-uisound').addEventListener('click', () => {
        const next = !isUiSoundEnabled();
        setUiSoundEnabled(next);        // persists + mutes/unmutes the UI layer
        if (next) { try { uiClick(); } catch (_) {} }   // confirmation pop on enable
        renderSettings();
    });
    document.getElementById('mia-forget-keys').addEventListener('click', () => { saveSettings({ geminiKey: '', cfKey: '', cfAccountId: '' }); renderSettings(); });
    document.getElementById('mia-clear-models').addEventListener('click', async () => { try { await webllmShim.clearCache(); alert('Legacy WebLLM cache (if any) cleared.'); } catch (e) { alert('Clear failed: ' + e.message); } });
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
