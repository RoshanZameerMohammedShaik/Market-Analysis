// User-controlled settings: backend choice and BYOK API key.
// Stored in localStorage. Never sent anywhere except directly to the
// chosen LLM provider.

const KEY = 'ma-mia-settings';

// Default switched from 'hf' (gated, doesn't work for anonymous users)
// to 'pollinations' (free, no key, permissive CORS).
const DEFAULT = { backend: 'pollinations', openaiKey: '' };

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        const parsed = JSON.parse(raw);
        // Migrate legacy 'hf' value to the new working default.
        if (parsed.backend === 'hf') parsed.backend = 'pollinations';
        return { ...DEFAULT, ...parsed };
    } catch (_) { return { ...DEFAULT }; }
}

export function saveSettings(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
}
