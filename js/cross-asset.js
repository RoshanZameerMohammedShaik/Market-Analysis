// Cross-asset confirmations.
//
// Stocks: rising DXY pressures growth/tech, supports defensives.
//   - DXY up >1% 5d + BUY on tech/growth -> -3 (headwind)
//   - DXY down >1% 5d + BUY on tech/growth -> +2 (tailwind)
//
// Crypto alts: rising BTC dominance compresses alt prices.
//   - BTC.D up >1% 5d + BUY on alt (non-BTC) -> -3
//   - BTC.D down >1% 5d + BUY on alt -> +2
//
// Both bounded +/-3pt.

import { fetchWithProxy } from './data.js';
import { symbolSector } from './sectors.js';

let dxyCache = null;
let btcDomCache = null;
const TTL_MS = 10 * 60 * 1000;

async function fetchDxy5d() {
    if (dxyCache && Date.now() - dxyCache.ts < TTL_MS) return dxyCache.value;
    try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1mo&interval=1d`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
        if (closes.length < 6) return null;
        const cur = closes[closes.length - 1];
        const back5 = closes[closes.length - 6];
        const pct5d = ((cur - back5) / back5) * 100;
        dxyCache = { ts: Date.now(), value: pct5d };
        return pct5d;
    } catch (_) { return null; }
}

async function fetchBtcDominance5d() {
    if (btcDomCache && Date.now() - btcDomCache.ts < TTL_MS) return btcDomCache.value;
    try {
        const url = 'https://api.coingecko.com/api/v3/global';
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const cur = json?.data?.market_cap_percentage?.btc;
        if (typeof cur !== 'number') return null;
        // CoinGecko's free API doesn't give historical dominance. Use
        // 24h global cap change percentage as a proxy: if BTC outperforms
        // the total market today, dominance rises.
        const totalChange = json?.data?.market_cap_change_percentage_24h_usd || 0;
        // Rough proxy — we surface current dominance + 24h directional bias.
        btcDomCache = { ts: Date.now(), value: { current: cur, totalChange24h: totalChange } };
        return btcDomCache.value;
    } catch (_) { return null; }
}

// Tech/growth-sensitive sectors get the heaviest DXY effect.
function sectorDxySensitivity(etf) {
    if (etf === 'XLK' || etf === 'XLC' || etf === 'XLY') return 1.0;
    if (etf === 'XLP' || etf === 'XLU' || etf === 'XLE') return -0.5;
    return 0.5;
}

export async function getCrossAsset(mode, symbolOrCoinId) {
    if (mode === 'stock') {
        const dxy5d = await fetchDxy5d();
        if (dxy5d === null) return null;
        const sec = symbolSector(symbolOrCoinId);
        const sens = sec ? sectorDxySensitivity(sec.etf) : 0.5;
        return { kind: 'dxy', pct5d: +dxy5d.toFixed(2), sensitivity: sens, sector: sec?.etf };
    }
    if (mode === 'crypto') {
        const btcDom = await fetchBtcDominance5d();
        if (!btcDom) return null;
        const isBtc = /^bitcoin$|^btc/i.test(symbolOrCoinId || '');
        return { kind: 'btc-dominance', current: +btcDom.current.toFixed(2), totalChange24h: +btcDom.totalChange24h.toFixed(2), isBtc };
    }
    return null;
}

export function crossAssetAdjustment(signal, ca) {
    if (!ca || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reason: null };
    if (ca.kind === 'dxy') {
        const pressure = ca.pct5d * ca.sensitivity;
        // Positive pressure = headwind for the symbol. Threshold ~1%.
        if (signal === 'BUY' && pressure > 1) return { adjust: -3, reason: `DXY +${ca.pct5d}% 5d — dollar strength is a headwind for ${ca.sector || 'this'} BUY` };
        if (signal === 'BUY' && pressure < -1) return { adjust: +2, reason: `DXY ${ca.pct5d}% 5d — dollar weakness supports BUY` };
        if (signal === 'SELL' && pressure > 1) return { adjust: +2, reason: `DXY +${ca.pct5d}% 5d — dollar strength supports SELL` };
        return { adjust: 0, reason: null };
    }
    if (ca.kind === 'btc-dominance') {
        if (ca.isBtc) return { adjust: 0, reason: null };
        // Heuristic: when total crypto market is flat-down but BTC.D is
        // high (>50%), alts typically underperform.
        if (ca.current > 55 && signal === 'BUY') return { adjust: -3, reason: `BTC dominance ${ca.current}% — alts typically underperform, BUY weakened` };
        if (ca.current < 45 && signal === 'BUY') return { adjust: +2, reason: `BTC dominance ${ca.current}% — alt season conditions support BUY` };
        return { adjust: 0, reason: null };
    }
    return { adjust: 0, reason: null };
}
