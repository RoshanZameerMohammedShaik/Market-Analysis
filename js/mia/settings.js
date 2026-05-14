// User settings: backend choice, API keys, WebLLM tier.
// Stored in localStorage, scoped to the site origin.

const KEY = 'ma-mia-settings-v2';

const DEFAULT = {
    backend: '', // '' (unconfigured) | 'webllm' | 'groq' | 'cloudflare'
    webllmTier: 'default', // 'default' | 'thinking'
    groqKey: '',
    cfKey: '',
    cfAccountId: '',
    thinkingMode: false,
};

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        return { ...DEFAULT, ...JSON.parse(raw) };
    } catch (_) {
        return { ...DEFAULT };
    }
}

export function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) { /* */ }
    return next;
}

export function clearSettings() {
    try { localStorage.removeItem(KEY); } catch (_) {}
}

export function isConfigured() {
    const s = loadSettings();
    if (s.backend === 'webllm') return true;
    if (s.backend === 'groq') return !!s.groqKey;
    if (s.backend === 'cloudflare') return !!s.cfKey && !!s.cfAccountId;
    return false;
}
