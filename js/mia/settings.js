// User-controlled settings: backend choice and BYOK API key.
// Stored in localStorage. Never sent anywhere except directly to the
// chosen LLM provider.

const KEY = 'ma-mia-settings';
const DEFAULT = { backend: 'hf', openaiKey: '' };

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        return { ...DEFAULT, ...JSON.parse(raw) };
    } catch (_) { return { ...DEFAULT }; }
}

export function saveSettings(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
}
