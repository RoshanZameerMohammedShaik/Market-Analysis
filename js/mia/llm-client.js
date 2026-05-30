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
import { routedStream, getLastDecision, classifyForRouting } from './router.js';
import { isCooling, markCooling, msUntilHealthy, clearCooldown, getCooldownState } from './backends/tier-cooldown.js';
import { modelChainFor } from './backends/gemini-models.js';

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

    // Try tier in order: if it's cooling, skip to the next; if a 429/cooling
    // error arises BEFORE any output has streamed, mark cooling and try the
    // alternate tier inline (invisible to the user). If a 429 arises AFTER
    // output has already streamed, we can't recover invisibly — the partial
    // text is on screen already. In that case we let the error bubble up
    // so the catch in mia.js shows the partial reply with a soft cut-off
    // note. The cooldown is recorded either way so the NEXT turn skips
    // the bad tier silently.
    //
    // Also: never tell the user "falling back to Flash". The whole point
    // of auto-fallback is invisible recovery — the only user-visible
    // status during fallback is the same generic "thinking…" they'd see
    // on a normal call.
    // Walk through every free-tier Gemini model in priority order, falling
    // through on 429 / cooling. Each Gemini model has its OWN independent
    // daily and per-minute quota — even though the API key is shared, Google
    // tracks RPM/RPD separately per model. So when Flash-Lite hits its
    // daily cap we move to Flash, then 2.0-flash, then 1.5-flash, etc. We
    // exhaust all ~8 models before giving up to Cloudflare. Effective free
    // quota: ~5–10× what we had before.
    async function* runGeminiChain(intent) {
        // Build the chain: preferred-tier models first, then the other
        // tier as fallback. Intent classifier already decided whether
        // this query wants 'reasoning' (tool-heavy) or 'fast' (prose).
        const chain = modelChainFor(intent);

        // Stale-cooldown rescue: if EVERY model in the chain looks
        // cooling, clear them all and try fresh. The cooldown timestamps
        // can drift out of sync with reality (long retry-Afters, quota
        // resets we didn't observe, mis-attributed 429s) and refusing
        // the call with no recourse is worse than burning one probe.
        const allCooling = chain.every(m => isCooling(m));
        if (allCooling) {
            for (const m of chain) clearCooldown(m);
            console.log('[mia] All Gemini models cooling; cleared map and probing fresh.');
        }

        let lastErr = null;
        for (const model of chain) {
            if (isCooling(model)) {
                console.log('[mia] Skipping cooling model:', model, 'remaining:', Math.ceil(msUntilHealthy(model) / 1000) + 's');
                lastErr = new Error(`Skipping ${model}: cooling.`);
                lastErr.status = 429;
                lastErr.tierCooling = true;
                continue;
            }
            let yieldedAnyDelta = false;
            try {
                if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
                console.log('[mia] Trying Gemini model:', model);
                for await (const delta of gemini.stream({
                    system,
                    messages,
                    key: s.geminiKey,
                    signal,
                    model, // explicit model id, bypasses tier mapping
                })) {
                    yieldedAnyDelta = true;
                    yield delta;
                }
                if (!yieldedAnyDelta) {
                    console.warn('[mia] Empty stream from', model, '— continuing to next model.');
                    continue; // empty response → try next, don't return success
                }
                return; // success
            } catch (err) {
                lastErr = err;
                const isCooldown = err?.tierCooling || err?.status === 429;
                // 400/404 from a preview model that's no longer available
                // (Google retires preview SKUs without notice). Skip it
                // permanently for this session by marking it cooling for
                // a long time so the chain doesn't keep retrying.
                if (err?.status === 400 || err?.status === 404) {
                    console.warn('[mia] Model unavailable:', model, '— skipping for 1h.');
                    markCooling(model, 3600);
                    continue;
                }
                if (isCooldown && !yieldedAnyDelta) continue;
                if (isCooldown && yieldedAnyDelta) throw err;
                throw err;
            }
        }
        throw lastErr || new Error('Every Gemini model is cooling.');
    }

    const geminiRun = async function* () {
        // Classify intent ONCE up front. The classifier is itself a
        // Flash-Lite call, so we only pay for it on the first turn —
        // and we read the result from a cached lastDecision when
        // available to avoid the round-trip on rapid retries.
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const intent = await classifyForRouting({
            userMessage: lastUser?.content || '',
            key: s.geminiKey,
            signal,
        });
        yield* runGeminiChain(intent);
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
        // Don't announce "falling back to cloudflare" — invisible recovery
        // is the whole point. User just sees "thinking…" continue.
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
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

// Combined snapshot for the footer status pill: which model is actively
// in use right now, plus any tiers that are currently cooling. Reads
// the router's last decision (which records the model picked for the
// most recent call) and the cooldown map from tier-cooldown.js.
// (getCooldownState is imported at the top of the file — having an
// import statement here in the middle is a parse error in strict ES
// module loading, which silently broke the whole Mia pipeline.)
export function getModelStatus() {
    const last = getLastDecision();
    const cooling = getCooldownState();
    const coolingList = Object.entries(cooling).map(([model, msRemaining]) => ({
        model,
        secondsRemaining: Math.ceil(msRemaining / 1000),
    }));
    return {
        activeModel: last?.model || null,
        activeIntent: last?.intent || null,
        cooling: coolingList,
    };
}

export function getRoutingSummary() {
    try {
        const s = loadSettings();
        const r = route();
        const tier = s.thinkingMode ? 'thinking' : 'default';
        return {
            primary: r.primary,
            fallback: r.fallback,
            geminiModel: (r.primary === 'gemini' || r.fallback === 'gemini')
                ? '8-model rotation (auto-failover by quota)'
                : null,
            tier,
            smartRouting: r.primary === 'gemini' && !s.thinkingMode,
        };
    } catch (_) {
        return { primary: null, fallback: null, geminiModel: null, tier: 'default', smartRouting: false };
    }
}

export function normalizeWebllmProgress() { return { phase: 'unknown', percent: 0, friendly: '' }; }
