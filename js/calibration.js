// Empirical calibration of signal confidence.
//
// Strata picked in priority order at inference time:
//   0. Live ledger by horizon+signal (real-world hit rate from
//      record_outcomes.py) — if the bucket has ≥30 samples, this beats
//      everything because it reflects current model behavior in current
//      market conditions, not a backtest replay.
//   0b. Live ledger by region (when no horizon+signal bucket but the
//       region has data — covers non-US markets).
//   1. Recency-weighted backtest curve (exp decay 30d)
//   2. Volatility tier (low / mid / high VIX)
//   3. Liquidity tier (mega/large/mid/small/penny)
//   4. Global backtest curve
//
// Each requires >=30 directional samples. Falls through otherwise.

let calibration = null;
let calibrationByTier = null;
let calibrationByVolTier = null;
let calibrationRecency = null;
let liveCalibration = null;       // model/live_calibration.json
let calibrationStatus = 'unloaded';
let lastSourceUsed = null;        // for telemetry: which strata answered last call

export async function loadCalibration() {
    if (calibrationStatus !== 'unloaded') return calibration;
    try {
        // Backtest calibration (primary source today; fallback once live has data).
        const res = await fetch('./model/backtest_results.json');
        if (res.ok) {
            const data = await res.json();
            calibration = data?.overall?.calibration || null;
            calibrationByTier = data?.overall?.calibration_by_tier || null;
            calibrationByVolTier = data?.overall?.calibration_by_vol_tier || null;
            calibrationRecency = data?.overall?.calibration_recency_weighted || null;
        }

        // Live calibration from the ledger pipeline (Step 3 output).
        // Optional — file may not exist yet on fresh deploys.
        try {
            const lr = await fetch('./model/live_calibration.json');
            if (lr.ok) liveCalibration = await lr.json();
        } catch (_) { /* ledger not seeded yet */ }

        calibrationStatus = (calibration || liveCalibration) ? 'loaded' : 'unavailable';
        return calibration;
    } catch (_) {
        calibrationStatus = 'unavailable';
        return null;
    }
}

export function getCalibrationStatus() { return calibrationStatus; }

export function classifyTier(price, avgVolume) {
    const p = Number(price) || 0;
    const v = Number(avgVolume) || 0;
    if (p < 1) return 'penny';
    if (p < 5 || v < 100_000) return 'small';
    if (p < 20 || v < 1_000_000) return 'mid';
    if (p < 100 || v < 10_000_000) return 'large';
    return 'mega';
}

export function classifyVolTier(vix) {
    const v = Number(vix);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v < 16) return 'low';
    if (v < 22) return 'mid';
    return 'high';
}

function interpolateOnCurve(rawConfidence, curve) {
    for (const bucket of curve) {
        const [loStr, hiStr] = bucket.bucket.replace('%', '').split('-');
        const lo = parseInt(loStr, 10);
        const hi = parseInt(hiStr, 10);
        if (rawConfidence >= lo && rawConfidence < hi) {
            return Math.round(bucket.actual);
        }
    }
    if (rawConfidence < parseInt(curve[0].bucket.split('-')[0], 10)) {
        return Math.round(curve[0].actual);
    }
    return Math.round(curve[curve.length - 1].actual);
}

function totalN(curve) {
    if (!curve) return 0;
    return curve.reduce((s, b) => s + (b.count || 0), 0);
}

function liveBucketLookup(rawConfidence) {
    // Returns {actual, n} from live_calibration.byHorizon[horizon][signal][bucket]
    // for the closest matching bucket, or null. We use horizon=1 by default
    // since today's signal corresponds to the +1d outcome for calibration.
    if (!liveCalibration?.byHorizon) return null;
    const h1 = liveCalibration.byHorizon['1'];
    if (!h1) return null;
    const lo = Math.max(40, Math.min(90, Math.floor(rawConfidence / 10) * 10));
    const bucket = `${lo}-${lo + 10}`;
    // Average across BUY/SELL when both exist; falls back to whichever has data.
    const buy = h1.BUY?.[bucket];
    const sell = h1.SELL?.[bucket];
    const slots = [buy, sell].filter(s => s && s.n);
    if (!slots.length) return null;
    const totalN = slots.reduce((s, x) => s + x.n, 0);
    const weighted = slots.reduce((s, x) => s + x.actual * x.n, 0) / totalN;
    return { actual: weighted, n: totalN };
}

function liveRegionLookup(rawConfidence, region) {
    if (!liveCalibration?.byRegion || !region) return null;
    const buckets = liveCalibration.byRegion[region];
    if (!buckets) return null;
    const lo = Math.max(40, Math.min(90, Math.floor(rawConfidence / 10) * 10));
    const slot = buckets[`${lo}-${lo + 10}`];
    if (!slot || !slot.n) return null;
    return { actual: slot.actual, n: slot.n };
}

export function calibrate(rawConfidence, { tier = null, volTier = null, region = null } = {}) {
    // Priority 0: live ledger by horizon+signal (real-world, current).
    const live = liveBucketLookup(rawConfidence);
    if (live && live.n >= 30) {
        lastSourceUsed = 'live-horizon';
        return Math.round(live.actual);
    }
    // Priority 0b: live ledger by region.
    const liveR = liveRegionLookup(rawConfidence, region);
    if (liveR && liveR.n >= 30) {
        lastSourceUsed = 'live-region';
        return Math.round(liveR.actual);
    }
    // Priority 1: recency-weighted backtest
    if (calibrationRecency && totalN(calibrationRecency) >= 30) {
        lastSourceUsed = 'backtest-recency';
        return interpolateOnCurve(rawConfidence, calibrationRecency);
    }
    // Priority 2: volatility tier
    if (volTier && calibrationByVolTier && calibrationByVolTier[volTier] && totalN(calibrationByVolTier[volTier]) >= 30) {
        lastSourceUsed = 'backtest-voltier';
        return interpolateOnCurve(rawConfidence, calibrationByVolTier[volTier]);
    }
    // Priority 3: liquidity tier
    if (tier && calibrationByTier && calibrationByTier[tier] && totalN(calibrationByTier[tier]) >= 30) {
        lastSourceUsed = 'backtest-tier';
        return interpolateOnCurve(rawConfidence, calibrationByTier[tier]);
    }
    // Priority 4: global
    if (calibration && calibration.length > 0) {
        lastSourceUsed = 'backtest-global';
        return interpolateOnCurve(rawConfidence, calibration);
    }
    lastSourceUsed = 'raw';
    return rawConfidence;
}

export function getCalibrationSource() { return lastSourceUsed; }
export function getLiveCalibration() { return liveCalibration; }

// Per-horizon confidence bands. Returns one entry per horizon in
// byHorizon (1, 3, 5, 10, 20 days) showing the historical hit-rate for
// signals near this confidence level at that horizon. UI uses this so
// the user can see "engine has been 62% accurate at 1d but only 51% at
// 20d in this band" — i.e., trust shorter horizons more.
//
// Returns null when the live ledger doesn't have enough resolved
// horizons yet (we need at least 30 samples per horizon to be honest).
export function getHorizonCalibrations(rawConfidence, signal) {
    if (!liveCalibration?.byHorizon) return null;
    const lo = Math.max(40, Math.min(90, Math.floor(rawConfidence / 10) * 10));
    const bucket = `${lo}-${lo + 10}`;
    const out = [];
    for (const [hStr, perSignal] of Object.entries(liveCalibration.byHorizon)) {
        if (!perSignal) continue;
        // Match the signal first; fall back to the other side if our side
        // hasn't accumulated enough yet (better than nothing).
        const slots = [];
        const matchedKey = signal === 'BUY' ? 'BUY' : signal === 'SELL' ? 'SELL' : null;
        if (matchedKey) {
            const s = perSignal[matchedKey]?.[bucket];
            if (s && s.n >= 30) slots.push(s);
        }
        // Always also include the opposite side so light-traffic horizons
        // still report something — the average across both is honest as
        // long as we count it as "engine accuracy" not "BUY accuracy".
        for (const k of ['BUY', 'SELL']) {
            if (k === matchedKey) continue;
            const s = perSignal[k]?.[bucket];
            if (s && s.n >= 30) slots.push(s);
        }
        if (!slots.length) continue;
        const totalN = slots.reduce((acc, s) => acc + s.n, 0);
        const weightedActual = slots.reduce((acc, s) => acc + s.actual * s.n, 0) / totalN;
        out.push({
            horizonDays: parseInt(hStr, 10),
            hitRate: Math.round(weightedActual),
            n: totalN,
        });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.horizonDays - b.horizonDays);
    return out;
}
export function getCalibrationCurve() { return calibration; }
export function getCalibrationByTier() { return calibrationByTier; }
export function getCalibrationByVolTier() { return calibrationByVolTier; }
export function getCalibrationRecency() { return calibrationRecency; }
