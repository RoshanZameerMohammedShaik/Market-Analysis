// Mia's conversation memory. Persisted to localStorage so it survives reloads.
// Keep last MAX_TURNS exchanges; trim older ones.

const KEY = 'ma-mia-history';
const MAX_TURNS = 12; // user+assistant pairs

export function loadHistory() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}

export function saveHistory(messages) {
    try {
        // Keep last 2*MAX_TURNS messages (user+assistant alternating).
        const trimmed = messages.slice(-2 * MAX_TURNS);
        localStorage.setItem(KEY, JSON.stringify(trimmed));
    } catch (_) { /* */ }
}

export function clearHistory() {
    try { localStorage.removeItem(KEY); } catch (_) {}
}
