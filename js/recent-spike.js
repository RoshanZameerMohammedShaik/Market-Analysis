// Days-since-last-50%-day mean-reversion flag.
//
// Penny / small-cap stocks that recently had a 50%+ daily move are
// almost always in chop or mean-reversion zone for ~5 trading days.
// Cap signals during that window.

export function findRecentSpike(candles, threshold = 50) {
    if (!candles || candles.length < 6) return null;
    const last = candles.slice(-10);
    for (let i = last.length - 1; i >= 0; i--) {
        const c = last[i];
        const prev = i > 0 ? last[i - 1] : null;
        if (!prev || !prev.close) continue;
        const pct = ((c.close - prev.close) / prev.close) * 100;
        if (Math.abs(pct) >= threshold) {
            const daysAgo = last.length - 1 - i;
            return { daysAgo, pct: +pct.toFixed(1) };
        }
    }
    return null;
}

export function recentSpikeCap(spike) {
    if (!spike) return { cap: 100, reason: null };
    if (spike.daysAgo > 5) return { cap: 100, reason: null };
    return {
        cap: 55,
        reason: `${spike.pct}% spike ${spike.daysAgo}d ago — mean reversion zone, signal capped`,
    };
}
