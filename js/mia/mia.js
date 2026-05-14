// Mia UI: launcher button, slide-in panel, chat thread, settings.

import { callLLM, pingBackend, POLLINATIONS_MODELS, POLLINATIONS_DEFAULT } from './llm-client.js';
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
    thread.innerHTML = history.map(m => {
        const meta = m.modelNote ? `<div class="mia-msg-meta">${m.modelNote}</div>` : '';
        return `<div class="mia-msg ${m.role}">
            <div class="mia-msg-bubble">${escapeHtml(m.content)}${meta}</div>
        </div>`;
    }).join('');
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
        const { reply, model } = await callLLM({ system, messages: history, settings });
        const chosen = settings.pollinationsModel || POLLINATIONS_DEFAULT;
        const fellBack = settings.backend === 'pollinations' && model && model !== chosen;
        const updated = loadHistory();
        updated.push({
            role: 'assistant',
            content: reply,
            modelNote: fellBack ? `answered by ${model} (your pick "${chosen}" was busy)` : '',
        });
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

    const modelOptions = Object.entries(POLLINATIONS_MODELS).map(([id, info]) =>
        `<option value="${id}" ${settings.pollinationsModel === id ? 'selected' : ''}>${info.label}</option>`
    ).join('');
    const currentDesc = POLLINATIONS_MODELS[settings.pollinationsModel]?.desc || '';

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
                <input type="radio" name="mia-backend" value="pollinations" ${settings.backend === 'pollinations' ? 'checked' : ''}>
                <span><strong>Free — no key, no signup</strong>. Multiple models. Auto-falls back if one is busy.</span>
            </label>

            <div class="mia-submenu" id="mia-poll-submenu" ${settings.backend !== 'pollinations' ? 'style="opacity:0.5"' : ''}>
                <label class="mia-field">
                    Preferred free model
                    <select id="mia-poll-model">${modelOptions}</select>
                </label>
                <p class="mia-model-desc" id="mia-model-desc">${currentDesc}</p>
            </div>

            <label class="mia-radio">
                <input type="radio" name="mia-backend" value="openai" ${settings.backend === 'openai' ? 'checked' : ''}>
                <span><strong>OpenAI (BYOK)</strong> — fastest, your own API key. Charged to your OpenAI account. Stored only in your browser.</span>
            </label>
            <label class="mia-field">
                OpenAI API Key
                <input type="password" id="mia-openai-key" placeholder="sk-..." value="${escapeAttr(settings.openaiKey)}">
            </label>

            <div class="mia-settings-row">
                <button class="mia-save-btn" id="mia-save-settings">Save</button>
                <button class="mia-test-btn" id="mia-test-conn">Test connection</button>
            </div>
            <div id="mia-test-result" class="mia-test-result"></div>
            <button class="mia-clear-btn" id="mia-clear-history">Clear conversation history</button>
            <p class="mia-help">Mia never sends data anywhere except directly to the chosen LLM provider.</p>
        </div>`;

    document.getElementById('mia-close-btn').addEventListener('click', togglePanel);
    document.getElementById('mia-back-btn').addEventListener('click', renderPanel);

    const modelSelect = document.getElementById('mia-poll-model');
    const descEl = document.getElementById('mia-model-desc');
    modelSelect.addEventListener('change', () => {
        descEl.textContent = POLLINATIONS_MODELS[modelSelect.value]?.desc || '';
    });

    panel.querySelectorAll('input[name="mia-backend"]').forEach(r => r.addEventListener('change', () => {
        const sub = document.getElementById('mia-poll-submenu');
        if (sub) sub.style.opacity = r.value === 'pollinations' && r.checked ? '1' : '0.5';
    }));

    document.getElementById('mia-save-settings').addEventListener('click', () => {
        const backend = panel.querySelector('input[name="mia-backend"]:checked')?.value || 'pollinations';
        const pollinationsModel = modelSelect.value;
        const openaiKey = document.getElementById('mia-openai-key').value.trim();
        saveSettings({ backend, pollinationsModel, openaiKey });
        renderPanel();
    });
    document.getElementById('mia-test-conn').addEventListener('click', async () => {
        const out = document.getElementById('mia-test-result');
        out.textContent = 'Testing… (heavy models can take 10-30s; auto-falls back if busy)';
        out.className = 'mia-test-result testing';
        const backend = panel.querySelector('input[name="mia-backend"]:checked')?.value || 'pollinations';
        const pollinationsModel = modelSelect.value;
        const openaiKey = document.getElementById('mia-openai-key').value.trim();
        const { ok, msg } = await pingBackend({ backend, pollinationsModel, openaiKey });
        out.textContent = msg;
        out.className = `mia-test-result ${ok ? 'ok' : 'fail'}`;
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
