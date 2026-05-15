// Unified Mia client. Groq is primary, Cloudflare is automatic fallback
// when the user has both keys. We fall back on:
//   - any non-rate-limit network/server failure (5xx, fetch error)
//   - 429 with retry-after > 5s (anything shorter, we just propagate the
//     error and let the user wait, since round-tripping CF would be slower)
// We also pass thinking-mode through to Groq so it can pick the model.

import { loadSettings, hasFallbackKey } from './settings.js';
import * as groq from './backends/api-groq.js';
import * as cf from './backends/api-cf.js';

export const webllm = {
    clearCache: async () => {
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
    // 401 / 403 are auth/perm issues — fallback won't help.
    if (err?.status === 401 || err?.status === 403) return false;
    // 429 is rate-limit. Fall over only if Groq says retry-after is long
    // enough that the round-trip to CF will be cheaper than waiting.
    if (err?.status === 429) {
        const wait = Number(err?.retryAfterSec || 0);
        return !Number.isFinite(wait) || wait > 5;
    }
    const m = String(err?.message || err || '');
    return /5\d\d|timeout|network|fetch/i.test(m);
}

export async function* stream({ system, messages, signal, onProgress }) {
    const s = loadSettings();
    const tier = s.thinkingMode ? 'thinking' : 'default';
    const { primary, fallback } = route();
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });

    try {
        if (primary === 'groq') {
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal, tier })) yield delta;
        } else {
            for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
        }
        return;
    } catch (err) {
        if (!fallback || !shouldFailover(err) || signal?.aborted) throw err;
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: `falling back to ${fallback}…` });
        if (fallback === 'groq') {
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal, tier })) yield delta;
        } else {
            for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
        }
    }
}

export async function pingBackend() {
    const s = loadSettings();
    const tier = s.thinkingMode ? 'thinking' : 'default';
    if (s.backend === 'groq') return groq.ping(s.groqKey, tier);
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
        const s = loadSettings();
        const r = route();
        const tier = s.thinkingMode ? 'thinking' : 'default';
        return {
            primary: r.primary,
            fallback: r.fallback,
            groqModel: r.primary === 'groq' || r.fallback === 'groq' ? groq.getModelForTier(tier) : null,
            tier,
        };
    } catch (_) {
        return { primary: null, fallback: null, groqModel: null, tier: 'default' };
    }
}

export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
