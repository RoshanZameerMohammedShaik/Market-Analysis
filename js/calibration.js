// Empirical calibration of signal confidence.
//
// The pipeline produces a heuristic 38-88 confidence number. Without
// calibration that number means "how strongly the indicators agreed" —
// it does NOT mean "this prediction will hit X% of the time." That gap
// matters when real money is on the line.
//
// Now stratified by liquidity tier: penny stocks have different hit rate
// distributions than mega-caps, so one global curve overcorrects in some
// places and undercorrects in others. Tier-specific curves with global
// fallback when a tier has < 30 samples.

let calibration = null;          // global fallback curve
let calibrationByTier = null;    // { mega: [...], large: [...], mid: [...], small: [...], penny: [...] }
let calibrationStatus = 'unloaded';

export async function loadCalibration() {
    if (calibrationStatus !== 'unloaded') return calibration;
    try {
        const res = await fetch('./model/backtest_results.json');
        if (!res.ok) { calibrationStatus = 'unavailable'; return null; }
        const data = await res.json();
        calibration = data?.overall?.calibration || null;
        calibrationByTier = data?.overall?.calibration_by_tier || null;
        calibrationStatus = calibration ? 'loaded' : 'unavailable';
        return calibration;
    } catch (_) {
        calibrationStatus = 'unavailable';
        return null;
    }
}

export function getCalibrationStatus() { return calibrationStatus; }

/**
 * Classify a symbol's liquidity tier from price + 21-day avg volume.
 * Returns one of: 'mega' | 'large' | 'mid' | 'small' | 'penny'.
 */
export function classifyTier(price, avgVolume) {
    const p = Number(price) || 0;
    const v = Number(avgVolume) || 0;
    if (p < 1) return 'penny';
    if (p < 5 || v < 100_000) return 'small';
    if (p < 20 || v < 1_000_000) return 'mid';
    if (p < 100 || v < 10_000_000) return 'large';
    return 'mega';
}

/**
 * Map a raw confidence (38-88) to its empirical hit rate.
 * If `tier` is provided and has ≥30 samples, uses the tier-specific
 * curve. Otherwise falls back to the global curve. Returns the raw
 * value unchanged if no calibration is available.
 */
export function calibrate(rawConfidence, tier = null) {
    let curve = calibration;
    if (tier && calibrationByTier && calibrationByTier[tier]) {
        const tierCurve = calibrationByTier[tier];
        const totalN = tierCurve.reduce((s, b) => s + (b.count || 0), 0);
        if (totalN >= 30) curve = tierCurve;
    }
    if (!curve || curve.length === 0) return rawConfidence;

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

export function getCalibrationCurve() { return calibration; }
export function getCalibrationByTier() { return calibrationByTier; }
