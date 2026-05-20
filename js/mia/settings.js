// User settings: API keys for Gemini (primary) and/or Cloudflare (fallback).
// Groq has been retired — its 6,000 TPM cap on Llama 3.3 70B kept tripping
// mid-stream rate-limits even on routine deep-dives. Gemini 2.5 Flash-Lite
// gives 250K TPM (42× the headroom) for free.
//
// Both keys can be configured at once; runtime auto-falls back from
// Gemini → Cloudflare on 429/5xx.

const KEY = 'ma-mia-settings-v4';
const LEGACY_KEYS = ['ma-mia-settings-v3', 'ma-mia-settings-v2', 'ma-mia-settings-v1'];

const DEFAULT = {
    backend: '',           // '' (unconfigured) | 'gemini' | 'cloudflare'
    fallbackEnabled: true, // when both keys present, auto-fallback on 429/5xx
    geminiKey: '',
    cfKey: '',
    cfAccountId: '',
    thinkingMode: false,
};

function migrateLegacy() {
    for (const lk of LEGACY_KEYS) {
        try {
            const raw = localStorage.getItem(lk);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const next = {
                // Drop the deprecated 'groq' and 'webllm' backends. If the user
                // had only Groq configured, they need to re-enter a Gemini key.
                backend: (parsed.backend === 'gemini' || parsed.backend === 'cloudflare') ? parsed.backend : '',
                fallbackEnabled: true,
                geminiKey: parsed.geminiKey || '',
                cfKey: parsed.cfKey || '',
                cfAccountId: parsed.cfAccountId || '',
                thinkingMode: !!parsed.thinkingMode,
            };
            if (next.backend === '' && next.geminiKey) next.backend = 'gemini';
            else if (next.backend === '' && next.cfKey && next.cfAccountId) next.backend = 'cloudflare';
            localStorage.setItem(KEY, JSON.stringify(next));
            localStorage.removeItem(lk);
            return next;
        } catch (_) { /* */ }
    }
    return null;
}

let migrated = false;

export function loadSettings() {
    if (!migrated) { try { migrateLegacy(); } catch (_) {} migrated = true; }
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        const parsed = JSON.parse(raw);
        // Defensive: never let deprecated backends leak through.
        if (parsed.backend === 'webllm' || parsed.backend === 'groq') {
            parsed.backend = parsed.geminiKey ? 'gemini' : (parsed.cfKey ? 'cloudflare' : '');
        }
        return { ...DEFAULT, ...parsed };
    } catch (_) {
        return { ...DEFAULT };
    }
}

export function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    if (next.backend === 'webllm' || next.backend === 'groq') next.backend = '';
    // Strip any orphan groqKey carried over from older versions.
    delete next.groqKey;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
    return next;
}

export function clearSettings() {
    try {
        localStorage.removeItem(KEY);
        for (const lk of LEGACY_KEYS) localStorage.removeItem(lk);
    } catch (_) {}
}

export function isConfigured() {
    const s = loadSettings();
    if (s.backend === 'gemini') return !!s.geminiKey;
    if (s.backend === 'cloudflare') return !!s.cfKey && !!s.cfAccountId;
    return false;
}

export function hasFallbackKey() {
    const s = loadSettings();
    if (s.backend === 'gemini') return !!s.cfKey && !!s.cfAccountId;
    if (s.backend === 'cloudflare') return !!s.geminiKey;
    return false;
}
