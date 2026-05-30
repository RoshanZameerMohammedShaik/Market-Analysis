// Per-symbol earnings reaction history. Pulls last 4 quarters of
// reported earnings via Yahoo's free quoteSummary endpoint and looks
// at the next-day post-earnings move from existing candles.
//
// Output: { avgReactionPct, count, capWhenInWindow }
// If avg reaction is consistently negative and we're inside a 5-day
// pre-earnings window (already detected by earnings.js), tighten the
// cap below the generic 70.

import { fetchWithProxy } from './data.js';

const cache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function getEarningsReactionHistory(symbol, candles) {
    const key = (symbol || '').toUpperCase();
    if (!key || !candles || candles.length < 80) return null;
    const c = cache.get(key);
    if (c && Date.now() - c.ts < TTL_MS) return c.value;

    try {
        // Raw symbol — fetchWithProxy encodes once at the proxy layer.
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${key}?modules=earningsHistory`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const items = json?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];
        if (!items.length) { cache.set(key, { ts: Date.now(), value: null }); return null; }

        // Each item has a quarter date; use it to find the next-day candle
        // and compute the reaction.
        const reactions = [];
        for (const it of items.slice(-4)) {
            const dateRaw = it?.quarter?.fmt;
            if (!dateRaw) continue;
            // Reports typically ~30-45 days after quarter end. Look 30-50d after.
            const qEnd = new Date(dateRaw);
            const targetMin = new Date(qEnd.getTime() + 25 * 86400000);
            const targetMax = new Date(qEnd.getTime() + 60 * 86400000);
            // Find candle in window with the largest absolute gap vs prior day.
            let bestPct = 0;
            for (let i = 1; i < candles.length; i++) {
                const cur = candles[i];
                if (!cur.time) continue;
                const t = new Date(cur.time * 1000);
                if (t < targetMin || t > targetMax) continue;
                const prev = candles[i - 1];
                if (!prev.close) continue;
                const pct = ((cur.close - prev.close) / prev.close) * 100;
                if (Math.abs(pct) > Math.abs(bestPct)) bestPct = pct;
            }
            if (bestPct !== 0) reactions.push(bestPct);
        }

        if (reactions.length === 0) { cache.set(key, { ts: Date.now(), value: null }); return null; }
        const avg = reactions.reduce((s, v) => s + v, 0) / reactions.length;
        const value = {
            avgReactionPct: +avg.toFixed(2),
            count: reactions.length,
            reactions: reactions.map(r => +r.toFixed(2)),
        };
        cache.set(key, { ts: Date.now(), value });
        return value;
    } catch (_) {
        return null;
    }
}

/**
 * If we're in the 5-day pre-earnings window AND historical reactions
 * skew negative, tighten the cap. Otherwise no change.
 */
export function earningsHistoryCap(history, daysUntilEarnings, signal) {
    if (!history || history.count < 2) return { cap: 100, reason: null };
    if (daysUntilEarnings == null || daysUntilEarnings < 0 || daysUntilEarnings > 5) return { cap: 100, reason: null };
    const avg = history.avgReactionPct;
    if (signal === 'BUY' && avg < -3) {
        return { cap: 55, reason: `Last ${history.count}q avg post-earnings move ${avg}% — historically negative, BUY capped tighter` };
    }
    if (signal === 'SELL' && avg > 3) {
        return { cap: 55, reason: `Last ${history.count}q avg post-earnings move +${avg}% — historically positive, SELL capped tighter` };
    }
    return { cap: 100, reason: null };
}
