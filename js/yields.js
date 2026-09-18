// 10-year Treasury yield context.
//
// Why this lives here: rates have a known asymmetric effect on equities.
// When 10Y yield rises sharply, the discount rate on future cashflows
// goes up — long-duration / growth names take it on the chin first.
// Tech (XLK), Communication Services growth (XLC), Real Estate (XLRE),
// Utilities (XLU) are the classic rate-sensitive sectors. Defensives
// like staples (XLP), energy (XLE), and financials (XLF — banks
// actually benefit from rising rates via NIM) are less affected or
// helped.
//
// We do NOT retrain the model. Instead we apply a small confidence
// adjustment AFTER the technical/AI/sentiment/market score is blended:
//   - rate-sensitive sector + 10Y up >0.15pts/5d + BUY → -3 (headwind)
//   - rate-sensitive sector + 10Y up >0.15pts/5d + SELL → +2 (tailwind)
//   - rate-sensitive sector + 10Y down >0.15pts/5d + BUY → +2 (tailwind)
//   - rate-sensitive sector + 10Y down >0.15pts/5d + SELL → -2 (headwind)
//   - bank / financials + 10Y up >0.15pts/5d + BUY → +2 (margin tailwind)
//   - everyone else → 0
//
// All adjustments bounded ±3pts. Same shape as cross-asset.js so we
// can compose cleanly.

import { fetchWithProxy } from './data.js';
import { symbolSector } from './sectors.js';

let cache = null;
const TTL_MS = 10 * 60 * 1000;

// Is this value a believable US 10-year Treasury yield, in percent?
//
// The band is deliberately wide: 0.3% brackets the 2020 lows and 20% is far above anything since
// 1981, so it accepts any real market while rejecting BOTH failure modes of a units change -- a
// value 10x too small (0.5 for a 5% yield) and 10x too large (49.98). A guard that only caught one
// direction would have let this exact bug through.
function plausible10Y(v) {
    return Number.isFinite(v) && v >= 0.3 && v <= 20;
}

async function fetchYield10Y() {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.value;
    try {
        // ^TNX = the 10Y Treasury yield index, quoted DIRECTLY IN PERCENT (4.998 = 4.998%).
        //
        // This comment used to say "price IS the yield x 100, e.g. 4.25% -> 42.5" and the code below
        // divided accordingly. Both were wrong as of 2026, and the stale comment is what kept the
        // bug alive: it read as documentation of a deliberate choice rather than an assumption worth
        // rechecking. Verified against the live feed, and there is now a range guard so a units
        // change fails loudly instead of scaling silently.
        // Raw '^TNX' — fetchWithProxy encodes the URL once at the proxy
        // layer. Pre-encoding to %5ETNX would get encoded again to
        // %255ETNX (Yahoo 404). Same bug we fixed in regime.js + market.js.
        const url = 'https://query2.finance.yahoo.com/v8/finance/chart/^TNX?range=1mo&interval=1d';
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
        if (closes.length < 6) return null;
        const cur = closes[closes.length - 1];
        const back5 = closes[closes.length - 6];
        // ^TNX IS ALREADY IN PERCENT. Do not divide.
        //
        // This used to divide by 10, on the documented belief that "^TNX is yield x 10 (e.g. 42.5 =
        // 4.25%)". That was true once -- Yahoo quoted the index that way for years -- and it is not
        // true now. Measured 2026-09-18, the raw closes are [4.961, 4.996, 5.006, 4.947, 4.998]
        // against a real 10-year Treasury yield of about 5%.
        //
        // The consequence was not a cosmetic display error. RISING_PP/FALLING_PP are +/-0.15pp, so
        // shrinking every delta tenfold meant the 10Y would have had to move 1.5 percentage points
        // in five sessions to register as "rising" -- roughly never. This entire source has been
        // silently contributing adjust: 0 for every symbol, while the method string advertised
        // "yields" as one of the blended inputs.
        //
        // Same shape as the ledger shard that stopped existing: upstream changed its format and the
        // code kept applying a conversion that had quietly become wrong. Hence the range guard
        // below, which fails loudly instead of scaling silently.
        if (!plausible10Y(cur) || !plausible10Y(back5)) {
            console.warn(`[yields] ^TNX out of plausible range (cur ${cur}, back5 ${back5}); `
                + 'Yahoo may have changed the units again. Abstaining rather than guessing a scale.');
            return null;
        }
        const ppDelta5d = cur - back5;
        cache = { ts: Date.now(), value: { current: cur, ppDelta5d } };
        return cache.value;
    } catch (_) { return null; }
}

// Sectors classified by rate sensitivity. Negative = hurt by rising rates.
// Positive = helped (banks via NIM). 0 = roughly neutral.
//
// Kept threshold/principle-based, not a long enumerated list of tickers:
// we ask sectors.js for the ETF and use the ETF→sensitivity mapping.
const SECTOR_RATE_SENSITIVITY = {
    XLK: -1,   // Tech — long-duration cashflows, hurt by rate hikes
    XLC: -1,   // Communication services growth (META, GOOGL, NFLX) — same
    XLRE: -1,  // Real estate — financing-sensitive, classic rate beta
    XLU: -1,   // Utilities — bond proxies; lose to actual bonds when yields rise
    XLY: -0.5, // Consumer discretionary — softer hit but durables get squeezed
    XLF: +1,   // Financials — banks earn more on rising short rates (NIM)
    XLE: 0,
    XLV: 0,
    XLP: 0,
    XLI: 0,
    XLB: 0,
};

const RISING_PP = 0.15;   // 5-day rise threshold (~15bps)
const FALLING_PP = -0.15; // mirror

export async function getYieldAdjustment(symbol, signal) {
    if (!symbol || !signal || (signal !== 'BUY' && signal !== 'SELL')) {
        return { adjust: 0, reason: null, available: false };
    }
    const yld = await fetchYield10Y();
    if (!yld) return { adjust: 0, reason: null, available: false };
    // symbolSector returns { etf, name } or null. Map by ETF code.
    const sector = symbolSector(symbol);
    const etf = typeof sector === 'string' ? sector : sector?.etf;
    if (!etf) return { adjust: 0, reason: null, available: false, current: yld.current, ppDelta5d: yld.ppDelta5d };

    const sensitivity = SECTOR_RATE_SENSITIVITY[etf] ?? 0;
    const delta = yld.ppDelta5d;
    const rising = delta > RISING_PP;
    const falling = delta < FALLING_PP;

    let adjust = 0;
    let reason = null;
    const trendWord = rising ? 'rising' : falling ? 'falling' : 'flat';
    const sectorLabel = sector?.name || etf;

    if (sensitivity < -0.4) {
        // Rate-sensitive sector
        if (rising && signal === 'BUY') { adjust = -3; reason = `10Y yield ${trendWord} (+${delta.toFixed(2)}pp/5d) — headwind for ${sectorLabel} long`; }
        else if (rising && signal === 'SELL') { adjust = +2; reason = `10Y yield ${trendWord} (+${delta.toFixed(2)}pp/5d) — tailwind for ${sectorLabel} short`; }
        else if (falling && signal === 'BUY') { adjust = +2; reason = `10Y yield ${trendWord} (${delta.toFixed(2)}pp/5d) — tailwind for ${sectorLabel} long`; }
        else if (falling && signal === 'SELL') { adjust = -2; reason = `10Y yield ${trendWord} (${delta.toFixed(2)}pp/5d) — headwind for ${sectorLabel} short`; }
    } else if (sensitivity > 0.4) {
        // Banks / financials — rising rates help on net interest margin
        if (rising && signal === 'BUY') { adjust = +2; reason = `10Y yield ${trendWord} (+${delta.toFixed(2)}pp/5d) — NIM tailwind for ${sectorLabel} long`; }
        else if (rising && signal === 'SELL') { adjust = -2; reason = `10Y yield ${trendWord} (+${delta.toFixed(2)}pp/5d) — NIM headwind for ${sectorLabel} short`; }
    }

    return {
        adjust,
        reason,
        available: true,
        current: yld.current,
        ppDelta5d: yld.ppDelta5d,
        sector: sectorLabel,
        sectorEtf: etf,
        sensitivity,
    };
}
