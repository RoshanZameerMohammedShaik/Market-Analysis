// Mia's conversation memory. Persisted to localStorage so it survives reloads.
// Keep last MAX_TURNS exchanges; trim older ones.

const KEY = 'ma-mia-history';
const MAX_TURNS = 12; // user+assistant pairs

export function loadHistory() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Defensive filter: drop any entry that's not a clean
        // {role: 'user'|'assistant'|'system', content: <non-empty string>}.
        // Without this, a single corrupt entry (NaN content, missing role,
        // {} placeholder) would get sent to the LLM as context and reliably
        // cause silent 400s on every subsequent turn.
        return parsed.filter(m => {
            if (!m || typeof m !== 'object') return false;
            if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return false;
            if (typeof m.content !== 'string') return false;
            if (!m.content.trim()) return false;
            return true;
        });
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
