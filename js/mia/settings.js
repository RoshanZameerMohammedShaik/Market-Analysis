// User settings: API keys for Groq and/or Cloudflare. WebLLM has been
// retired — too slow on real hardware, too unreliable across browsers.
// Both keys can be configured at once; runtime auto-falls-back from
// Groq → CF on rate-limit / outage.

const KEY = 'ma-mia-settings-v3';
const LEGACY_KEYS = ['ma-mia-settings-v2', 'ma-mia-settings-v1'];

const DEFAULT = {
    backend: '',           // '' (unconfigured) | 'groq' | 'cloudflare'
    fallbackEnabled: true, // when both keys present, auto-fallback on Groq 429/5xx
    groqKey: '',
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
            // Drop webllm-only configs; preserve API keys if present.
            const next = {
                backend: (parsed.backend === 'webllm' || !parsed.backend) ? '' : parsed.backend,
                fallbackEnabled: true,
                groqKey: parsed.groqKey || '',
                cfKey: parsed.cfKey || '',
                cfAccountId: parsed.cfAccountId || '',
                thinkingMode: !!parsed.thinkingMode,
            };
            // If legacy was webllm but the user already had a Groq key on file, prefer Groq.
            if (next.backend === '' && next.groqKey) next.backend = 'groq';
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
        // Defensive: never let 'webllm' leak through.
        if (parsed.backend === 'webllm') parsed.backend = parsed.groqKey ? 'groq' : (parsed.cfKey ? 'cloudflare' : '');
        return { ...DEFAULT, ...parsed };
    } catch (_) {
        return { ...DEFAULT };
    }
}

export function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    if (next.backend === 'webllm') next.backend = '';
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
    if (s.backend === 'groq') return !!s.groqKey;
    if (s.backend === 'cloudflare') return !!s.cfKey && !!s.cfAccountId;
    return false;
}

export function hasFallbackKey() {
    const s = loadSettings();
    if (s.backend === 'groq') return !!s.cfKey && !!s.cfAccountId;
    if (s.backend === 'cloudflare') return !!s.groqKey;
    return false;
}
