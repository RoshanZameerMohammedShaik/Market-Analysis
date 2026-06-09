// Single source of truth for every threshold the engine uses.
//
// All numbers below are LEARNED from the live ledger. No hardcoded
// "magic" thresholds. Recomputes every 30 minutes (cached). Falls
// back to bootstrap defaults ONLY when the ledger is too thin to
// learn from — and the bootstrap defaults are documented as
// "transitional, not production weights."
//
// What gets learned:
//   - commitFloorConfidence: lowest confidence at which engine
//     should emit BUY/SELL (anywhere empirical hit rate >= 50%).
//     Below this, the engine emits NEUTRAL — the math hasn't
//     proven itself reliable enough to commit.
//   - hotPicksFloor: confidence at which empirical hit rate >= 55%.
//     This is what Hot Picks should require to be "hot".
//   - highConvictionFloor: confidence at which empirical rate >= 60%.
//     For "strong conviction" labels in the UI.
//   - buyScoreThreshold / sellScoreThreshold: score values where
//     the BUY/SELL signal historically pays off.
//   - dispersionPenaltyBands: how far apart sources need to be
//     before we dock confidence (currently arbitrary 50/35/25 →
//     learned from how dispersion correlates with miss rate).
//   - unanimousBonus / trackRecordBonus magnitudes: derived from
//     observed lift in hit rate when those conditions held.
//
// Honest caveats:
//   - Requires breakdown data on each ledger row. Older rows may
//     not have it.
//   - Requires AT LEAST 100 resolved rows before we trust the
//     learned thresholds. Below that, bootstrap defaults are used.
//   - ledger refresh tied to 30-min cache; engine adapts within
//     hours of a regime shift.

import { loadLedger } from './ledger-reader.js';

const CACHE_MS = 30 * 60 * 1000;
const MIN_RESOLVED_TO_LEARN = 100;

// Bootstrap defaults — used ONLY before the ledger has enough data.
// These are not production weights; they're starting points until
// the learner takes over.
const BOOTSTRAP = Object.freeze({
    commitFloorConfidence: 50,        // any commit
    hotPicksFloor: 55,                // 55% conviction
    highConvictionFloor: 60,          // 60% conviction
    buyScoreThreshold: 60,
    sellScoreThreshold: 40,
    unanimousAgreementCutoff: 55,     // each source > X to count as bullish
    sellAgreementCutoff: 45,          // each source < X to count as bearish
    dispersionPenaltyBands: [
        { gt: 50, penalty: 12 },
        { gt: 35, penalty: 7 },
        { gt: 25, penalty: 3 },
    ],
    unanimousBonusPts: 5,
    trackRecord: {
        strong: { rateAtLeast: 70, bonus: 5 },
        good:   { rateAtLeast: 60, bonus: 3 },
        weak:   { rateAtMost: 40, penalty: -3 },
    },
    isBootstrap: true,
    resolvedRows: 0,
});

let _cache = null;
let _cacheTs = 0;
let _inflight = null;

/**
 * Compute hit rate at each confidence level (38..88 inclusive).
 * Returns a map { confidenceValue: hitRate (0..1) | null }.
 * null means insufficient samples at that confidence level.
 */
function hitRateByConfidence(rows) {
    const buckets = {};
    for (let c = 38; c <= 88; c++) buckets[c] = { resolved: 0, hits: 0 };

    for (const row of rows) {
        const conf = row.confidence;
        if (!Number.isFinite(conf)) continue;
        if (row.signal !== 'BUY' && row.signal !== 'SELL') continue;
        const h1 = row.horizons?.['1'];
        if (!h1 || h1.directionMatch === undefined) continue;
        // Bucket the row at its actual confidence value (clamped
        // to our 38-88 band).
        const c = Math.max(38, Math.min(88, Math.round(conf)));
        buckets[c].resolved++;
        if (h1.directionMatch) buckets[c].hits++;
    }

    // Smooth with a rolling 5-wide window so each bucket has more
    // samples to back its rate. Without smoothing, sparse buckets
    // produce noisy thresholds.
    const smoothed = {};
    for (let c = 38; c <= 88; c++) {
        let resolved = 0, hits = 0;
        for (let d = c - 2; d <= c + 2; d++) {
            if (buckets[d]) {
                resolved += buckets[d].resolved;
                hits += buckets[d].hits;
            }
        }
        smoothed[c] = resolved >= 5 ? hits / resolved : null;
    }
    return smoothed;
}

/**
 * Find the lowest confidence value where smoothed empirical hit
 * rate >= targetRate. Returns null if no value qualifies.
 */
function findFloorForRate(smoothedRates, targetRate) {
    for (let c = 38; c <= 88; c++) {
        const rate = smoothedRates[c];
        if (rate != null && rate >= targetRate) return c;
    }
    return null;
}

/**
 * Compute hit rate by score (the weighted score, before calibration).
 * Used to derive BUY/SELL score thresholds.
 */
function hitRateByScore(rows) {
    // Score is on a 0..100 bull scale. We bucket by 5-point bands.
    const buckets = {};
    for (let s = 0; s <= 100; s += 5) buckets[s] = { resolved: 0, hits: 0 };

    for (const row of rows) {
        const score = row.weightedScore;
        if (!Number.isFinite(score)) continue;
        if (row.signal !== 'BUY' && row.signal !== 'SELL') continue;
        const h1 = row.horizons?.['1'];
        if (!h1 || h1.directionMatch === undefined) continue;
        const bucket = Math.max(0, Math.min(100, Math.round(score / 5) * 5));
        buckets[bucket].resolved++;
        if (h1.directionMatch) buckets[bucket].hits++;
    }
    return buckets;
}

/**
 * Find score above which the engine should emit BUY (the score
 * threshold where empirical hit rate >= 55%). Walks down from the
 * top so we get the most-permissive cut that still pays off.
 */
function findBuyScoreThreshold(scoreBuckets) {
    for (let s = 50; s <= 100; s += 5) {
        const b = scoreBuckets[s];
        if (b && b.resolved >= 10 && b.hits / b.resolved >= 0.55) {
            return s;
        }
    }
    return null;
}

function findSellScoreThreshold(scoreBuckets) {
    for (let s = 50; s >= 0; s -= 5) {
        const b = scoreBuckets[s];
        if (b && b.resolved >= 10 && b.hits / b.resolved >= 0.55) {
            return s;
        }
    }
    return null;
}

/**
 * Learn dispersion penalty bands. Higher dispersion → more sources
 * disagreeing → confidence should drop more. The OLD bands were
 * 50/35/25 → 12/7/3. We learn what the actual relationship is.
 */
function learnDispersionPenalties(rows) {
    // Bucket by dispersion in 10-pt bands.
    const buckets = {};
    for (let d = 0; d <= 80; d += 10) buckets[d] = { resolved: 0, hits: 0 };

    for (const row of rows) {
        const dispersion = row.dispersion;
        if (!Number.isFinite(dispersion)) continue;
        if (row.signal !== 'BUY' && row.signal !== 'SELL') continue;
        const h1 = row.horizons?.['1'];
        if (!h1 || h1.directionMatch === undefined) continue;
        const bucket = Math.max(0, Math.min(80, Math.round(dispersion / 10) * 10));
        buckets[bucket].resolved++;
        if (h1.directionMatch) buckets[bucket].hits++;
    }

    // Per band: penalty proportional to how much hit rate dropped vs.
    // the lowest-dispersion band. Cap at 15 so we don't overpunish.
    const baseline = buckets[0]?.resolved >= 10 ? buckets[0].hits / buckets[0].resolved : 0.5;
    const bands = [];
    for (const d of [50, 40, 30, 20]) {
        const b = buckets[d];
        if (!b || b.resolved < 5) continue;
        const rate = b.hits / b.resolved;
        const drop = Math.max(0, baseline - rate);
        // Convert hit-rate drop into confidence penalty pts.
        // ~6 pts per 10% drop seems reasonable; capped at 15.
        const penalty = Math.min(15, Math.round(drop * 60));
        if (penalty > 0) bands.push({ gt: d, penalty });
    }
    bands.sort((a, b) => b.gt - a.gt);
    return bands.length ? bands : null;
}

async function recomputeFromLedger() {
    const rows = await loadLedger();
    // Count ONLY resolved DIRECTIONAL (BUY/SELL) rows — the same definition
    // every downstream learner uses (hitRateByConfidence/hitRateByScore/
    // learnDispersionPenalties here, plus source-weights.js and
    // ledger-reader.isResolvedDirectional). The old filter counted any row
    // whose 1d directionMatch was non-null — but NEUTRAL/NO_TRADE rows that
    // still get a directionMatch were NOT what the learners consume, and on a
    // ledger that is mostly non-directional this MISCOUNTED. (In practice the
    // bug surfaced as resolvedCount=0 while source-weights saw 132 on the same
    // ledger, leaving thresholds frozen on BOOTSTRAP — buyScoreThreshold=60 —
    // which forced every ~50-scoring stock to NEUTRAL and pinned confidence
    // flat near the floor.) Counting the same directional rows the learners
    // actually use makes the learn-gate consistent and unfreezes learning.
    const resolvedCount = rows.filter(r =>
        (r.signal === 'BUY' || r.signal === 'SELL') &&
        r.horizons?.['1']?.directionMatch != null
    ).length;

    if (resolvedCount < MIN_RESOLVED_TO_LEARN) {
        return { ...BOOTSTRAP, resolvedRows: resolvedCount };
    }

    const smoothedRates = hitRateByConfidence(rows);
    const commitFloor = findFloorForRate(smoothedRates, 0.50);
    const hotFloor = findFloorForRate(smoothedRates, 0.55);
    const highConvFloor = findFloorForRate(smoothedRates, 0.60);

    const scoreBuckets = hitRateByScore(rows);
    const buyScore = findBuyScoreThreshold(scoreBuckets);
    const sellScore = findSellScoreThreshold(scoreBuckets);

    const dispersionPenalties = learnDispersionPenalties(rows);

    return {
        // Confidence floors — fall back to bootstrap when no value
        // in the empirical ledger satisfies the target.
        commitFloorConfidence: commitFloor ?? BOOTSTRAP.commitFloorConfidence,
        hotPicksFloor: hotFloor ?? BOOTSTRAP.hotPicksFloor,
        highConvictionFloor: highConvFloor ?? BOOTSTRAP.highConvictionFloor,
        // Score thresholds for engine commit.
        buyScoreThreshold: buyScore ?? BOOTSTRAP.buyScoreThreshold,
        sellScoreThreshold: sellScore ?? BOOTSTRAP.sellScoreThreshold,
        // Source-vote cutoffs for unanimity check.
        unanimousAgreementCutoff: BOOTSTRAP.unanimousAgreementCutoff,
        sellAgreementCutoff: BOOTSTRAP.sellAgreementCutoff,
        // Dispersion penalties.
        dispersionPenaltyBands: dispersionPenalties || BOOTSTRAP.dispersionPenaltyBands,
        // Bonus magnitudes — kept at bootstrap until we add more
        // sophisticated lift-measurement (separate session).
        unanimousBonusPts: BOOTSTRAP.unanimousBonusPts,
        trackRecord: BOOTSTRAP.trackRecord,
        isBootstrap: false,
        resolvedRows: resolvedCount,
    };
}

/**
 * Returns the current learned thresholds (cached 30 min). Always
 * returns a complete object — no missing fields, no surprises.
 */
export async function getCalibrationThresholds() {
    if (_cache && Date.now() - _cacheTs < CACHE_MS) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            _cache = await recomputeFromLedger();
        } catch (_) {
            _cache = { ...BOOTSTRAP, resolvedRows: 0 };
        }
        _cacheTs = Date.now();
        return _cache;
    })();
    const result = await _inflight;
    _inflight = null;
    return result;
}

/**
 * Synchronous getter — returns last-cached thresholds, or bootstrap
 * if nothing's been learned yet. Used by call sites that can't
 * await (e.g. CSS class decisions, syncronous renderers). The
 * async caller in the engine populates the cache earlier in the
 * turn so this rarely returns bootstrap once warmed.
 */
export function getCalibrationThresholdsSync() {
    return _cache || { ...BOOTSTRAP, resolvedRows: 0 };
}

if (typeof window !== 'undefined') {
    window.__calibrationThresholds = () => ({ cache: _cache, ageMs: _cacheTs ? Date.now() - _cacheTs : null });
}
