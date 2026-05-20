// Unified Mia client.
//
// Backends:
//   gemini      → Google AI Studio (Flash-Lite default, Flash thinking-mode)
//   cloudflare  → Cloudflare Workers AI (Llama 3.3 70B, fallback)
//
// Thinking mode escalates Gemini Flash-Lite → Flash. Otherwise the intent
// classifier picks Flash-Lite for prose vs. tool-tier for everything else.
//
// Cross-provider fallback: when Gemini returns 5xx / mid-stream / long-retry
// 429, we silently switch to Cloudflare. Auth errors don't fall over.

import { loadSettings } from './settings.js';
import * as gemini from './backends/api-gemini.js';
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
    if (s.backend === 'gemini' && s.geminiKey) {
        return { primary: 'gemini', fallback: (s.fallbackEnabled && s.cfKey && s.cfAccountId) ? 'cloudflare' : null };
    }
    if (s.backend === 'cloudflare' && s.cfKey && s.cfAccountId) {
        return { primary: 'cloudflare', fallback: (s.fallbackEnabled && s.geminiKey) ? 'gemini' : null };
    }
    throw new Error('Mia is not configured yet. Add a Gemini or Cloudflare key in settings.');
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

    const geminiRun = async function* () {
        if (s.thinkingMode) {
            // Thinking mode → explicit Flash for everything.
            for await (const delta of gemini.stream({ system, messages, key: s.geminiKey, signal, tier: 'thinking' })) yield delta;
            return;
        }
        // Default: intent-classified routing (Flash-Lite vs Flash).
        for await (const delta of routedStream({ system, systemNoTools, messages, key: s.geminiKey, signal, onProgress })) yield delta;
    };

    const cfRun = async function* () {
        for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
    };

    try {
        if (primary === 'gemini') {
            yield* geminiRun();
        } else {
            yield* cfRun();
        }
        return;
    } catch (err) {
        if (!fallback || !shouldFailover(err) || signal?.aborted) throw err;
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: `falling back to ${fallback}…` });
        if (fallback === 'gemini') {
            yield* geminiRun();
        } else {
            yield* cfRun();
        }
    }
}

export async function pingBackend() {
    const s = loadSettings();
    const tier = s.thinkingMode ? 'thinking' : 'default';
    if (s.backend === 'gemini') return gemini.ping(s.geminiKey, tier);
    if (s.backend === 'cloudflare') return cf.ping(s.cfKey, s.cfAccountId);
    return { ok: false, msg: 'Not configured.' };
}

export function getUsage() {
    const s = loadSettings();
    if (s.backend === 'gemini') return gemini.getLastUsage();
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
            geminiModel: r.primary === 'gemini' || r.fallback === 'gemini'
                ? (s.thinkingMode ? gemini.getModelForTier('thinking') : `${gemini.getModelForTier('default')} ↔ ${gemini.getModelForTier('thinking')} (intent-classified)`)
                : null,
            tier,
            smartRouting: r.primary === 'gemini' && !s.thinkingMode,
        };
    } catch (_) {
        return { primary: null, fallback: null, geminiModel: null, tier: 'default', smartRouting: false };
    }
}

export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
