// Mia v2 with tool-use loop, anti-hallucination guard, and defensive
// null-safety on the streaming bubble.

import { runTurn } from './agent.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';
import { renderMarkdown } from './markdown.js';
import { loadSettings, saveSettings, isConfigured, clearSettings } from './settings.js';
import { renderWelcome, MIA_LOGO_SVG } from './welcome.js';
import { renderUsageMeter } from './usage-meter.js';
import { webllm as webllmBackend } from './llm-client.js';
import { flagUnverifiedNumbers } from './guard.js';
import { startPrewarm } from './prewarm.js';

let currentSignal = null;
let panelOpen = false;
let activeAbort = null;

const CLEAR_HOLD_MS = 3000;
const CLEAR_HOLD_DELAY_MS = 500; // delay before showing progress ring

// Inline SVG icons for the unified send/stop/clear button.
const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4 1.06L4.5 11l8 1-8 1L2 19.34a1 1 0 0 0 1.4 1.06z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';

export function setLatestSignal(sig) { currentSignal = sig; window.__miaLatestSignal = sig || null; }

export function initMia() {
    document.getElementById('mia-launcher')?.addEventListener('click', togglePanel);
    // Background-load WebLLM weights so first open is instant.
    startPrewarm();
}

function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById('mia-panel');
    if (!panel) return;
    if (panelOpen) {
        panel.setAttribute('aria-hidden', 'false');
        panel.classList.add('open');
        renderRoot();
    } else {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }
}

function renderRoot() {
    const panel = document.getElementById('mia-panel');
    if (!isConfigured()) {
        renderWelcome(panel, () => renderChat());
        return;
    }
    renderChat();
}

function renderChat() {
    const panel = document.getElementById('mia-panel');
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">${MIA_LOGO_SVG}</span>
                <div>
                    <div class="mia-name">Mia</div>
                    <div class="mia-role">Market Intelligence Analyst</div>
                </div>
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
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onPrimaryAction();
        }
        // Ctrl/Cmd+Shift+K clears chat (keyboard alternative to long-press).
        if (e.key === 'K' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            performClear();
        }
    });
    refreshThinkingBadge();
    renderUsageMeter(document.getElementById('mia-usage-wrap'));
    renderThread(loadHistory());
}

// ===== Unified action button =====

let holdTimer = null;
let holdStartTs = 0;
let holdRingTimer = null;
let holdState = 'idle'; // 'idle' | 'pressing' | 'firing'

function wireActionButton() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;

    const start = (e) => {
        if (e.button !== undefined && e.button !== 0) return; // left click only
        e.preventDefault();
        beginHold();
    };
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
    // After CLEAR_HOLD_DELAY_MS (500ms), reveal the progress ring + start filling.
    holdRingTimer = setTimeout(() => {
        if (holdState !== 'pressing') return;
        btn.classList.add('mia-action-arming');
        setActionIcon(ICON_TRASH);
    }, CLEAR_HOLD_DELAY_MS);
    // Full hold = clear.
    holdTimer = setTimeout(() => {
        if (holdState !== 'pressing') return;
        holdState = 'firing';
        performClear();
        // Reset visuals after the clear.
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
    if (holdState !== 'pressing') {
        // Already fired or already idle
        clearHoldTimers();
        return;
    }
    const heldMs = Date.now() - holdStartTs;
    clearHoldTimers();
    const btn = document.getElementById('mia-action');
    if (btn) btn.classList.remove('mia-action-arming');
    holdState = 'idle';
    if (heldMs < CLEAR_HOLD_DELAY_MS) {
        // It was a tap, not a hold — perform the primary action.
        onPrimaryAction();
    } else {
        // Held briefly but released before clear threshold — cancel quietly.
        renderActionState();
    }
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

function setActionIcon(svg) {
    const el = document.getElementById('mia-action-icon');
    if (el) el.innerHTML = svg;
}

function renderActionState() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    const state = btn.dataset.state || 'send';
    if (state === 'streaming') {
        setActionIcon(ICON_STOP);
        btn.title = 'Stop (long-press to clear chat)';
        btn.setAttribute('aria-label', 'Stop generating');
    } else {
        setActionIcon(ICON_SEND);
        btn.title = 'Send (long-press to clear chat)';
        btn.setAttribute('aria-label', 'Send message');
    }
}

function onPrimaryAction() {
    const btn = document.getElementById('mia-action');
    if (!btn) return;
    if (btn.dataset.state === 'streaming') {
        try { activeAbort?.abort(); } catch (_) {}
        return;
    }
    void doSend();
}

function toggleThinking() {
    const s = loadSettings();
    saveSettings({ thinkingMode: !s.thinkingMode });
    refreshThinkingBadge();
}
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
                <p>Hi, I’m <strong>Mia</strong>. I read the same signal data you see on the page, and I can run analyses on demand. My numbers always match.</p>
                <p class="mia-greet-hint">Try asking:</p>
                <div class="mia-suggest-list">
                    <button class="mia-suggest">Analyze NVDA for tomorrow.</button>
                    <button class="mia-suggest">What does the current signal mean?</button>
                    <button class="mia-suggest">Compare AAPL, MSFT, and GOOGL.</button>
                    <button class="mia-suggest">What's the market regime right now?</button>
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
        if (m.role === 'user') {
            return `<div class="mia-msg user"><div class="mia-msg-bubble">${escapeHtml(m.content)}</div></div>`;
        }
        return `<div class="mia-msg assistant"><div class="mia-msg-bubble mia-md">${renderMarkdown(m.content)}</div></div>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
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
    let acc = '';
    let receivedAny = false;
    const toolResults = [];

    try {
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(currentSignal);
        for await (const ev of runTurn({ system, messages: history, signal: activeAbort.signal, onProgress: m => updateProgress(m) })) {
            if (ev.type === 'tool') {
                toolResults.push(ev);
                showToolBadge(bubbleId, ev.name);
                continue;
            }
            if (ev.type !== 'delta') continue;
            const delta = ev.text;
            if (!delta) continue;
            // Lazily reset the bubble on first visible content, with a null guard.
            const el = document.getElementById(bubbleId);
            if (!el) {
                // Bubble was removed (clear, settings open, etc). Recreate it
                // and continue — don't crash.
                appendStreamingBubble(bubbleId);
            }
            const el2 = document.getElementById(bubbleId);
            if (!el2) {
                // Still gone (panel closed?). Just accumulate text silently.
                acc += delta;
                continue;
            }
            if (!receivedAny) {
                el2.innerHTML = '';
                receivedAny = true;
            }
            acc += delta;
            el2.innerHTML = renderMarkdown(stripAgentNoise(acc));
            const thread = document.getElementById('mia-thread');
            if (thread) thread.scrollTop = thread.scrollHeight;
        }
        const cleaned = stripAgentNoise(acc).trim();
        const ctxText = buildContextBlock(currentSignal);
        const flagged = flagUnverifiedNumbers(cleaned, [ctxText, ...toolResults.map(t => JSON.stringify(t))]);
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: flagged || '(empty reply)' });
        saveHistory(updated);
        renderThread(updated);
    } catch (e) {
        const updated = loadHistory();
        const aborted = e?.name === 'AbortError' || /abort/i.test(e?.message || '');
        if (acc.trim() && aborted) {
            updated.push({ role: 'assistant', content: stripAgentNoise(acc).trim() + '\n\n_(stopped early by you)_' });
        } else {
            updated.push({ role: 'assistant', content: aborted ? '_Stopped by you._' : `Sorry — I hit an error: ${e.message}` });
        }
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
    // Belt + suspenders: never let TOOL: or RESULT: lines reach saved or rendered output.
    return String(s || '').replace(/^TOOL:.*$/gim, '').replace(/^RESULT:.*$/gim, '').replace(/\n{3,}/g, '\n\n');
}

function appendStreamingBubble(bubbleId) {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    if (document.getElementById(bubbleId)) return; // already there
    thread.insertAdjacentHTML('beforeend', `
        <div class="mia-msg assistant">
            <div class="mia-msg-bubble mia-md" id="${bubbleId}"><span class="mia-typing"><i></i><i></i><i></i></span><span class="mia-progress" id="mia-progress">thinking…</span></div>
        </div>
    `);
    thread.scrollTop = thread.scrollHeight;
}

function showToolBadge(bubbleId, name) {
    const el = document.getElementById(bubbleId);
    if (!el) return;
    el.insertAdjacentHTML('beforeend', `<div class="mia-tool-badge">⚡ used <code>${name}</code></div>`);
}

function updateProgress(msg) {
    const el = document.getElementById('mia-progress');
    if (el) el.textContent = msg;
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
            <div class="mia-setting-row"><span>Backend</span><span class="mia-setting-val">${s.backend || '(unset)'}</span></div>
            <div class="mia-setting-row"><span>Thinking mode</span><span class="mia-setting-val">${s.thinkingMode ? 'on' : 'off'}</span></div>
            <button class="mia-save-btn" id="mia-resetup">Switch backend / re-set up</button>
            <button class="mia-clear-btn" id="mia-forget-keys">Forget API keys</button>
            <button class="mia-clear-btn" id="mia-clear-models">Clear downloaded WebLLM model</button>
            <p class="mia-help">Keys and chat history live in this browser only. Clearing site data wipes everything.</p>
        </div>
    `;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-back').addEventListener('click', renderChat);
    document.getElementById('mia-resetup').addEventListener('click', () => {
        clearSettings();
        renderRoot();
    });
    document.getElementById('mia-forget-keys').addEventListener('click', () => {
        saveSettings({ groqKey: '', cfKey: '', cfAccountId: '' });
        renderSettings();
    });
    document.getElementById('mia-clear-models').addEventListener('click', async () => {
        try { await webllmBackend.clearCache(); alert('WebLLM cache cleared.'); } catch (e) { alert('Clear failed: ' + e.message); }
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
