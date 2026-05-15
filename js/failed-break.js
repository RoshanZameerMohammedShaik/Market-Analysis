// Failed-breakout / failed-breakdown detection.
//
// The single most reliable reversal pattern in classical TA: price
// violates a recent swing extreme intraday but closes back inside the
// prior range. "Bull traps" and "bear traps." When confirmed by volume,
// the reversal that follows is statistically strong.

const LOOKBACK = 20;

export function detectFailedBreak(candles) {
    if (!candles || candles.length < LOOKBACK + 2) return null;
    const recent = candles.slice(-(LOOKBACK + 1));
    const prior = recent.slice(0, LOOKBACK); // last 20 EXCLUDING today
    const today = recent[recent.length - 1];

    const swingHigh = Math.max(...prior.map(c => c.high));
    const swingLow = Math.min(...prior.map(c => c.low));

    const avgVol = prior.reduce((s, c) => s + (c.volume || 0), 0) / prior.length;
    const volRatio = avgVol > 0 ? (today.volume || 0) / avgVol : 1;

    // Failed breakout (bear trap reversed = bullish for sellers):
    // High pierced swingHigh, but close is back inside the prior range AND below swingHigh.
    if (today.high > swingHigh && today.close < swingHigh && today.close < (swingHigh + swingLow) / 2 + (swingHigh - swingLow) * 0.4) {
        return {
            kind: 'failed-breakout',
            direction: 'bearish', // reversal from up to down
            strength: Math.min(1, 0.5 + Math.max(0, volRatio - 1) * 0.3),
            reason: `Failed breakout above ${swingHigh.toFixed(2)} — closed back inside range${volRatio > 1.4 ? ` on ${volRatio.toFixed(1)}× volume` : ''}`,
            volRatio,
        };
    }
    // Failed breakdown (bull-friendly reversal):
    if (today.low < swingLow && today.close > swingLow && today.close > (swingHigh + swingLow) / 2 - (swingHigh - swingLow) * 0.4) {
        return {
            kind: 'failed-breakdown',
            direction: 'bullish',
            strength: Math.min(1, 0.5 + Math.max(0, volRatio - 1) * 0.3),
            reason: `Failed breakdown below ${swingLow.toFixed(2)} — closed back inside range${volRatio > 1.4 ? ` on ${volRatio.toFixed(1)}× volume` : ''}`,
            volRatio,
        };
    }
    return null;
}
