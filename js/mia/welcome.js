// First-open welcome screen — single path: API key (Groq or Cloudflare).
// WebLLM has been retired. Both keys can co-exist; runtime auto-fails-over
// from Groq → CF if the primary rate-limits.

import { saveSettings, loadSettings } from './settings.js';
import { ping as pingGroq } from './backends/api-groq.js';
import { ping as pingCf } from './backends/api-cf.js';

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
                    <span>Groq + Cloudflare</span><span>Auto-fallback</span><span>Free tier</span><span>Llama 3.3 70B</span>
                </div>
                <div class="mia-card-body">
                    Paste a free Groq or Cloudflare key. If you add both, Mia auto-falls-back the moment one rate-limits, so you effectively never run dry. Keys live only in this browser.
                </div>
                <button class="mia-card-btn primary" data-pick="apikey">Set up</button>
            </div>
            <div class="mia-welcome-tip">No accounts, no servers. Both providers have generous free tiers — together they cover hundreds of conversations a day for free.</div>
        </div>
    `;

    panel.querySelector('#mia-close-btn').addEventListener('click', () => panel.classList.remove('open'));
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
                <button class="mia-prov ${s.backend === 'groq' || (!s.backend && s.groqKey) ? 'active' : ''}" data-prov="groq">
                    <div class="mia-prov-name">Groq <span class="mia-prov-badge">recommended</span></div>
                    <div class="mia-prov-meta">Llama 3.3 70B • ~500 tok/s • 14,400 req/day</div>
                </button>
                <button class="mia-prov ${s.backend === 'cloudflare' ? 'active' : ''}" data-prov="cloudflare">
                    <div class="mia-prov-name">Cloudflare Workers AI</div>
                    <div class="mia-prov-meta">Llama 3.3 70B • ~10k neurons/day free</div>
                </button>
            </div>
            <div id="mia-setup-form"></div>
        </div>
    `;

    panel.querySelector('#mia-close-btn').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelector('#mia-back').addEventListener('click', () => renderWelcome(panel, onConfigured));

    const formEl = panel.querySelector('#mia-setup-form');
    const renderForm = (prov) => {
        formEl.innerHTML = prov === 'groq' ? groqFormHtml(s) : cfFormHtml(s);
        wireForm(prov, formEl, panel, onConfigured);
    };

    panel.querySelectorAll('[data-prov]').forEach(btn => {
        btn.addEventListener('click', () => {
            panel.querySelectorAll('[data-prov]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderForm(btn.dataset.prov);
        });
    });

    const initial = s.backend === 'cloudflare' ? 'cloudflare' : 'groq';
    panel.querySelector(`[data-prov="${initial}"]`).classList.add('active');
    renderForm(initial);
}

function groqFormHtml(s) {
    return `
        <ol class="mia-steps">
            <li><span class="mia-step-num">1</span> Open <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> and sign in (email signup, no card).</li>
            <li><span class="mia-step-num">2</span> Click <strong>Create API Key</strong>, name it anything.</li>
            <li><span class="mia-step-num">3</span> Copy the <code>gsk_…</code> value and paste below.</li>
            <li><span class="mia-step-num">4</span> Open <a href="https://console.groq.com/settings/limits" target="_blank" rel="noopener">console.groq.com/settings/limits</a> → <strong>Allowed Models</strong> → enable <code>llama-3.3-70b-versatile</code>. <em>Required — new Groq accounts ship with model access blocked, and Mia will return a 403 until you flip this on.</em></li>
        </ol>
        <label class="mia-field">
            Groq API Key
            <input type="password" id="mia-groq-key" placeholder="gsk_…" value="${escapeAttr(s.groqKey)}" autocomplete="off" spellcheck="false">
        </label>
        <div class="mia-fallback-hint">
            Tip: paste a Cloudflare key too (next tab) and Mia auto-falls-back when Groq rate-limits.
        </div>
        <div class="mia-setup-row">
            <button class="mia-save-btn" id="mia-connect">Connect</button>
            <button class="mia-test-btn" id="mia-test">Test</button>
        </div>
        <div id="mia-test-result" class="mia-test-result"></div>
        <p class="mia-help">Your key is stored only in this browser's localStorage. Mia talks to Groq directly — no server, no proxy.</p>
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
            Tip: paste a Groq key too (other tab) for instant fallback.
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
        if (prov === 'groq') {
            const key = formEl.querySelector('#mia-groq-key').value.trim();
            if (!key) return setResult('fail', 'Paste a key first.');
            const r = await pingGroq(key);
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
        if (prov === 'groq') {
            const key = formEl.querySelector('#mia-groq-key').value.trim();
            if (!key.startsWith('gsk_')) return setResult('fail', 'Groq keys start with gsk_. Double-check.');
            saveSettings({ backend: 'groq', groqKey: key });
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
