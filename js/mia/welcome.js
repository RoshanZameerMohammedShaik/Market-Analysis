// First-open welcome screen — single path: API key (Gemini or Cloudflare).
// Both keys can co-exist; runtime auto-falls-over from Gemini → CF if the
// primary rate-limits.

import { saveSettings, loadSettings } from './settings.js';
import { ping as pingGemini } from './backends/api-gemini.js';
import { ping as pingCf } from './backends/api-cf.js';
import { closeSidePanel } from '../ui/side-panel-stack.js';

// Close the Mia panel THROUGH the side-panel stack so it stays in sync and the
// stack's onLayout restores the launcher. The old handler only did
// panel.classList.remove('open'), which left the stack thinking Mia was still
// open → isSidePanelOpen stayed true → the launcher was hidden forever (the
// "Mia toggle disappears" glitch on the unconfigured/welcome screen).
function closeWelcomePanel(panel) {
    closeSidePanel('mia');
    panel.classList.remove('open');
}

const MIA_LOGO_SVG = `
<svg class="mia-logo mia-ecg-svg" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
        <linearGradient id="mia-logo-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#7c3aed"/>
            <stop offset="50%" stop-color="#3b82f6"/>
            <stop offset="100%" stop-color="#06b6d4"/>
        </linearGradient>
    </defs>
    <circle cx="16" cy="16" r="15" fill="url(#mia-logo-bg)"/>
    <path class="mia-ecg-trace" d="M3 18 L6 18 Q8 18 9 16 T11 18 L14 8 L17 22 L20 8 L23 18 Q25 18 26 16 T28 18 L29 18" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"/>
    <path class="mia-ecg-blip" d="M3 18 L6 18 Q8 18 9 16 T11 18 L14 8 L17 22 L20 8 L23 18 Q25 18 26 16 T28 18 L29 18" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export { MIA_LOGO_SVG };

export function renderWelcome(panel, onConfigured) {
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">${MIA_LOGO_SVG}</span>
                <div><div class="mia-name">Mia</div><div class="mia-role">Market Intelligence Analyst</div></div>
            </div>
            <div class="mia-head-actions">
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-welcome">
            <div class="mia-section-heading">Connect Mia in under a minute</div>
            <div class="mia-card primary" id="mia-card-apikey">
                <div class="mia-card-emoji">⚡</div>
                <div class="mia-card-title">API key — instant + mobile-friendly</div>
                <div class="mia-card-tags">
                    <span>Gemini + Cloudflare</span><span>Auto-fallback</span><span>Free tier</span><span>Gemini 2.5 Flash</span>
                </div>
                <div class="mia-card-body">
                    Paste a free Gemini AI Studio key or Cloudflare key. If you add both, Mia auto-falls-back the moment one rate-limits, so you effectively never run dry. Keys live only in this browser.
                </div>
                <button class="mia-card-btn primary" data-pick="apikey">Set up</button>
            </div>
            <div class="mia-welcome-tip">No accounts, no servers. Both providers have generous free tiers — together they cover hundreds of conversations a day for free.</div>
        </div>
    `;

    panel.querySelector('#mia-close-btn').addEventListener('click', () => closeWelcomePanel(panel));
    panel.querySelector('[data-pick="apikey"]').addEventListener('click', () => renderApiKeySetup(panel, onConfigured));
}

function renderApiKeySetup(panel, onConfigured) {
    const s = loadSettings();
    panel.innerHTML = `
        <div class="mia-head">
            <div class="mia-head-title">
                <span class="mia-avatar">${MIA_LOGO_SVG}</span>
                <div><div class="mia-name">Mia</div><div class="mia-role">Market Intelligence Analyst</div></div>
            </div>
            <div class="mia-head-actions">
                <button class="mia-icon-btn" id="mia-back" title="Back">←</button>
                <button class="mia-icon-btn" id="mia-close-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="mia-setup">
            <div class="mia-section-heading">Pick a provider — or paste both for auto-fallback</div>
            <div class="mia-providers">
                <button class="mia-prov ${s.backend === 'gemini' || (!s.backend && s.geminiKey) ? 'active' : ''}" data-prov="gemini">
                    <div class="mia-prov-name">Gemini <span class="mia-prov-badge">recommended</span></div>
                    <div class="mia-prov-meta">Flash-Lite + Flash • 30 RPM • 250K–1M TPM • free</div>
                </button>
                <button class="mia-prov ${s.backend === 'cloudflare' ? 'active' : ''}" data-prov="cloudflare">
                    <div class="mia-prov-name">Cloudflare Workers AI</div>
                    <div class="mia-prov-meta">Llama 3.3 70B • ~10k neurons/day free</div>
                </button>
            </div>
            <div id="mia-setup-form"></div>
        </div>
    `;

    panel.querySelector('#mia-close-btn').addEventListener('click', () => closeWelcomePanel(panel));
    panel.querySelector('#mia-back').addEventListener('click', () => renderWelcome(panel, onConfigured));

    const formEl = panel.querySelector('#mia-setup-form');
    const renderForm = (prov) => {
        formEl.innerHTML = prov === 'gemini' ? geminiFormHtml(s) : cfFormHtml(s);
        wireForm(prov, formEl, panel, onConfigured);
    };

    panel.querySelectorAll('[data-prov]').forEach(btn => {
        btn.addEventListener('click', () => {
            panel.querySelectorAll('[data-prov]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderForm(btn.dataset.prov);
        });
    });

    const initial = s.backend === 'cloudflare' ? 'cloudflare' : 'gemini';
    panel.querySelector(`[data-prov="${initial}"]`).classList.add('active');
    renderForm(initial);
}

function geminiFormHtml(s) {
    return `
        <ol class="mia-steps">
            <li><span class="mia-step-num">1</span> Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with your Google account.</li>
            <li><span class="mia-step-num">2</span> Click <strong>Create API Key</strong> (free tier — no card required).</li>
            <li><span class="mia-step-num">3</span> Copy the key value and paste below.</li>
        </ol>
        <label class="mia-field">
            Gemini API Key
            <input type="password" id="mia-gemini-key" placeholder="Paste your Gemini API key" value="${escapeAttr(s.geminiKey)}" autocomplete="off" spellcheck="false">
        </label>
        <div class="mia-fallback-hint">
            Tip: paste a Cloudflare key too (next tab) and Mia auto-falls-back when Gemini rate-limits.
        </div>
        <div class="mia-setup-row">
            <button class="mia-save-btn" id="mia-connect">Connect</button>
            <button class="mia-test-btn" id="mia-test">Test</button>
        </div>
        <div id="mia-test-result" class="mia-test-result"></div>
        <p class="mia-help">Your key is stored only in this browser's localStorage. Mia talks to Gemini directly — no server, no proxy.</p>
    `;
}

function cfFormHtml(s) {
    return `
        <ol class="mia-steps">
            <li><span class="mia-step-num">1</span> Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">dash.cloudflare.com/profile/api-tokens</a> and sign in.</li>
            <li><span class="mia-step-num">2</span> Create a token with <strong>Workers AI: Read</strong> permission.</li>
            <li><span class="mia-step-num">3</span> Copy your <strong>Account ID</strong> from the right sidebar of any account page.</li>
            <li><span class="mia-step-num">4</span> Paste both below.</li>
        </ol>
        <label class="mia-field">
            Cloudflare API Token
            <input type="password" id="mia-cf-key" placeholder="…" value="${escapeAttr(s.cfKey)}" autocomplete="off" spellcheck="false">
        </label>
        <label class="mia-field">
            Cloudflare Account ID
            <input type="text" id="mia-cf-acct" placeholder="32-char hex" value="${escapeAttr(s.cfAccountId)}" autocomplete="off" spellcheck="false">
        </label>
        <div class="mia-fallback-hint">
            Tip: paste a Gemini key too (other tab) for instant fallback.
        </div>
        <div class="mia-setup-row">
            <button class="mia-save-btn" id="mia-connect">Connect</button>
            <button class="mia-test-btn" id="mia-test">Test</button>
        </div>
        <div id="mia-test-result" class="mia-test-result"></div>
        <p class="mia-help">Stored only in this browser. No server.</p>
    `;
}

function wireForm(prov, formEl, panel, onConfigured) {
    const result = formEl.querySelector('#mia-test-result');
    const setResult = (cls, msg) => {
        result.className = `mia-test-result ${cls}`;
        result.innerHTML = msg;
    };

    formEl.querySelector('#mia-test').addEventListener('click', async () => {
        setResult('testing', 'Testing…');
        if (prov === 'gemini') {
            const key = formEl.querySelector('#mia-gemini-key').value.trim();
            if (!key) return setResult('fail', 'Paste a key first.');
            const r = await pingGemini(key);
            setResult(r.ok ? 'ok' : 'fail', r.msg);
        } else {
            const key = formEl.querySelector('#mia-cf-key').value.trim();
            const acct = formEl.querySelector('#mia-cf-acct').value.trim();
            if (!key || !acct) return setResult('fail', 'Both token and account ID are required.');
            const r = await pingCf(key, acct);
            setResult(r.ok ? 'ok' : 'fail', r.msg);
        }
    });

    formEl.querySelector('#mia-connect').addEventListener('click', async () => {
        if (prov === 'gemini') {
            const key = formEl.querySelector('#mia-gemini-key').value.trim();
            // No prefix validation — Google has begun issuing Gemini keys
            // with prefixes other than AIza (e.g. 'AQ...'). The api-gemini
            // ping path is the real source of truth: a valid key works,
            // an invalid key gets a clean rejection there. Trust the
            // server, not a client-side substring check.
            if (!key) return setResult('fail', 'Paste a key first.');
            saveSettings({ backend: 'gemini', geminiKey: key });
        } else {
            const key = formEl.querySelector('#mia-cf-key').value.trim();
            const acct = formEl.querySelector('#mia-cf-acct').value.trim();
            if (!key || !acct) return setResult('fail', 'Both fields required.');
            saveSettings({ backend: 'cloudflare', cfKey: key, cfAccountId: acct });
        }
        setResult('ok', 'Connected. Opening Mia…');
        setTimeout(onConfigured, 400);
    });
}

function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }
