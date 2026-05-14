// User-controlled settings: backend choice, free-model picker, BYOK key.
// Stored in localStorage. Never sent anywhere except directly to the
// chosen LLM provider.

import { POLLINATIONS_DEFAULT } from './llm-client.js';

const KEY = 'ma-mia-settings';

const DEFAULT = {
    backend: 'pollinations',
    pollinationsModel: POLLINATIONS_DEFAULT,
    openaiKey: '',
};

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        const parsed = JSON.parse(raw);
        // Migrate legacy 'hf' (gated, broken) to working default.
        if (parsed.backend === 'hf') parsed.backend = 'pollinations';
        return { ...DEFAULT, ...parsed };
    } catch (_) { return { ...DEFAULT }; }
}

export function saveSettings(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
}
