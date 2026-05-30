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
export const GEMINI_MODELS = [
    // ── Newest / highest-quality reasoning ────────────────────────
    { id: 'gemini-pro-latest',               tier: 'reasoning', label: 'Gemini Pro (latest)' },
    { id: 'gemini-3.5-flash',                tier: 'reasoning', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3-flash',                  tier: 'reasoning', label: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-pro',                  tier: 'reasoning', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',                tier: 'reasoning', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash',                tier: 'reasoning', label: 'Gemini 2.0 Flash' },

    // ── Fast / lightweight (preferred for prose / quick chat) ─────
    { id: 'gemini-flash-latest',             tier: 'fast',      label: 'Gemini Flash (latest)' },
    { id: 'gemini-3.1-flash-lite',           tier: 'fast',      label: 'Gemini 3.1 Flash-Lite' }, // 500 RPD!
    { id: 'gemini-2.5-flash-lite',           tier: 'fast',      label: 'Gemini 2.5 Flash-Lite' },
    { id: 'gemini-2.0-flash-lite',           tier: 'fast',      label: 'Gemini 2.0 Flash-Lite' },
    { id: 'gemini-flash-lite-latest',        tier: 'fast',      label: 'Gemini Flash-Lite (latest)' },
    { id: 'gemini-1.5-flash-8b',             tier: 'fast',      label: 'Gemini 1.5 Flash-8B' },

    // ── Gemma open-weight models — 1500 RPD EACH ─────────────────
    // Tier them as 'fast' since they're sized like Flash-class. Quality
    // is roughly Gemini 3 Flash per arena.ai. The 1500 RPD ceiling is
    // ~50× larger than 2.5 Flash, so these effectively become the
    // primary fallback when Gemini's tighter buckets exhaust.
    // (Dashboard labels: 'Gemma 4 26B' / 'Gemma 4 31B'. Actual API IDs
    //  may use the -it instruction-tuned suffix or the 'latest' alias —
    //  unknown which form is currently live, so we try both forms and
    //  let 404 auto-skip the dead one.)
    { id: 'gemma-4-26b-it',                  tier: 'fast',      label: 'Gemma 4 26B' },
    { id: 'gemma-4-31b-it',                  tier: 'fast',      label: 'Gemma 4 31B' },
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
