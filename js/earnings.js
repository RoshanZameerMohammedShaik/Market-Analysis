// Earnings proximity check. Yahoo's quoteSummary returns the next
// earnings date when available. We cap confidence near earnings
// because technicals lose predictiveness in front of binary events.

import { fetchWithProxy } from './data.js';

const cache = new Map(); // symbol -> { ts, daysUntil }
const TTL_MS = 60 * 60 * 1000; // 1h

export async function getEarningsProximity(symbol) {
    if (!symbol) return null;
    const c = cache.get(symbol);
    if (c && Date.now() - c.ts < TTL_MS) return c;
    try {
        // Pass raw symbol — fetchWithProxy encodes the URL exactly once
        // when routing through the worker / CORS proxy. Pre-encoding here
        // would double-encode any non-ASCII or special-char ticker.
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=earnings,calendarEvents`;
        const res = await fetchWithProxy(url);
        const j = await res.json();
        const earnings = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
        if (!earnings || earnings.length === 0) {
            const v = { ts: Date.now(), daysUntil: null };
            cache.set(symbol, v);
            return v;
        }
        const next = earnings[0]?.raw;
        if (!next) return null;
        const days = Math.ceil((next * 1000 - Date.now()) / (1000 * 60 * 60 * 24));
        const v = { ts: Date.now(), daysUntil: days };
        cache.set(symbol, v);
        return v;
    } catch (_) {
        return null;
    }
}

/** Returns { cap, reason } for how much we cap confidence by. */
export function earningsCap(daysUntil) {
    if (daysUntil == null) return { cap: 100, reason: null };
    if (daysUntil < 0) return { cap: 100, reason: null }; // past
    if (daysUntil <= 1) return { cap: 60, reason: `Earnings within 1 day — binary event risk` };
    if (daysUntil <= 5) return { cap: 70, reason: `Earnings in ${daysUntil} days — reduced predictiveness` };
    return { cap: 100, reason: null };
}
