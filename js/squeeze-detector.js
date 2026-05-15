// Bollinger Band squeeze detection + breakout magnitude prediction.
//
// Squeeze: current BB bandwidth in bottom 20% of trailing 60-day distribution.
// Insight: longer squeezes typically lead to bigger breakouts. Bollinger's
// own research shows expansion magnitude correlates with squeeze duration.
//
// Output:
//   - inSqueeze: boolean
//   - daysInSqueeze: int
//   - bandwidthPctile: 0-100 percentile of current bandwidth vs 60d
//   - expectedExpansionPct: predicted % range expansion if squeeze breaks

function bollingerBandwidth(closes, period = 20, stdDev = 2) {
    if (!closes || closes.length < period) return null;
    const slice = closes.slice(-period);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    let var_ = 0;
    for (const v of slice) var_ += (v - mean) * (v - mean);
    const std = Math.sqrt(var_ / period);
    const upper = mean + stdDev * std;
    const lower = mean - stdDev * std;
    const last = closes[closes.length - 1];
    if (mean === 0) return null;
    return { bandwidth: (upper - lower) / mean, last, mean };
}

/**
 * @param closes  number[] daily closes (oldest first)
 */
export function detectSqueeze(closes) {
    if (!closes || closes.length < 80) return null;
    // Build a series of trailing bandwidths over the last 60 bars.
    const series = [];
    for (let i = closes.length - 60; i < closes.length; i++) {
        const bw = bollingerBandwidth(closes.slice(0, i + 1), 20, 2);
        if (bw) series.push(bw.bandwidth);
    }
    if (series.length < 30) return null;

    const current = series[series.length - 1];
    const sorted = [...series].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current);
    const pctile = Math.max(0, Math.min(100, Math.round((rank / sorted.length) * 100)));

    const inSqueeze = pctile <= 20;

    // Days in squeeze: count consecutive trailing bars with bandwidth in bottom 20%.
    const threshold = sorted[Math.floor(sorted.length * 0.20)];
    let days = 0;
    for (let i = series.length - 1; i >= 0; i--) {
        if (series[i] <= threshold) days++;
        else break;
    }

    // Expansion magnitude prediction: longer squeezes -> larger expected % move.
    // Calibrated empirically to ~ATR multiples.
    const expectedExpansionMult = inSqueeze
        ? 1.5 + Math.min(1.5, days / 10) // 1.5x to 3.0x normal range
        : 1.0;

    return {
        inSqueeze,
        daysInSqueeze: days,
        bandwidthPctile: pctile,
        currentBandwidth: +current.toFixed(4),
        expectedExpansionMult: +expectedExpansionMult.toFixed(2),
    };
}

/**
 * Confidence adjustment for squeeze. Squeeze + our BUY = high-conviction
 * setup since coiled energy + directional bias compounds. Capped +/-3.
 */
export function squeezeAdjustment(signal, squeeze) {
    if (!squeeze || !squeeze.inSqueeze) return { adjust: 0, reason: null };
    if (signal !== 'BUY' && signal !== 'SELL') return { adjust: 0, reason: null };
    // Only boost when squeeze is mature (>=5 days) so we don't reward random low-vol days.
    if (squeeze.daysInSqueeze < 5) return { adjust: 0, reason: null };
    const adjust = +3;
    return {
        adjust,
        reason: `BB squeeze ${squeeze.daysInSqueeze}d (bandwidth ${squeeze.bandwidthPctile}th pctile) — coiled, ${signal} bias supported`,
    };
}
