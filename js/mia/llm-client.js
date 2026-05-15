// Unified Mia client. Groq is primary, Cloudflare is automatic fallback
// when the user has both keys. Falls back on 429 / 5xx / network error.
//
// WebLLM is retired. We still export an inert webllm shim so old imports
// (e.g. mia.js's settings.clearCache button) don't break — but the shim's
// methods are no-ops.

import { loadSettings, hasFallbackKey } from './settings.js';
import * as groq from './backends/api-groq.js';
import * as cf from './backends/api-cf.js';

// Inert WebLLM placeholder. Anything that imported `webllm` previously
// gets a safe no-op surface. Tested in mia.js settings panel.
export const webllm = {
    clearCache: async () => {
        // Best-effort wipe of any old IndexedDB the user might still have.
        try {
            if (typeof indexedDB?.databases === 'function') {
                const dbs = await indexedDB.databases();
                for (const db of dbs) {
                    if (!db?.name) continue;
                    if (/webllm|mlc/i.test(db.name)) indexedDB.deleteDatabase(db.name);
                }
            }
        } catch (_) {}
        return { ok: true };
    },
};

/**
 * Decide which backend to call first and whether a fallback is allowed.
 * Returns { primary: 'groq' | 'cloudflare', fallback: 'groq' | 'cloudflare' | null }.
 */
function route() {
    const s = loadSettings();
    if (s.backend === 'groq' && s.groqKey) {
        return { primary: 'groq', fallback: (s.fallbackEnabled && s.cfKey && s.cfAccountId) ? 'cloudflare' : null };
    }
    if (s.backend === 'cloudflare' && s.cfKey && s.cfAccountId) {
        return { primary: 'cloudflare', fallback: (s.fallbackEnabled && s.groqKey) ? 'groq' : null };
    }
    throw new Error('Mia is not configured yet. Add a Groq or Cloudflare key in settings.');
}

function shouldFailover(err) {
    const m = String(err?.message || err || '');
    return /429|rate[\- ]?limit|5\d\d|timeout|network|fetch/i.test(m);
}

export async function* stream({ system, messages, signal, onProgress }) {
    const s = loadSettings();
    const { primary, fallback } = route();
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });

    try {
        if (primary === 'groq') {
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal })) yield delta;
        } else {
            for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
        }
        return;
    } catch (err) {
        if (!fallback || !shouldFailover(err) || signal?.aborted) throw err;
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: `falling back to ${fallback}…` });
        if (fallback === 'groq') {
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal })) yield delta;
        } else {
            for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
        }
    }
}

export async function pingBackend() {
    const s = loadSettings();
    if (s.backend === 'groq') return groq.ping(s.groqKey);
    if (s.backend === 'cloudflare') return cf.ping(s.cfKey, s.cfAccountId);
    return { ok: false, msg: 'Not configured.' };
}

export function getUsage() {
    const s = loadSettings();
    if (s.backend === 'groq') return groq.getLastUsage();
    if (s.backend === 'cloudflare') return cf.getLastUsage();
    return null;
}

export function getRoutingSummary() {
    try {
        const r = route();
        return { primary: r.primary, fallback: r.fallback };
    } catch (_) {
        return { primary: null, fallback: null };
    }
}

// No-op shim — kept for backward compatibility with prewarm.js callers.
export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
