// Crypto derivatives positioning data from Binance public REST API.
// No auth required.
//
// Endpoints:
//   /fapi/v1/premiumIndex?symbol=BTCUSDT  -> { lastFundingRate (decimal per 8h) }
//   /fapi/v1/openInterest?symbol=BTCUSDT  -> { openInterest (notional in coin) }
//   /futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=288
//
// We translate Binance's coin-denominated OI to USD via current price
// (already known to the caller) for log-scale comparison across coins.
//
// Symbol mapping: our app uses lowercase coin IDs (bitcoin, ethereum, ...).
// Binance uses BTCUSDT, ETHUSDT, etc. Map known top symbols; unknown returns null.

import { fetchWithProxy } from './data.js';

const MAP = {
    bitcoin: 'BTCUSDT',
    ethereum: 'ETHUSDT',
    solana: 'SOLUSDT',
    cardano: 'ADAUSDT',
    dogecoin: 'DOGEUSDT',
    ripple: 'XRPUSDT',
    polkadot: 'DOTUSDT',
    'avalanche-2': 'AVAXUSDT',
    chainlink: 'LINKUSDT',
    'matic-network': 'MATICUSDT',
    litecoin: 'LTCUSDT',
    uniswap: 'UNIUSDT',
    'binancecoin': 'BNBUSDT',
    'shiba-inu': 'SHIBUSDT',
    aptos: 'APTUSDT',
    arbitrum: 'ARBUSDT',
    optimism: 'OPUSDT',
    sui: 'SUIUSDT',
    aave: 'AAVEUSDT',
};

const cache = new Map(); // key -> { data, ts }
const TTL_MS = 10 * 60 * 1000;

function binanceSymbol(idOrSymbol) {
    if (!idOrSymbol) return null;
    const lower = idOrSymbol.toLowerCase();
    if (MAP[lower]) return MAP[lower];
    // Fall back: best-effort SYMBOL+USDT for raw tickers like BTC, ETH.
    const upper = idOrSymbol.toUpperCase();
    if (/^[A-Z0-9]{2,8}$/.test(upper) && !upper.endsWith('USDT')) return `${upper}USDT`;
    if (upper.endsWith('USDT')) return upper;
    return null;
}

async function fetchJson(url) {
    const res = await fetchWithProxy(url);
    const txt = await res.text();
    return JSON.parse(txt);
}

/**
 * Returns { fundingPctPer8h, oiContracts, oiTrend24hPct, exchange: 'binance' }
 * or null if unsupported / fetch fails.
 */
export async function fetchCryptoDerivs(idOrSymbol) {
    const sym = binanceSymbol(idOrSymbol);
    if (!sym) return null;
    const cached = cache.get(sym);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const out = { exchange: 'binance' };
    try {
        const fIdx = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
        const fr = parseFloat(fIdx?.lastFundingRate);
        if (Number.isFinite(fr)) out.fundingPctPer8h = fr * 100;
    } catch (_) { /* */ }

    try {
        const oi = await fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`);
        const v = parseFloat(oi?.openInterest);
        if (Number.isFinite(v)) out.oiContracts = v;
    } catch (_) { /* */ }

    try {
        const hist = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=24`);
        if (Array.isArray(hist) && hist.length >= 2) {
            const first = parseFloat(hist[0]?.sumOpenInterest);
            const last = parseFloat(hist[hist.length - 1]?.sumOpenInterest);
            if (Number.isFinite(first) && Number.isFinite(last) && first > 0) {
                out.oiTrend24hPct = ((last - first) / first) * 100;
            }
        }
    } catch (_) { /* */ }

    cache.set(sym, { data: out, ts: Date.now() });
    return out;
}

/**
 * Apply derivs to confidence. Returns { adjust, reasons }.
 * Bounded so total derivs effect stays within +/-5pts.
 *
 *   - Funding extreme positive (>+0.1%/8h) + our BUY  -> -5 (longs crowded)
 *   - Funding extreme positive + our SELL             -> +3
 *   - Funding extreme negative (<-0.1%/8h) + our SELL -> -5 (shorts crowded)
 *   - Funding extreme negative + our BUY              -> +3
 *   - OI rising 24h with our BUY  -> +2 (fresh money confirming)
 *   - OI falling with our BUY     -> -3 (short squeeze, fragile)
 *   - OI falling with our SELL    -> +1 (capitulation continuing)
 */
export function derivsAdjustment(signal, derivs, priceChange1d) {
    if (!derivs || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reasons: [] };
    const reasons = [];
    let adjust = 0;

    const f = derivs.fundingPctPer8h;
    if (Number.isFinite(f)) {
        const extPos = f > 0.1;
        const extNeg = f < -0.1;
        if (signal === 'BUY' && extPos) {
            adjust -= 5; reasons.push(`Funding extreme positive (${f.toFixed(3)}%/8h) — longs crowded, fading`);
        } else if (signal === 'BUY' && extNeg) {
            adjust += 3; reasons.push(`Funding extreme negative (${f.toFixed(3)}%/8h) — shorts trapped, contrarian boost`);
        } else if (signal === 'SELL' && extNeg) {
            adjust -= 5; reasons.push(`Funding extreme negative (${f.toFixed(3)}%/8h) — shorts crowded, fading`);
        } else if (signal === 'SELL' && extPos) {
            adjust += 3; reasons.push(`Funding extreme positive (${f.toFixed(3)}%/8h) — longs trapped, contrarian boost`);
        }
    }

    const oiTrend = derivs.oiTrend24hPct;
    if (Number.isFinite(oiTrend) && Number.isFinite(priceChange1d)) {
        const oiUp = oiTrend > 1.0;
        const oiDown = oiTrend < -1.0;
        const priceUp = priceChange1d > 0;
        if (signal === 'BUY' && priceUp && oiUp) {
            adjust += 2; reasons.push(`OI rising ${oiTrend.toFixed(1)}% with price — fresh long conviction`);
        } else if (signal === 'BUY' && priceUp && oiDown) {
            adjust -= 3; reasons.push(`OI falling ${oiTrend.toFixed(1)}% with price up — short squeeze, fragile`);
        } else if (signal === 'SELL' && !priceUp && oiUp) {
            adjust += 1; reasons.push(`OI rising ${oiTrend.toFixed(1)}% with price down — fresh shorts confirming`);
        }
    }

    // Cap total derivs adjustment at +/-5.
    if (adjust > 5) adjust = 5;
    if (adjust < -5) adjust = -5;
    return { adjust, reasons };
}
