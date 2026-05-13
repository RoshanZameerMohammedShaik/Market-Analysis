// Mia UI: launcher button, slide-in panel, chat thread, settings.
// Everything happens in this file's DOM scope; rest of the app is unaffected.

import { callLLM } from './llm-client.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory, clearHistory } from './memory.js';
import { loadSettings, saveSettings } from './settings.js';

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
    const settings = loadSettings();
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
                <button class="mia-icon-btn" id="mia-settings-btn" title="Settings">⚙️</button>
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
    document.getElementById('mia-settings-btn').addEventListener('click', openSettings);
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
        const settings = loadSettings();
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(currentSignal);
        const reply = await callLLM({
            system,
            messages: history,
            settings,
        });
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

function openSettings() {
    const settings = loadSettings();
    const panel = document.getElementById('mia-panel');
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">⚙️</span>
                <div><div class="mia-name">Mia Settings</div><div class="mia-role">choose your backend</div></div>
            </div>
            <div class="mia-head-actions">
                <button class="mia-icon-btn" id="mia-back-btn" title="Back">←</button>
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-settings">
            <label class="mia-radio">
                <input type="radio" name="mia-backend" value="hf" ${settings.backend === 'hf' ? 'checked' : ''}>
                <span><strong>HuggingFace</strong> — free, no key. Slower; first call may take 15-20s while the model warms.</span>
            </label>
            <label class="mia-radio">
                <input type="radio" name="mia-backend" value="openai" ${settings.backend === 'openai' ? 'checked' : ''}>
                <span><strong>OpenAI</strong> — fast, requires your own key. Charged to your OpenAI account.</span>
            </label>
            <label class="mia-field">
                OpenAI API Key (only stored in your browser)
                <input type="password" id="mia-openai-key" placeholder="sk-..." value="${escapeAttr(settings.openaiKey)}">
            </label>
            <button class="mia-save-btn" id="mia-save-settings">Save</button>
            <button class="mia-clear-btn" id="mia-clear-history">Clear conversation history</button>
            <p class="mia-help">Mia never sends data anywhere except directly to the chosen LLM provider.</p>
        </div>`;
    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-back-btn').addEventListener('click', renderPanel);
    document.getElementById('mia-save-settings').addEventListener('click', () => {
        const backend = panel.querySelector('input[name="mia-backend"]:checked')?.value || 'hf';
        const openaiKey = document.getElementById('mia-openai-key').value.trim();
        saveSettings({ backend, openaiKey });
        renderPanel();
    });
    document.getElementById('mia-clear-history').addEventListener('click', () => {
        clearHistory();
        renderPanel();
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
}
