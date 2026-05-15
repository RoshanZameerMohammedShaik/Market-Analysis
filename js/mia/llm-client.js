// Unified Mia client.
//
// On Groq: silent tier promotion via router.smartStream — turns start on
// 8B-instant for cheap fast prose, and silently promote to 70B-versatile
// the moment a tool intent is detected. thinking-mode users skip the router
// entirely (explicit 70B always).
//
// Cross-provider fallback (Groq -> Cloudflare or vice versa) still applies
// on 5xx / network errors / long-retry 429s. Auth errors don't fall over.

import { loadSettings, hasFallbackKey } from './settings.js';
import * as groq from './backends/api-groq.js';
import * as cf from './backends/api-cf.js';
import { smartStream as groqSmartStream } from './router.js';

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
    if (err?.status === 401 || err?.status === 403) return false;
    if (err?.status === 429) {
        const wait = Number(err?.retryAfterSec || 0);
        return !Number.isFinite(wait) || wait > 5;
    }
    const m = String(err?.message || err || '');
    return /5\d\d|timeout|network|fetch/i.test(m);
}

export async function* stream({ system, messages, signal, onProgress }) {
    const s = loadSettings();
    const { primary, fallback } = route();
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });

    const groqRun = async function* () {
        // thinking-mode users always run on 70B — skip the smart router.
        if (s.thinkingMode) {
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal, tier: 'thinking' })) yield delta;
            return;
        }
        // Default: silent 8B → 70B promotion on tool intent.
        for await (const delta of groqSmartStream({ system, messages, key: s.groqKey, signal, onProgress })) yield delta;
    };

    const cfRun = async function* () {
        for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
    };

    try {
        if (primary === 'groq') {
            yield* groqRun();
        } else {
            yield* cfRun();
        }
        return;
    } catch (err) {
        if (!fallback || !shouldFailover(err) || signal?.aborted) throw err;
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: `falling back to ${fallback}…` });
        if (fallback === 'groq') {
            yield* groqRun();
        } else {
            yield* cfRun();
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
            groqModel: r.primary === 'groq' || r.fallback === 'groq'
                ? (s.thinkingMode ? groq.getModelForTier('thinking') : `${groq.getModelForTier('default')} → ${groq.getModelForTier('thinking')} (auto)`)
                : null,
            tier,
            smartRouting: r.primary === 'groq' && !s.thinkingMode,
        };
    } catch (_) {
        return { primary: null, fallback: null, groqModel: null, tier: 'default', smartRouting: false };
    }
}

export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
