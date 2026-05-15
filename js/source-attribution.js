// Adaptive source weighting based on the user's own logged outcomes.
//
// Every resolved prediction tells us which source was "in charge"
// (dominant contribution to the weighted score) and whether the call
// was right. Over a rolling window we learn which sources are working
// in the current regime and shift weight toward them.
//
// Bounded effect: each source's shift is capped at +/-0.05 here, and
// the total in confidence.js (combined with regime weighting) is
// further capped to +/-0.10 per source.
//
// Why this works: regimes shift faster than weekly retrains. Sentiment
// dies in panic; technicals die in news shocks; AI dies on regime breaks.
// Adaptive weights reroute around the source that's currently broken,
// without retraining anything.

import { getSourceAccuracy } from './outcome-tracker.js';

const BASELINE_HIT_RATE = 0.55; // expected default; sources beating this get boosted
const MAX_SHIFT = 0.05;

/**
 * Compute weight shifts for the four sources from rolling per-source hit rates.
 * Returns { ai, technical, sentiment, market } each in [-MAX_SHIFT, +MAX_SHIFT],
 * or null if not enough outcome data exists yet.
 */
export function attributionShifts() {
    const acc = getSourceAccuracy({ windowSize: 30, min: 15 });
    if (!acc) return null;
    const out = { ai: 0, technical: 0, sentiment: 0, market: 0 };
    for (const src of Object.keys(out)) {
        const a = acc[src];
        if (!a || a.n < 5) continue;
        // Linear: +0.05 at 0.75 hit rate, -0.05 at 0.35.
        const delta = (a.hitRate - BASELINE_HIT_RATE) / 0.20 * MAX_SHIFT;
        out[src] = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, delta));
    }
    return out;
}
