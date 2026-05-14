// Mia v2 with tool-use loop and anti-hallucination guard.

import { runTurn } from './agent.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';
import { renderMarkdown } from './markdown.js';
import { loadSettings, saveSettings, isConfigured, clearSettings } from './settings.js';
import { renderWelcome } from './welcome.js';
import { renderUsageMeter } from './usage-meter.js';
import { webllm as webllmBackend } from './llm-client.js';
import { flagUnverifiedNumbers } from './guard.js';

let currentSignal = null;
let panelOpen = false;
let activeAbort = null;

export function setLatestSignal(sig) { currentSignal = sig; window.__miaLatestSignal = sig || null; }

export function initMia() {
    document.getElementById('mia-launcher')?.addEventListener('click', togglePanel);
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
                <span class="mia-avatar">🧠</span>
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
            <button id="mia-clear" class="mia-foot-icon" title="Clear conversation">🗑</button>
            <textarea id="mia-input" rows="2" placeholder="Ask Mia about a stock, an indicator, or what the signal means..."></textarea>
            <button id="mia-send" class="mia-send-btn" title="Send" data-state="idle">↑</button>
        </div>
        <div class="mia-disclaimer">Numbers come from the on-screen signal or tools she calls — not financial advice.</div>
    `;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-settings-btn').addEventListener('click', renderSettings);
    document.getElementById('mia-thinking-btn').addEventListener('click', toggleThinking);
    document.getElementById('mia-clear').addEventListener('click', () => {
        clearHistory();
        renderThread([]);
    });
    document.getElementById('mia-send').addEventListener('click', onSendOrStop);
    document.getElementById('mia-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSendOrStop();
        }
    });
    refreshThinkingBadge();
    renderUsageMeter(document.getElementById('mia-usage-wrap'));
    renderThread(loadHistory());
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
                onSendOrStop();
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

async function onSendOrStop() {
    const sendBtn = document.getElementById('mia-send');
    if (sendBtn.dataset.state === 'streaming') {
        try { activeAbort?.abort(); } catch (_) {}
        return;
    }
    const input = document.getElementById('mia-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    const history = loadHistory();
    history.push({ role: 'user', content: text });
    saveHistory(history);
    renderThread(history);

    const thread = document.getElementById('mia-thread');
    const bubbleId = 'mia-stream-' + Date.now();
    thread.insertAdjacentHTML('beforeend', `
        <div class="mia-msg assistant">
            <div class="mia-msg-bubble mia-md" id="${bubbleId}"><span class="mia-typing"><i></i><i></i><i></i></span><span class="mia-progress" id="mia-progress">thinking…</span></div>
        </div>
    `);
    thread.scrollTop = thread.scrollHeight;

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
            if (!receivedAny) {
                document.getElementById(bubbleId).innerHTML = '';
                receivedAny = true;
            }
            acc += delta;
            const el = document.getElementById(bubbleId);
            if (el) el.innerHTML = renderMarkdown(acc);
            thread.scrollTop = thread.scrollHeight;
        }
        // Strip any leftover TOOL: lines from acc (rare, defensive).
        const cleaned = acc.replace(/^TOOL:.*$/gim, '').trim();
        const ctxText = buildContextBlock(currentSignal);
        const flagged = flagUnverifiedNumbers(cleaned, [ctxText, ...toolResults.map(t => JSON.stringify(t))]);
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: flagged || '(empty reply)' });
        saveHistory(updated);
        // Re-render so the persisted (flagged) content shows correctly.
        renderThread(updated);
    } catch (e) {
        const updated = loadHistory();
        const aborted = e?.name === 'AbortError' || /abort/i.test(e?.message || '');
        if (acc.trim() && aborted) {
            updated.push({ role: 'assistant', content: acc.trim() + '\n\n_(stopped early by you)_' });
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

function showToolBadge(bubbleId, name) {
    const el = document.getElementById(bubbleId);
    if (!el) return;
    el.insertAdjacentHTML('beforeend', `<div class="mia-tool-badge">⚡ used <code>${name}</code></div>`);
}

function updateProgress(msg) {
    const el = document.getElementById('mia-progress');
    if (el) el.textContent = msg;
}

function setSendState(state) {
    const btn = document.getElementById('mia-send');
    if (!btn) return;
    btn.dataset.state = state;
    btn.textContent = state === 'streaming' ? '■' : '↑';
    btn.title = state === 'streaming' ? 'Stop' : 'Send';
}

function renderSettings() {
    const panel = document.getElementById('mia-panel');
    const s = loadSettings();
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">⚙️</span>
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
