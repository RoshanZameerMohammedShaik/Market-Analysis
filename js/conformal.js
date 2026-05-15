// Conformal prediction intervals for next-bar return.
//
// Loads model/backtest_results.json (separate cache from calibration.js so
// modules don't depend on each other's load order). Each (signal, confidence-
// bucket) maps to a residual quantile q_0.70: with 70% historical coverage,
// the next-bar return falls within ±q.
//
// Returns null if no data is available so callers can fall back gracefully.

let conformalData = null;
let status = 'unloaded'; // 'unloaded' | 'loaded' | 'unavailable'

export async function loadConformal() {
    if (status !== 'unloaded') return conformalData;
    try {
        const res = await fetch('./model/backtest_results.json');
        if (!res.ok) { status = 'unavailable'; return null; }
        const data = await res.json();
        conformalData = data?.overall?.conformal || null;
        status = conformalData ? 'loaded' : 'unavailable';
        return conformalData;
    } catch (_) {
        status = 'unavailable';
        return null;
    }
}

export function getConformalStatus() { return status; }

/**
 * Returns the symmetric ±return interval for a given signal+confidence.
 * Result shape: { lo_pct, hi_pct, n, alpha } or null when unavailable
 * or insufficient data (n < 20).
 *
 * - signal: 'BUY' | 'SELL' | 'NEUTRAL'
 * - confidence: 0-100 calibrated confidence
 */
export function getInterval(signal, confidence) {
    if (!conformalData || !conformalData.buckets) return null;
    const bucketKey = bucketFor(signal, confidence);
    const b = conformalData.buckets[bucketKey];
    if (!b || b.n < 20) {
        // Try a wider fallback: same signal, any confidence.
        const wide = conformalData.buckets[`${signal}-any`];
        if (wide && wide.n >= 20) return { lo_pct: -wide.q70_pct, hi_pct: wide.q70_pct, n: wide.n, alpha: 0.30, fallback: 'signal-only' };
        return null;
    }
    return { lo_pct: -b.q70_pct, hi_pct: b.q70_pct, n: b.n, alpha: 0.30 };
}

function bucketFor(signal, confidence) {
    const c = Math.max(0, Math.min(100, Math.round(confidence)));
    const lo = Math.floor(c / 10) * 10;
    return `${signal}-${lo}-${lo + 10}`;
}
