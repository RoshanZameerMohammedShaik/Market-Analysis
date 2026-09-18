// Catalog of free-tier Gemini text-generation models, ordered by
// QUALITY (best-first). Each entry has its own independent daily quota
// — the API key is shared, but Google tracks RPD/RPM separately per
// model, so we can rotate through this list as each tier exhausts.
//
// We intentionally don't hardcode RPM/RPD numbers here. Google adjusts
// them frequently (especially for unverified-account free tier) and
// any number here would go stale. Instead, we rely on the existing
// cooldown map (tier-cooldown.js) to learn each model's actual capacity
// reactively: a 429 marks the model as cooling for the timeout the
// server suggests, and we move on to the next model in the chain.
//
// Quality tiers used by the router:
//   'reasoning' — best for tool-heavy / agent / multi-step. Used when
//                 intent classifier returns 'tool'.
//   'fast'      — best for prose / quick chat. Used when intent is
//                 'prose'.
// A query of intent X starts walking the list filtered to its tier,
// falling through to the OTHER tier only after its preferred tier is
// fully exhausted. That preserves quality-vs-speed routing while
// maximizing total free quota across both tiers.

// Each entry below is a real, currently-available Gemini-or-Gemma model
// on the free-tier API as of mid-2026. Sourced from Roshan's actual
// AI Studio rate-limit dashboard (so quotas reflect his exact tier).
//
// Big wins discovered from the dashboard:
//   - gemini-3.1-flash-lite: 500 RPD free (much more than 2.5)
//   - gemma-4-26b / gemma-4-31b: 1500 RPD EACH (open-weight Google
//     models hosted via the same Gemini API; quality close to
//     Gemini 3 Flash per arena.ai benchmarks)
//   - 'latest' aliases auto-target current generation
//
// We aggressively include all working IDs because each model has its
// OWN independent daily quota — even though the API key is shared,
// Google tracks RPD per model. So one key can effectively burn
// ~3000+ RPD/day across the rotation before any single model
// exhausts. Models that 404 get auto-marked cooling for 1h by the
// chain walker and quietly skipped.
// Ordering below is QUALITY-first WITHIN each tier, with one correction learned from Roshan's
// 2026-09-18 dashboard: the good models have a 20 RPD ceiling and the Lite models have 500.
//
//     Gemini 3.8 Flash       23 / 20 RPD    OVER
//     Gemini 3.7 Flash       22 / 20 RPD    OVER
//     Gemini 3.6 Flash       21 / 20 RPD    OVER
//     Gemini 3 Flash         21 / 20 RPD    OVER
//     Gemini 3.5 Flash       20 / 20 RPD    AT LIMIT
//     Gemini 2.5 Flash       20 / 20 RPD    AT LIMIT
//     Gemini 3.5 Flash Lite  21 / 500 RPD   headroom
//     Gemini 3.1 Flash Lite   6 / 500 RPD   headroom
//     Gemma 4 26B            14 / 14.4K RPD headroom
//
// So on any normal day every reasoning-tier model is exhausted by the twentieth question, and the
// only thing keeping Mia answering is the Lite/Gemma tail. `rpd` below is recorded for exactly that
// reason -- not to gate requests (the cooldown map still learns the truth reactively from 429s) but
// so a model with 25x the quota is not buried behind six that are already spent. See the note on
// DAILY vs PER-MINUTE cooldowns in tier-cooldown.js, which is what stops those six from being
// retried every half hour for the rest of the day.
export const GEMINI_MODELS = [
    // ── Newest / highest-quality reasoning ────────────────────────
    // 3.8 is the current head of the line as of 2026-09-18. 3.6 and 3.7 were live on the dashboard
    // and simply missing from this list, so two whole models' worth of daily quota was going unused.
    { id: 'gemini-3.8-flash',                tier: 'reasoning', label: 'Gemini 3.8 Flash',      rpd: 20 },
    { id: 'gemini-3.7-flash',                tier: 'reasoning', label: 'Gemini 3.7 Flash',      rpd: 20 },
    { id: 'gemini-3.6-flash',                tier: 'reasoning', label: 'Gemini 3.6 Flash',      rpd: 20 },
    { id: 'gemini-pro-latest',               tier: 'reasoning', label: 'Gemini Pro (latest)' },
    { id: 'gemini-3.5-flash',                tier: 'reasoning', label: 'Gemini 3.5 Flash',      rpd: 20 },
    { id: 'gemini-3-flash',                  tier: 'reasoning', label: 'Gemini 3 Flash',        rpd: 20 },
    { id: 'gemini-2.5-pro',                  tier: 'reasoning', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',                tier: 'reasoning', label: 'Gemini 2.5 Flash',      rpd: 20 },
    { id: 'gemini-2.0-flash',                tier: 'reasoning', label: 'Gemini 2.0 Flash' },

    // ── Fast / lightweight (preferred for prose / quick chat) ─────
    // The 500-RPD Lites lead this tier deliberately. They are the models that actually answer once
    // the reasoning tier is spent, which on a 20-RPD ceiling is most of the day.
    { id: 'gemini-3.5-flash-lite',           tier: 'fast',      label: 'Gemini 3.5 Flash-Lite', rpd: 500 },
    { id: 'gemini-3.1-flash-lite',           tier: 'fast',      label: 'Gemini 3.1 Flash-Lite', rpd: 500 },
    { id: 'gemini-flash-latest',             tier: 'fast',      label: 'Gemini Flash (latest)' },
    { id: 'gemini-flash-lite-latest',        tier: 'fast',      label: 'Gemini Flash-Lite (latest)' },
    { id: 'gemini-2.5-flash-lite',           tier: 'fast',      label: 'Gemini 2.5 Flash-Lite', rpd: 20 },
    { id: 'gemini-2.0-flash-lite',           tier: 'fast',      label: 'Gemini 2.0 Flash-Lite' },
    { id: 'gemini-1.5-flash-8b',             tier: 'fast',      label: 'Gemini 1.5 Flash-8B' },

    // ── Gemma open-weight models — 14.4K RPD EACH ────────────────
    // Tier them as 'fast' since they're sized like Flash-class. The dashboard shows 14,400 RPD,
    // which is ~720x a Flash model's ceiling, so these are the real floor under the whole chain.
    // (Dashboard labels are 'Gemma 4 26B' / 'Gemma 4 31B'. The API ID form is unconfirmed, so both
    //  the -it instruction-tuned suffix and the bare name are tried and 404 auto-skips the dead one.)
    { id: 'gemma-4-26b-it',                  tier: 'fast',      label: 'Gemma 4 26B',           rpd: 14400 },
    { id: 'gemma-4-31b-it',                  tier: 'fast',      label: 'Gemma 4 31B',           rpd: 14400 },
    { id: 'gemma-3-27b-it',                  tier: 'fast',      label: 'Gemma 3 27B' },
    { id: 'gemma-2-27b-it',                  tier: 'fast',      label: 'Gemma 2 27B' },
];

// Convenience: short, user-friendly name for the model status pill.
export function shortName(id) {
    if (!id) return '';
    return id
        .replace(/^gemini-/, '')
        .replace(/-pro$/, ' Pro')
        .replace(/-flash-lite$/, ' Flash-Lite')
        .replace(/-flash-8b$/, ' Flash-8B')
        .replace(/-flash$/, ' Flash');
}

// Returns the chain of model ids to try for a given intent.
// Preferred-tier models come first, then the other tier as a fallback.
//
// E.g., for intent='tool':
//   [pro, 2.5-flash, 2.0-flash, 1.5-pro, 1.5-flash,         // reasoning
//    2.5-flash-lite, 2.0-flash-lite, 1.5-flash-8b]          // fast
//
// For intent='prose':
//   [2.5-flash-lite, 2.0-flash-lite, 1.5-flash-8b,          // fast
//    pro, 2.5-flash, 2.0-flash, 1.5-pro, 1.5-flash]         // reasoning
export function modelChainFor(intent) {
    const preferredTier = intent === 'prose' ? 'fast' : 'reasoning';
    const preferred = GEMINI_MODELS.filter(m => m.tier === preferredTier).map(m => m.id);
    const fallback  = GEMINI_MODELS.filter(m => m.tier !== preferredTier).map(m => m.id);
    return [...preferred, ...fallback];
}

// Reverse lookup — used by the status pill to render a tier badge.
export function tierFor(modelId) {
    const m = GEMINI_MODELS.find(x => x.id === modelId);
    return m?.tier || 'unknown';
}
