// Phase 2 — penny-stock tier model.
//
// Penny stocks (price < $5, low float, often microcaps) trade on a
// completely different mechanic than large-caps: dominated by short-
// squeeze dynamics, low-float spike-and-dump patterns, and concentrated
// retail order flow. The standard 4-source confidence stack underweights
// two factors that dominate at this tier:
//   1. Float / shares-outstanding (lower float = bigger pct moves)
//   2. Short interest (high SI = squeeze potential + extra volatility)
//
// FREE DATA PATH (Phase 6):
//   Yahoo's /v10/finance/quoteSummary now requires a session crumb that
//   CORS proxies can't carry. We host a Cloudflare Worker (workers/yahoo-proxy/)
//   that fetches the crumb server-side and exposes a clean /key-stats endpoint.
//   Worker is LIVE; URL wired below. Per-symbol cache is in this module
//   (TTL 30 min) so we don't hammer the worker.

import { fetchWithProxy } from './data.js';

// Live Cloudflare Worker that handles Yahoo's session-crumb dance.
// Free tier: 100K req/day. Replace with your own deploy if forking.
const WORKER_URL = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

function cacheGet(sym) {
    const v = CACHE.get(sym.toUpperCase());
    if (!v) return null;
    if (Date.now() - v.ts > TTL_MS) { CACHE.delete(sym.toUpperCase()); return null; }
    return v.data;
}
function cacheSet(sym, data) { CACHE.set(sym.toUpperCase(), { ts: Date.now(), data }); }

async function fetchViaWorker(symbol) {
    if (!WORKER_URL) return null;
    try {
        // Cache-bust query so we never serve a stale CDN-cached error to the
        // user. Worker has its own in-memory 60-min cache so the upstream
        // hit-rate stays high.
        const url = `${WORKER_URL}/key-stats?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            cache: 'no-store',
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || json.error) return null;
        return json;
    } catch (_) {
        return null;
    }
}

async function fetchDirectYahoo(symbol) {
    // Best-effort fallback for if Yahoo ever relaxes the crumb wall.
    // Raw symbol — fetchWithProxy encodes once at the proxy layer.
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics`;
    try {
        const res = await fetchWithProxy(url);
        const json = await res.json();
        const stats = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
        if (!stats) return null;
        return {
            sharesShort:           num(stats.sharesShort),
            sharesShortPriorMonth: num(stats.sharesShortPriorMonth),
            shortRatio:            num(stats.shortRatio),
            shortPercentOfFloat:   num(stats.shortPercentOfFloat),
            floatShares:           num(stats.floatShares),
            sharesOutstanding:     num(stats.sharesOutstanding),
            heldPercentInsiders:   num(stats.heldPercentInsiders),
            heldPercentInstitutions: num(stats.heldPercentInstitutions),
        };
    } catch (_) { return null; }
}

function num(field) {
    if (field == null) return null;
    if (typeof field === 'number') return field;
    if (typeof field === 'object' && 'raw' in field) return field.raw;
    return null;
}

export async function getPennyTierData(symbol) {
    if (!symbol) return null;
    const cached = cacheGet(symbol);
    if (cached) return cached;

    let stats = await fetchViaWorker(symbol);
    if (!stats) stats = await fetchDirectYahoo(symbol);
    if (!stats) return null;

    const floatShares = stats.floatShares;
    const shortPct = stats.shortPercentOfFloat;

    let floatBucket = null;
    if (Number.isFinite(floatShares)) {
        if (floatShares < 5_000_000) floatBucket = 'micro';
        else if (floatShares < 20_000_000) floatBucket = 'small';
        else if (floatShares < 100_000_000) floatBucket = 'mid';
        else floatBucket = 'normal';
    }

    let shortBucket = null;
    if (Number.isFinite(shortPct)) {
        if (shortPct >= 0.30) shortBucket = 'extreme';
        else if (shortPct >= 0.15) shortBucket = 'high';
        else if (shortPct >= 0.05) shortBucket = 'normal';
        else shortBucket = 'low';
    }

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
        source: WORKER_URL ? 'worker' : 'direct',
    };
    cacheSet(symbol, data);
    return data;
}

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
