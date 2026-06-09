// Live source-weight learner.
//
// Replaces the hardcoded 0.15 / 0.35 / 0.25 / 0.25 source weights
// with weights computed FROM the live ledger every 30 minutes.
// Per-source hit rate → normalized weight.
//
// What this does:
//   For every resolved 1d row in the live ledger, look at the
//   per-source breakdown that was logged at prediction time:
//     row.breakdown = { ai, technical, sentiment, market } each on
//     0-100 bull scale.
//   The "actual" 1d outcome is row.horizons['1'].directionMatch
//   (true = engine signal was right).
//   For each source, count: when this source was strongly bullish
//   (>55) and the actual outcome was UP → hit. When strongly
//   bearish (<45) and outcome was DOWN → hit. Anything else → miss
//   for that source on that row.
//   Hit rates per source → normalized to weights that sum to 1.0.
//
// Honest caveats:
//   - Requires breakdown data on each ledger row. Older rows may
//     not have it; we skip those.
//   - Requires AT LEAST 50 resolved rows with breakdown data
//     before we trust the empirical weights — fall back to the
//     hardcoded baseline below until that bar is hit.
//   - Recomputes every 30 min in the background (cached). Real-time
//     enough that the engine adapts to regime shifts within hours.

import { loadLedger } from './ledger-reader.js';

const CACHE_MS = 30 * 60 * 1000; // 30 min — real-time enough, cheap enough
const MIN_RESOLVED_FOR_LEARNING = 50;

// Fallback baseline if the ledger is too thin to learn from. NOT
// a hardcoded production weight — only used until enough resolved
// rows exist for empirical learning. The dynamic_only rule allows
// fallbacks while the engine is bootstrapping data.
const FALLBACK_AI_PRESENT = { ai: 0.15, technical: 0.35, sentiment: 0.25, market: 0.25 };
const FALLBACK_AI_MISSING = { ai: 0,    technical: 0.40, sentiment: 0.30, market: 0.30 };

let _cache = null;
let _cacheTs = 0;
let _inflight = null;

/**
 * Compute per-source hit rates from the live ledger.
 * Each source is "right" on a given row when its directional vote
 * matched the 1d horizon's directionMatch.
 */
function computeHitRates(rows) {
    const sources = ['ai', 'technical', 'sentiment', 'market'];
    const counts = {};
    for (const s of sources) {
        counts[s] = { resolved: 0, hits: 0 };
    }

    for (const row of rows) {
        const h1 = row.horizons?.['1'];
        if (!h1 || h1.directionMatch == null) continue;  // != null: also skip NO_TRADE nulls
        const bd = row.breakdown;
        if (!bd) continue;
        // Only look at directionally-committed signals.
        if (row.signal !== 'BUY' && row.signal !== 'SELL') continue;
        const wantUp = row.signal === 'BUY';
        const matched = h1.directionMatch === true;

        for (const s of sources) {
            const sourceData = bd[s];
            const score = sourceData?.score;
            if (score == null || !Number.isFinite(score)) continue;
            // Skip sources that abstained (50 = neutral). The source
            // can't be "right" on a row it didn't take a stand on.
            if (score >= 45 && score <= 55) continue;
            const sourceVotedUp = score > 55;
            // The source was directionally "right" when:
            //   (a) it agreed with the engine's commit AND the
            //       engine's commit was right, OR
            //   (b) it disagreed AND the engine's commit was wrong
            // Either way: did this source's bullishness align with
            // what actually happened?
            const sourceCorrect = sourceVotedUp ? matched === wantUp : matched !== wantUp;
            counts[s].resolved++;
            if (sourceCorrect) counts[s].hits++;
        }
    }
    return counts;
}

/**
 * Convert per-source hit rates into normalized weights summing to 1.
 * Higher hit rate → bigger weight. Keep a 5% floor so a source that's
 * been mediocre lately can still recover.
 */
function hitRatesToWeights(counts) {
    const sources = ['ai', 'technical', 'sentiment', 'market'];
    const rates = {};
    let total = 0;
    for (const s of sources) {
        const c = counts[s];
        // Sources with no resolved rows get the baseline rate (50%)
        // so they're not zero-weighted before they have data.
        const rate = c.resolved >= 5 ? c.hits / c.resolved : 0.5;
        // Center on 50% — a source at 50% (coin-flip) gets baseline
        // weight; above lifts it, below docks it.
        const lift = Math.max(0, rate - 0.30); // floor at 30% so a bad source still gets some weight
        rates[s] = lift;
        total += lift;
    }
    if (total === 0) {
        // Defensive — all sources scoring 30% or below means data is
        // garbage. Fall back to baseline.
        return null;
    }
    const weights = {};
    for (const s of sources) {
        weights[s] = rates[s] / total;
    }
    return weights;
}

/**
 * Returns the weights to use for the next computeFullConfidence call.
 * `aiAvailable` controls whether AI is included (LSTM may not be
 * loaded yet on the very first analysis).
 */
export async function getLearnedWeights(aiAvailable) {
    // Cache check — return cached weights if fresh.
    if (_cache && Date.now() - _cacheTs < CACHE_MS) {
        return _adjustForAi(_cache, aiAvailable);
    }
    // Coalesce concurrent callers onto a single fetch.
    if (_inflight) return _inflight.then(c => _adjustForAi(c, aiAvailable));
    _inflight = (async () => {
        try {
            const rows = await loadLedger();
            const counts = computeHitRates(rows);
            // Gate on the LEAST-resolved source, not the most. Using Math.max
            // let learning fire as soon as ANY single source (in practice only
            // technical, which swings outside the 45-55 abstain band) cleared
            // the bar — while ai/sentiment/market sat at 0 resolved. The
            // hitRatesToWeights floor then zeroed the one data-backed source and
            // split the weight evenly across the three undatae'd ones
            // ({technical:0, ai/sentiment/market:0.333}), collapsing every
            // stock's weightedScore to ~50 and pinning confidence flat at ~51.
            // Requiring ALL sources to have real resolved data before we trust a
            // learned vector means we stay on the sound technical-led FALLBACK
            // baseline (0.15/0.35/0.25/0.25) until every source is genuinely
            // measurable — which restores per-stock differentiation now and only
            // adopts learned weights once they're honestly grounded.
            const minResolved = Math.min(...Object.values(counts).map(c => c.resolved));
            if (minResolved < MIN_RESOLVED_FOR_LEARNING) {
                _cache = null; // signal to use fallback
                _cacheTs = Date.now();
                return null;
            }
            const learned = hitRatesToWeights(counts);
            _cache = { weights: learned, counts, totalResolved: minResolved };
            _cacheTs = Date.now();
            return _cache;
        } catch (_) {
            _cache = null;
            _cacheTs = Date.now();
            return null;
        } finally {
            _inflight = null;
        }
    })();
    const result = await _inflight;
    return _adjustForAi(result, aiAvailable);
}

/**
 * If the AI source isn't available this turn, redistribute its
 * weight proportionally to the other three. Otherwise return as-is.
 */
function _adjustForAi(cacheEntry, aiAvailable) {
    if (!cacheEntry || !cacheEntry.weights) {
        return aiAvailable ? FALLBACK_AI_PRESENT : FALLBACK_AI_MISSING;
    }
    const w = cacheEntry.weights;
    if (aiAvailable) return { ...w, _learned: true, _resolved: cacheEntry.totalResolved };
    // AI off this turn: redistribute its weight across the other three
    // proportionally to their existing weights.
    const remaining = w.technical + w.sentiment + w.market;
    if (remaining === 0) return FALLBACK_AI_MISSING;
    return {
        ai: 0,
        technical: w.technical / remaining,
        sentiment: w.sentiment / remaining,
        market: w.market / remaining,
        _learned: true,
        _resolved: cacheEntry.totalResolved,
    };
}

/** Inspect cached state for diagnostics. */
export function getWeightStats() {
    return { cache: _cache, cacheAgeMs: _cacheTs ? Date.now() - _cacheTs : null };
}

if (typeof window !== 'undefined') {
    window.__sourceWeights = getWeightStats;
}
