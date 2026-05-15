// Phase 2 — penny-stock tier model.
//
// Penny stocks (price < $5, low float, often microcaps) trade on a
// completely different mechanic than large-caps: dominated by short-
// squeeze dynamics, low-float spike-and-dump patterns, and concentrated
// retail order flow. The standard 4-source confidence stack
// (AI + Tech + Sentiment + Market) under-weights two factors that
// dominate at this tier:
//   1. Float / shares-outstanding (lower float = bigger pct moves on smaller volume)
//   2. Short interest (high SI = squeeze potential, also extra volatility)
//
// We pull both from free, keyless public sources and emit a confidence
// adjustment + cap that activates ONLY when liquidity tier == 'penny'.
//
// FREE DATA SOURCES (all keyless):
//   - SEC EDGAR /submissions/CIK<10digit>.json     → most recent shares-outstanding via 10-K/10-Q facts
//   - Yahoo /v10/finance/quoteSummary?...modules=defaultKeyStatistics
//                                                  → sharesShort, shortRatio, floatShares
//   - Yahoo /v8/finance/chart                       → already in app; we use it via existing data.js path
//
// We're not building exposure-grade data here. The goal: gate confidence
// down on penny names where the engine doesn't see the float/short-interest
// risk at all today.

import { fetchWithProxy } from './data.js';

const CACHE = new Map(); // symbol -> { ts, data }
const TTL_MS = 30 * 60 * 1000; // 30 min — these change daily at most

function cacheGet(sym) {
    const v = CACHE.get(sym.toUpperCase());
    if (!v) return null;
    if (Date.now() - v.ts > TTL_MS) { CACHE.delete(sym.toUpperCase()); return null; }
    return v.data;
}
function cacheSet(sym, data) { CACHE.set(sym.toUpperCase(), { ts: Date.now(), data }); }

async function fetchYahooKeyStats(symbol) {
    // /v10/finance/quoteSummary returns a rich JSON; we only want defaultKeyStatistics.
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics`;
    try {
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const stats = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics || null;
        if (!stats) return null;
        return {
            sharesShort:     numFromYahoo(stats.sharesShort),
            sharesShortPriorMonth: numFromYahoo(stats.sharesShortPriorMonth),
            shortRatio:      numFromYahoo(stats.shortRatio),
            shortPercentOfFloat: numFromYahoo(stats.shortPercentOfFloat),
            floatShares:     numFromYahoo(stats.floatShares),
            sharesOutstanding: numFromYahoo(stats.sharesOutstanding),
            heldPercentInsiders: numFromYahoo(stats.heldPercentInsiders),
            heldPercentInstitutions: numFromYahoo(stats.heldPercentInstitutions),
        };
    } catch (_) { return null; }
}

function numFromYahoo(field) {
    if (field == null) return null;
    if (typeof field === 'number') return field;
    if (typeof field === 'object' && 'raw' in field) return field.raw;
    return null;
}

/**
 * Returns the penny-tier read for a symbol, or null if data unavailable.
 * Shape: {
 *   floatShares, sharesShort, shortPercentOfFloat,
 *   floatBucket: 'micro' | 'small' | 'mid' | 'normal',
 *   shortBucket: 'extreme' | 'high' | 'normal' | 'low',
 *   squeezeRisk: 0..1,
 * }
 */
export async function getPennyTierData(symbol) {
    if (!symbol) return null;
    const cached = cacheGet(symbol);
    if (cached) return cached;

    const stats = await fetchYahooKeyStats(symbol);
    if (!stats) return null;

    const floatShares = stats.floatShares;
    const shortPct = stats.shortPercentOfFloat;

    let floatBucket = null;
    if (Number.isFinite(floatShares)) {
        if (floatShares < 5_000_000) floatBucket = 'micro';     // <5M float — squeeze territory
        else if (floatShares < 20_000_000) floatBucket = 'small';
        else if (floatShares < 100_000_000) floatBucket = 'mid';
        else floatBucket = 'normal';
    }

    let shortBucket = null;
    if (Number.isFinite(shortPct)) {
        // shortPercentOfFloat from Yahoo is a fraction (0.20 == 20%)
        if (shortPct >= 0.30) shortBucket = 'extreme';
        else if (shortPct >= 0.15) shortBucket = 'high';
        else if (shortPct >= 0.05) shortBucket = 'normal';
        else shortBucket = 'low';
    }

    // Squeeze-risk score: micro float + extreme short = highest. Bounded 0..1.
    let squeezeRisk = 0;
    if (floatBucket === 'micro') squeezeRisk += 0.45;
    else if (floatBucket === 'small') squeezeRisk += 0.25;
    else if (floatBucket === 'mid') squeezeRisk += 0.10;
    if (shortBucket === 'extreme') squeezeRisk += 0.45;
    else if (shortBucket === 'high') squeezeRisk += 0.25;
    else if (shortBucket === 'normal') squeezeRisk += 0.05;
    squeezeRisk = Math.min(1, squeezeRisk);

    const data = {
        floatShares, sharesShort: stats.sharesShort, shortPercentOfFloat: shortPct,
        sharesOutstanding: stats.sharesOutstanding,
        heldPercentInsiders: stats.heldPercentInsiders,
        heldPercentInstitutions: stats.heldPercentInstitutions,
        floatBucket, shortBucket, squeezeRisk: +squeezeRisk.toFixed(2),
    };
    cacheSet(symbol, data);
    return data;
}

/**
 * Penny-tier confidence adjustment + cap. Activates only when called.
 * Total effect bounded so it doesn't dominate the engine.
 *
 * Logic:
 *  - Micro float + BUY: -8 (low-float spikes are unreliable, often dump)
 *  - Micro float + SELL: -4 (shorts get squeezed off these names)
 *  - Extreme short + BUY: +5 (squeeze tailwind)
 *  - Extreme short + SELL: -8 (squeeze risk against short signal)
 *  - Hard cap at 60 if squeezeRisk >= 0.7 — we just don't have edge here
 */
export function pennyTierAdjustment(signal, penny, currentTier) {
    if (currentTier !== 'penny') return { adjust: 0, cap: 100, reasons: [] };
    if (!penny) return { adjust: 0, cap: 100, reasons: [] };

    const reasons = [];
    let adjust = 0;
    let cap = 100;

    if (penny.floatBucket === 'micro') {
        if (signal === 'BUY') {
            adjust -= 8;
            reasons.push(`Micro float (${formatShares(penny.floatShares)}) — low-float spikes often reverse, BUY confidence reduced`);
        } else if (signal === 'SELL') {
            adjust -= 4;
            reasons.push(`Micro float (${formatShares(penny.floatShares)}) — shorts may get squeezed, SELL confidence reduced`);
        }
    } else if (penny.floatBucket === 'small') {
        if (signal === 'BUY') {
            adjust -= 4;
            reasons.push(`Small float (${formatShares(penny.floatShares)}) — BUY confidence trimmed`);
        }
    }

    if (penny.shortBucket === 'extreme') {
        if (signal === 'BUY') {
            adjust += 5;
            reasons.push(`Short interest extreme (${(penny.shortPercentOfFloat * 100).toFixed(0)}% of float) — squeeze tailwind for BUY`);
        } else if (signal === 'SELL') {
            adjust -= 8;
            reasons.push(`Short interest extreme (${(penny.shortPercentOfFloat * 100).toFixed(0)}% of float) — squeeze risk against SELL`);
        }
    } else if (penny.shortBucket === 'high') {
        if (signal === 'BUY') {
            adjust += 2;
            reasons.push(`Short interest high (${(penny.shortPercentOfFloat * 100).toFixed(0)}% of float) — mild squeeze tailwind`);
        } else if (signal === 'SELL') {
            adjust -= 4;
            reasons.push(`Short interest high (${(penny.shortPercentOfFloat * 100).toFixed(0)}% of float) — squeeze risk reduces SELL confidence`);
        }
    }

    if (penny.squeezeRisk >= 0.7) {
        cap = 60;
        reasons.push(`High squeeze risk (${(penny.squeezeRisk * 100).toFixed(0)}/100) — confidence capped at 60`);
    }

    // Bound aggregate adjustment.
    if (adjust > 8) adjust = 8;
    if (adjust < -10) adjust = -10;

    return { adjust, cap, reasons };
}

function formatShares(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return String(n);
}
