// Volume profile / High-Volume-Node (HVN) breakout detection.
//
// Bin past 20 days of price-volume into 20 price buckets. Heavy nodes
// (top 3 by total volume) are 'support/resistance memory'. Price
// breaking above an HVN on rising volume = continuation pattern.
//
// Output: { hvns: [{priceLow, priceHigh, volume}], breakAbove, breakBelow, currentPrice }
// Adjustment +/-3pt.

export function computeVolumeProfile(candles) {
    if (!candles || candles.length < 20) return null;
    const recent = candles.slice(-20);
    let pmin = Infinity, pmax = -Infinity;
    for (const c of recent) {
        if (c.low < pmin) pmin = c.low;
        if (c.high > pmax) pmax = c.high;
    }
    if (!isFinite(pmin) || !isFinite(pmax) || pmax <= pmin) return null;
    const BUCKETS = 20;
    const step = (pmax - pmin) / BUCKETS;
    const bins = new Array(BUCKETS).fill(0);
    for (const c of recent) {
        const tp = (c.high + c.low + c.close) / 3;
        const idx = Math.max(0, Math.min(BUCKETS - 1, Math.floor((tp - pmin) / step)));
        bins[idx] += c.volume || 0;
    }
    // Top 3 nodes by volume.
    const sorted = bins.map((v, i) => ({ idx: i, vol: v })).sort((a, b) => b.vol - a.vol);
    const top3 = sorted.slice(0, 3).map(b => ({
        priceLow: +(pmin + b.idx * step).toFixed(2),
        priceHigh: +(pmin + (b.idx + 1) * step).toFixed(2),
        volume: b.vol,
    }));
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    let breakAbove = null, breakBelow = null;
    for (const node of top3) {
        if (prev && prev.close <= node.priceHigh && last.close > node.priceHigh) breakAbove = node;
        if (prev && prev.close >= node.priceLow && last.close < node.priceLow) breakBelow = node;
    }
    return {
        hvns: top3,
        breakAbove,
        breakBelow,
        currentPrice: last.close,
    };
}

export function volumeProfileAdjustment(signal, profile, volumeTrend) {
    if (!profile || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reason: null };
    const risingVol = volumeTrend === 'rising';
    if (signal === 'BUY' && profile.breakAbove && risingVol) {
        return { adjust: +3, reason: `Broke above HVN ${profile.breakAbove.priceLow}-${profile.breakAbove.priceHigh} on rising volume — continuation likely` };
    }
    if (signal === 'BUY' && profile.breakAbove && !risingVol) {
        return { adjust: -2, reason: `HVN breakout but volume not confirming — false break risk` };
    }
    if (signal === 'SELL' && profile.breakBelow && risingVol) {
        return { adjust: +3, reason: `Broke below HVN ${profile.breakBelow.priceLow}-${profile.breakBelow.priceHigh} on rising volume — confirmed breakdown` };
    }
    return { adjust: 0, reason: null };
}
