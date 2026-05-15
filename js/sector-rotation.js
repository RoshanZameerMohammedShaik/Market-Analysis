// Sector momentum rotation tracking. Rank 11 SPDR sector ETFs by
// 5-day and 20-day returns. Stocks in leading sectors get a confidence
// boost on BUY signals; lagging sectors penalize them.

import { fetchWithProxy } from './data.js';
import { symbolSector } from './sectors.js';

const ETFS = ['XLK', 'XLC', 'XLY', 'XLP', 'XLV', 'XLF', 'XLE', 'XLI', 'XLU', 'XLB', 'XLRE'];

let rotationCache = null;
const TTL_MS = 15 * 60 * 1000;

async function fetchEtfReturns() {
    if (rotationCache && Date.now() - rotationCache.ts < TTL_MS) return rotationCache.data;
    const out = {};
    await Promise.all(ETFS.map(async etf => {
        try {
            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${etf}?range=1mo&interval=1d`;
            const res = await fetchWithProxy(url);
            const json = await res.json();
            const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
            if (closes.length < 21) return;
            const last = closes[closes.length - 1];
            const back5 = closes[closes.length - 6];
            const back20 = closes[closes.length - 21] || closes[0];
            out[etf] = {
                pct5d: ((last - back5) / back5) * 100,
                pct20d: ((last - back20) / back20) * 100,
            };
        } catch (_) { /* */ }
    }));
    rotationCache = { ts: Date.now(), data: out };
    return out;
}

/**
 * Returns { rank: 1..11, total: 11, leader: bool, laggard: bool, etf, pct5d, pct20d }
 * or null when sector unknown / data missing.
 * Composite score: 0.7 * pct5d + 0.3 * pct20d.
 */
export async function getSectorRotation(symbol) {
    const sec = symbolSector(symbol);
    if (!sec) return null;
    const data = await fetchEtfReturns();
    if (!data[sec.etf]) return null;

    const ranked = Object.entries(data).map(([etf, v]) => ({
        etf,
        score: 0.7 * v.pct5d + 0.3 * v.pct20d,
        ...v,
    })).sort((a, b) => b.score - a.score);

    const idx = ranked.findIndex(r => r.etf === sec.etf);
    if (idx < 0) return null;
    const rank = idx + 1;
    const total = ranked.length;
    return {
        rank, total,
        etf: sec.etf,
        sectorName: sec.name,
        pct5d: +data[sec.etf].pct5d.toFixed(2),
        pct20d: +data[sec.etf].pct20d.toFixed(2),
        leader: rank <= 3,
        laggard: rank >= total - 2,
    };
}

export function rotationAdjustment(signal, rotation) {
    if (!rotation || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reason: null };
    if (signal === 'BUY' && rotation.leader) return { adjust: +3, reason: `${rotation.sectorName} sector ranks #${rotation.rank}/${rotation.total} (${rotation.pct5d}% 5d) — leading rotation supports BUY` };
    if (signal === 'BUY' && rotation.laggard) return { adjust: -4, reason: `${rotation.sectorName} sector ranks #${rotation.rank}/${rotation.total} — lagging rotation, BUY weakened` };
    if (signal === 'SELL' && rotation.laggard) return { adjust: +3, reason: `${rotation.sectorName} sector lagging (#${rotation.rank}) — SELL supported by rotation` };
    if (signal === 'SELL' && rotation.leader) return { adjust: -3, reason: `${rotation.sectorName} sector leading (#${rotation.rank}) — SELL conflicts with rotation` };
    return { adjust: 0, reason: null };
}
