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

export const GEMINI_MODELS = [
    // ── Newest / highest-quality reasoning ────────────────────────
    // (Preview models are experimental; Google may deprecate them
    //  with little notice. We try them but treat 404 / 400 errors as
    //  "not available right now" and continue to the next model.)
    { id: 'gemini-2.5-pro',                  tier: 'reasoning', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',                tier: 'reasoning', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash',                tier: 'reasoning', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro',                  tier: 'reasoning', label: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash',                tier: 'reasoning', label: 'Gemini 1.5 Flash' },

    // ── Fast / lightweight ────────────────────────────────────────
    { id: 'gemini-2.5-flash-lite',           tier: 'fast',      label: 'Gemini 2.5 Flash-Lite' },
    { id: 'gemini-2.0-flash-lite',           tier: 'fast',      label: 'Gemini 2.0 Flash-Lite' },
    { id: 'gemini-1.5-flash-8b',             tier: 'fast',      label: 'Gemini 1.5 Flash-8B' },
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
