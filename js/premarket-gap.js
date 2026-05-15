// Pre-market / overnight gap detector.
//
// Big gap (>3%) = news-driven move. Today's signal is unreliable until
// gap fills or confirms. Cap confidence to 60.

export function detectGap(multiData) {
    const candles = multiData?.daily?.candles || [];
    const currentPrice = multiData?.daily?.currentPrice;
    const previousClose = multiData?.daily?.previousClose;
    if (!currentPrice || !previousClose) return null;
    const gapPct = ((currentPrice - previousClose) / previousClose) * 100;
    const big = Math.abs(gapPct) > 3;
    return {
        gapPct: +gapPct.toFixed(2),
        big,
        direction: gapPct > 0 ? 'up' : 'down',
    };
}

export function gapCap(gap) {
    if (!gap || !gap.big) return { cap: 100, reason: null };
    return {
        cap: 60,
        reason: `Gap ${gap.gapPct > 0 ? '+' : ''}${gap.gapPct}% on open — news-driven, capping confidence until gap resolves`,
    };
}
