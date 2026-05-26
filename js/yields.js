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

async function fetchYield10Y() {
    if (cache && Date.now() - cache.ts < TTL_MS) return cache.value;
    try {
        // ^TNX = 10Y Treasury yield index (price IS the yield × 100, e.g.
        // 4.25% → 42.5). We want raw bps deltas so absolute level scaling
        // doesn't matter — just the change.
        const url = 'https://query2.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1mo&interval=1d';
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
        if (closes.length < 6) return null;
        const cur = closes[closes.length - 1];
        const back5 = closes[closes.length - 6];
        // ^TNX is yield × 10 (e.g. 42.5 = 4.25%). Convert to actual
        // percentage-point delta over the last 5 sessions.
        const ppDelta5d = (cur - back5) / 10;
        cache = { ts: Date.now(), value: { current: cur / 10, ppDelta5d } };
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
