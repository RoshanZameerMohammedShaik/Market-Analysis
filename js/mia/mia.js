// Mia UI: launcher + slide-in panel + chat thread.
// No backend picker, no model picker, no BYOK — just chat.

import { callLLM } from './llm-client.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';

let currentSignal = null;
let panelOpen = false;
let sending = false;

export function setLatestSignal(sig) { currentSignal = sig; }

export function initMia() {
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return;
    launcher.addEventListener('click', togglePanel);
}

function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById('mia-panel');
    if (!panel) return;
    if (panelOpen) {
        panel.setAttribute('aria-hidden', 'false');
        renderPanel();
        panel.classList.add('open');
    } else {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
    }
}

function renderPanel() {
    const panel = document.getElementById('mia-panel');
    const history = loadHistory();

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
                <button class="mia-icon-btn" id="mia-clear-btn" title="Clear conversation">🗑</button>
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-thread" id="mia-thread"></div>
        <div class="mia-foot">
            <textarea id="mia-input" rows="2" placeholder="Ask Mia about a stock, an indicator, or what the signal means..."></textarea>
            <button id="mia-send" class="mia-send-btn" title="Send">↑</button>
        </div>
        <div class="mia-disclaimer">Mia is an AI analyst. Numbers come from the on-screen signal — not financial advice.</div>
    `;

    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-clear-btn').addEventListener('click', () => {
        if (confirm('Clear the conversation with Mia?')) {
            clearHistory();
            renderThread([]);
        }
    });
    document.getElementById('mia-send').addEventListener('click', () => sendMessage());
    document.getElementById('mia-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    renderThread(history);
}

function renderThread(history) {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    if (history.length === 0) {
        thread.innerHTML = `
            <div class="mia-greet">
                <p>Hi, I’m <strong>Mia</strong>. I read the same signal data you see on the page, so my numbers always match.</p>
                <p class="mia-greet-hint">Try asking:</p>
                <div class="mia-suggest-list">
                    <button class="mia-suggest">What does the current signal mean?</button>
                    <button class="mia-suggest">Why is confidence at this level?</button>
                    <button class="mia-suggest">Explain ADX in plain English.</button>
                    <button class="mia-suggest">What’s the biggest risk on this trade?</button>
                </div>
            </div>`;
        thread.querySelectorAll('.mia-suggest').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById('mia-input');
                input.value = btn.textContent;
                sendMessage();
            });
        });
        return;
    }
    thread.innerHTML = history.map(m => `
        <div class="mia-msg ${m.role}">
            <div class="mia-msg-bubble">${escapeHtml(m.content)}</div>
        </div>`).join('');
    thread.scrollTop = thread.scrollHeight;
}

async function sendMessage(forced) {
    if (sending) return;
    const input = document.getElementById('mia-input');
    const text = (forced ?? input.value).trim();
    if (!text) return;
    input.value = '';

    const history = loadHistory();
    history.push({ role: 'user', content: text });
    saveHistory(history);
    renderThread(history);
    appendLoadingBubble();

    sending = true;
    document.getElementById('mia-send')?.setAttribute('disabled', 'disabled');

    try {
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(currentSignal);
        const { reply } = await callLLM({ system, messages: history });
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: reply });
        saveHistory(updated);
        renderThread(updated);
    } catch (e) {
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: `Sorry — I hit an error: ${e.message}` });
        saveHistory(updated);
        renderThread(updated);
    } finally {
        sending = false;
        document.getElementById('mia-send')?.removeAttribute('disabled');
        document.getElementById('mia-input')?.focus();
    }
}

function appendLoadingBubble() {
    const thread = document.getElementById('mia-thread');
    if (!thread) return;
    thread.insertAdjacentHTML('beforeend', `
        <div class="mia-msg assistant loading-bubble">
            <div class="mia-msg-bubble"><span class="mia-typing"><i></i><i></i><i></i></span></div>
        </div>`);
    thread.scrollTop = thread.scrollHeight;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
