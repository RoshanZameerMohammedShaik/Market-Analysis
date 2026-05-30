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
import { isCooling, markCooling, msUntilHealthy, clearCooldown, getCooldownState } from './backends/tier-cooldown.js';

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
    async function* runGeminiWithTierFallback(preferredOrder) {
        // De-dupe so passing ['default','default','thinking'] still walks
        // through unique tiers in order.
        const tried = new Set();
        const order = preferredOrder.filter(t => {
            if (tried.has(t)) return false;
            tried.add(t);
            return true;
        });

        // Stale cooldown rescue: if every tier appears cooling, clear
        // them all and try fresh. The cooldown map can get stuck when:
        //   - Google returns a long retry-After hint (e.g. 30 min) that
        //     overstates the real cooldown.
        //   - A 429 was attributed to one tier but actually came from
        //     a different quota bucket.
        //   - User's quota actually reset but our timestamps didn't tick.
        // Better to make a real call and learn the truth than refuse the
        // user with no recourse. If the call genuinely 429s, markCooling
        // re-records with the fresh server hint; if it works, the user
        // gets a reply and the stale entry stays cleared.
        const allCooling = order.every(t => isCooling(gemini.getModelForTier(t)));
        if (allCooling) {
            for (const t of order) clearCooldown(gemini.getModelForTier(t));
            console.log('[mia] All Gemini tiers showed cooling; cleared stale cooldown map and trying fresh.');
        }

        let lastErr = null;
        for (let i = 0; i < order.length; i++) {
            const tier = order[i];
            const model = gemini.getModelForTier(tier);
            // Skip pre-flight cooling tiers (only fires when SOME tier is
            // healthy and we'd rather try that one first).
            if (isCooling(model)) {
                lastErr = new Error(`Skipping ${model}: in cooldown.`);
                lastErr.status = 429;
                lastErr.tierCooling = true;
                continue;
            }
            let yieldedAnyDelta = false;
            try {
                // Always show "thinking…" — never announce fallback.
                if (onProgress) {
                    onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
                }
                if (tier === 'default' && !s.thinkingMode) {
                    for await (const delta of routedStream({ system, systemNoTools, messages, key: s.geminiKey, signal, onProgress })) {
                        yieldedAnyDelta = true;
                        yield delta;
                    }
                } else {
                    for await (const delta of gemini.stream({ system, messages, key: s.geminiKey, signal, tier })) {
                        yieldedAnyDelta = true;
                        yield delta;
                    }
                }
                // Diagnostic: if the call completed without any deltas,
                // log it so we can see when an empty stream is the cause
                // of "thinking… then nothing." Doesn't change behavior.
                if (!yieldedAnyDelta) {
                    console.warn('[mia] Tier returned zero deltas (empty stream):', tier, model);
                }
                return; // success path
            } catch (err) {
                lastErr = err;
                const isCooldown = err?.tierCooling || err?.status === 429;
                if (isCooldown && !yieldedAnyDelta) continue;
                if (isCooldown && yieldedAnyDelta) throw err;
                throw err;
            }
        }
        throw lastErr || new Error('All Gemini tiers cooling.');
    }

    const geminiRun = async function* () {
        // Preferred tier order:
        //   - thinkingMode on  → ['thinking', 'default']  (try Flash first)
        //   - thinkingMode off → ['default', 'thinking']  (try Lite first)
        // Either way the OTHER tier is the auto-fallback. The router
        // inside the 'default' branch may pick Flash for tool intents,
        // but at the OUTER fallback level we still treat 'default' as
        // the Lite-first path.
        const order = s.thinkingMode ? ['thinking', 'default'] : ['default', 'thinking'];
        yield* runGeminiWithTierFallback(order);
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
