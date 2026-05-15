// Empirical calibration of signal confidence.
//
// Strata picked in priority order at inference time:
//   1. Recency-weighted curve (exp decay 30d) — fastest-moving truth
//   2. Volatility tier (low / mid / high VIX)
//   3. Liquidity tier (mega/large/mid/small/penny)
//   4. Global curve
//
// Each requires >=30 directional samples. Falls through otherwise.

let calibration = null;
let calibrationByTier = null;
let calibrationByVolTier = null;
let calibrationRecency = null;
let calibrationStatus = 'unloaded';

export async function loadCalibration() {
    if (calibrationStatus !== 'unloaded') return calibration;
    try {
        const res = await fetch('./model/backtest_results.json');
        if (!res.ok) { calibrationStatus = 'unavailable'; return null; }
        const data = await res.json();
        calibration = data?.overall?.calibration || null;
        calibrationByTier = data?.overall?.calibration_by_tier || null;
        calibrationByVolTier = data?.overall?.calibration_by_vol_tier || null;
        calibrationRecency = data?.overall?.calibration_recency_weighted || null;
        calibrationStatus = calibration ? 'loaded' : 'unavailable';
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

export function calibrate(rawConfidence, { tier = null, volTier = null } = {}) {
    // Priority 1: recency-weighted (last ~90d weighted more, half-life 30d)
    if (calibrationRecency && totalN(calibrationRecency) >= 30) {
        return interpolateOnCurve(rawConfidence, calibrationRecency);
    }
    // Priority 2: volatility tier
    if (volTier && calibrationByVolTier && calibrationByVolTier[volTier] && totalN(calibrationByVolTier[volTier]) >= 30) {
        return interpolateOnCurve(rawConfidence, calibrationByVolTier[volTier]);
    }
    // Priority 3: liquidity tier
    if (tier && calibrationByTier && calibrationByTier[tier] && totalN(calibrationByTier[tier]) >= 30) {
        return interpolateOnCurve(rawConfidence, calibrationByTier[tier]);
    }
    // Priority 4: global
    if (calibration && calibration.length > 0) {
        return interpolateOnCurve(rawConfidence, calibration);
    }
    return rawConfidence;
}

export function getCalibrationCurve() { return calibration; }
export function getCalibrationByTier() { return calibrationByTier; }
export function getCalibrationByVolTier() { return calibrationByVolTier; }
export function getCalibrationRecency() { return calibrationRecency; }
