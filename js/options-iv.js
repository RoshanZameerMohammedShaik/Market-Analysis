// Yahoo options chain (free) for put/call ratio + ATM IV skew.
// /v7/finance/options/{SYMBOL} returns nearest-expiry options chain.
//
// Logic:
//   PCR (put volume / call volume):
//     >1.5 + our BUY  -> +3 (puts crowded, fade puts = supports BUY)
//     >1.5 + our SELL -> -2 (puts already crowded, less SELL room)
//     <0.6 + our SELL -> +3 (calls crowded, fade calls)
//     <0.6 + our BUY  -> -2 (calls already crowded)
//   Skew = (avg put IV) / (avg call IV) at ATM:
//     >1.10 + our BUY  -> +2 (downside protection bid up = market hedging fear)
//     <0.90 + our SELL -> +2 (calls bid up = euphoria; contrarian SELL)
//
// Total options effect capped at +/-4.
// Crypto and many small-caps have illiquid options — fail gracefully.

import { fetchWithProxy } from './data.js';

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function fetchOptionsPositioning(symbol) {
    if (!symbol) return null;
    const key = symbol.toUpperCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    try {
        // Raw symbol — fetchWithProxy encodes once at the proxy layer.
        const url = `https://query1.finance.yahoo.com/v7/finance/options/${key}`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const result = json?.optionChain?.result?.[0];
        if (!result) return null;
        const chain = result.options?.[0];
        if (!chain) return null;

        const calls = chain.calls || [];
        const puts = chain.puts || [];
        if (calls.length < 5 || puts.length < 5) return null; // illiquid

        const callVol = calls.reduce((s, c) => s + (c.volume || 0), 0);
        const putVol = puts.reduce((s, p) => s + (p.volume || 0), 0);
        const pcr = callVol > 0 ? putVol / callVol : null;

        // ATM skew: average IV of calls within 5% of spot vs puts within 5% of spot.
        const spot = result.quote?.regularMarketPrice;
        let skew = null;
        if (spot) {
            const window = spot * 0.05;
            const atmCalls = calls.filter(c => Math.abs(c.strike - spot) < window && c.impliedVolatility > 0);
            const atmPuts = puts.filter(p => Math.abs(p.strike - spot) < window && p.impliedVolatility > 0);
            if (atmCalls.length >= 2 && atmPuts.length >= 2) {
                const callIV = atmCalls.reduce((s, c) => s + c.impliedVolatility, 0) / atmCalls.length;
                const putIV = atmPuts.reduce((s, p) => s + p.impliedVolatility, 0) / atmPuts.length;
                if (callIV > 0) skew = putIV / callIV;
            }
        }

        const data = { pcr, skew, callVol, putVol, source: 'yahoo' };
        cache.set(key, { data, ts: Date.now() });
        return data;
    } catch (_) {
        return null;
    }
}

/**
 * Returns { adjust, reasons } given signal + options data.
 * Total effect capped at +/-4.
 */
export function optionsAdjustment(signal, options) {
    if (!options || (signal !== 'BUY' && signal !== 'SELL')) return { adjust: 0, reasons: [] };
    const reasons = [];
    let adjust = 0;

    const pcr = options.pcr;
    if (Number.isFinite(pcr)) {
        if (signal === 'BUY' && pcr > 1.5) {
            adjust += 3; reasons.push(`PCR ${pcr.toFixed(2)} — puts crowded, contrarian for BUY`);
        } else if (signal === 'BUY' && pcr < 0.6) {
            adjust -= 2; reasons.push(`PCR ${pcr.toFixed(2)} — calls already crowded, less BUY room`);
        } else if (signal === 'SELL' && pcr < 0.6) {
            adjust += 3; reasons.push(`PCR ${pcr.toFixed(2)} — calls crowded, contrarian for SELL`);
        } else if (signal === 'SELL' && pcr > 1.5) {
            adjust -= 2; reasons.push(`PCR ${pcr.toFixed(2)} — puts already crowded, less SELL room`);
        }
    }

    const skew = options.skew;
    if (Number.isFinite(skew)) {
        if (signal === 'BUY' && skew > 1.10) {
            adjust += 2; reasons.push(`IV skew ${skew.toFixed(2)} — downside hedging bid, BUY supported`);
        } else if (signal === 'SELL' && skew < 0.90) {
            adjust += 2; reasons.push(`IV skew ${skew.toFixed(2)} — upside calls bid, contrarian SELL`);
        }
    }

    if (adjust > 4) adjust = 4;
    if (adjust < -4) adjust = -4;
    return { adjust, reasons };
}

// Score how UNUSUAL a symbol's options positioning is, for the options
// activity scanner. Independent of any engine signal — this is "is the
// options market doing something notable here?", not "does this agree
// with our BUY". Returns { score, flags } or null when options are too
// illiquid to read. Higher score = more anomalous positioning.
//
// Flags carry a directional `bias` so the UI can tint them: heavy puts
// (high PCR) lean bearish positioning; heavy calls (low PCR) lean
// bullish; elevated put-skew = hedging/fear; call-skew = euphoria.
export function unusualOptionsScore(options) {
    if (!options) return null;
    const { pcr, skew, callVol, putVol } = options;
    const totalVol = (callVol || 0) + (putVol || 0);
    // Require a floor of total volume so we don't flag a thinly-traded
    // chain where a single large order skews the ratio.
    if (!Number.isFinite(totalVol) || totalVol < 500) return null;

    const flags = [];
    let score = 0;

    if (Number.isFinite(pcr)) {
        if (pcr >= 2.0) { score += 3; flags.push({ label: `PCR ${pcr.toFixed(2)} — puts heavily crowded`, bias: 'bearish' }); }
        else if (pcr >= 1.5) { score += 2; flags.push({ label: `PCR ${pcr.toFixed(2)} — elevated put activity`, bias: 'bearish' }); }
        else if (pcr <= 0.35) { score += 3; flags.push({ label: `PCR ${pcr.toFixed(2)} — calls heavily crowded`, bias: 'bullish' }); }
        else if (pcr <= 0.6) { score += 2; flags.push({ label: `PCR ${pcr.toFixed(2)} — elevated call activity`, bias: 'bullish' }); }
    }
    if (Number.isFinite(skew)) {
        if (skew >= 1.20) { score += 2; flags.push({ label: `IV skew ${skew.toFixed(2)} — downside heavily bid (fear)`, bias: 'bearish' }); }
        else if (skew >= 1.10) { score += 1; flags.push({ label: `IV skew ${skew.toFixed(2)} — downside hedging bid`, bias: 'bearish' }); }
        else if (skew <= 0.85) { score += 2; flags.push({ label: `IV skew ${skew.toFixed(2)} — upside calls bid (euphoria)`, bias: 'bullish' }); }
        else if (skew <= 0.90) { score += 1; flags.push({ label: `IV skew ${skew.toFixed(2)} — upside calls bid`, bias: 'bullish' }); }
    }
    if (!flags.length) return null;  // nothing unusual
    return { score, flags, pcr, skew, totalVol };
}
