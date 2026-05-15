// 20-day Volume-Weighted Average Price + deviation classifier.
//
// Insight: stocks below VWAP on declining volume tend to mean-revert
// upward; stocks above VWAP on rising volume tend to continue. Stocks
// below VWAP on rising volume = real distribution (bearish).
//
// Output: { vwap, deviationPct, volumeTrend, regime: 'continuation'|'reversion'|'distribution' }
// Adjustment is bounded +/-3pt.

export function computeVwapClassifier(candles) {
    if (!candles || candles.length < 20) return null;
    const recent = candles.slice(-20);
    let sumPV = 0, sumV = 0;
    for (const c of recent) {
        const tp = (c.high + c.low + c.close) / 3;
        const v = c.volume || 0;
        sumPV += tp * v;
        sumV += v;
    }
    if (sumV === 0) return null;
    const vwap = sumPV / sumV;
    const last = recent[recent.length - 1];
    const deviationPct = ((last.close - vwap) / vwap) * 100;

    // Volume trend over last 5 vs prior 15.
    const recentVol = recent.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5;
    const priorVol = recent.slice(0, 15).reduce((s, c) => s + (c.volume || 0), 0) / 15;
    if (priorVol === 0) return { vwap, deviationPct, volumeTrend: 'flat', regime: 'unknown' };
    const volRatio = recentVol / priorVol;
    let volumeTrend = 'flat';
    if (volRatio > 1.2) volumeTrend = 'rising';
    else if (volRatio < 0.8) volumeTrend = 'declining';

    let regime = 'neutral';
    if (deviationPct > 1 && volumeTrend === 'rising') regime = 'continuation-up';
    else if (deviationPct < -1 && volumeTrend === 'declining') regime = 'reversion-up';
    else if (deviationPct < -1 && volumeTrend === 'rising') regime = 'distribution';
    else if (deviationPct > 1 && volumeTrend === 'declining') regime = 'topping';

    return {
        vwap: +vwap.toFixed(2),
        deviationPct: +deviationPct.toFixed(2),
        volumeTrend,
        regime,
    };
}

export function vwapAdjustment(signal, vwapData) {
    if (!vwapData || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reason: null };
    const { regime, deviationPct } = vwapData;
    if (signal === 'BUY' && regime === 'reversion-up') return { adjust: +3, reason: `Below VWAP (${deviationPct}%) on declining volume — mean reversion supports BUY` };
    if (signal === 'BUY' && regime === 'continuation-up') return { adjust: +2, reason: `Above VWAP (${deviationPct}%) on rising volume — trend continuation supports BUY` };
    if (signal === 'BUY' && regime === 'distribution') return { adjust: -3, reason: `Below VWAP on rising volume — real selling, BUY weakened` };
    if (signal === 'SELL' && regime === 'topping') return { adjust: +3, reason: `Above VWAP on declining volume — distribution at top, SELL supported` };
    if (signal === 'SELL' && regime === 'distribution') return { adjust: +2, reason: `Below VWAP on rising volume — confirmed selling pressure` };
    return { adjust: 0, reason: null };
}
