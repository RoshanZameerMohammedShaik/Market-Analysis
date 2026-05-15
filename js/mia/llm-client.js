// Unified Mia client.
//
// Phase 5 routing on Groq:
//   - thinking-mode → 70B for everything (user explicitly opted in)
//   - default       → intent classifier picks 8B (prose) or 70B (tools)
//
// We accept TWO system prompts so the prose path can use a tool-free version
// (saves ~250 prompt tokens AND prevents 8B from fabricating tool calls).
// agent.js builds both via prompt.js + tools.toolPromptSection().
//
// Cross-provider fallback (Groq -> CF or vice versa) still applies on 5xx /
// network errors / long-retry 429s. Auth errors don't fall over.

import { loadSettings } from './settings.js';
import * as groq from './backends/api-groq.js';
import * as cf from './backends/api-cf.js';
import { routedStream, getLastDecision } from './router.js';

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

export async function* stream({ system, systemNoTools, messages, signal, onProgress }) {
    const s = loadSettings();
    const { primary, fallback } = route();
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });

    const groqRun = async function* () {
        if (s.thinkingMode) {
            // Thinking mode → explicit 70B for everything.
            for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal, tier: 'thinking' })) yield delta;
            return;
        }
        // Default: intent-classified routing.
        for await (const delta of routedStream({ system, systemNoTools, messages, key: s.groqKey, signal, onProgress })) yield delta;
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

export function getLastRoutingDecision() {
    return getLastDecision();
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
                ? (s.thinkingMode ? groq.getModelForTier('thinking') : `${groq.getModelForTier('default')} ↔ ${groq.getModelForTier('thinking')} (intent-classified)`)
                : null,
            tier,
            smartRouting: r.primary === 'groq' && !s.thinkingMode,
        };
    } catch (_) {
        return { primary: null, fallback: null, groqModel: null, tier: 'default', smartRouting: false };
    }
}

export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
