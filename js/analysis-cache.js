// Analysis cache + prewarm coordinator.
//
// Two responsibilities:
//   1. Cache full-analysis results keyed by {symbol, timeframe} with a
//      TTL. Fresh cache hits return instantly; stale ones are
//      re-fetched.
//   2. On app boot, prewarm the user's watchlist so clicking any of
//      them is an instant render — chart + signal show without the
//      ~2-4s pipeline wait.
//
// Cache TTL — 2 minutes. Roshan picked 2 min as the freshness floor
// on top of Stooq's intraday delay; any cached entry younger than
// that is treated as live. After 2 min, the next click triggers a
// full pipeline re-run AND we render the stale cached result
// immediately (so the chart appears instantly) then update with
// fresh data when it lands.

import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe } from './data.js';
import { computeFullConfidence } from './confidence.js';
import { getWatchlistSymbols } from './ui/watchlist.js';

const TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // key → { ts, data, signal }

function keyOf(symbol, timeframe = 'today', mode = 'stock') {
    return `${mode}:${String(symbol).toUpperCase()}:${timeframe}`;
}

/**
 * Returns the cache entry for the symbol if present, regardless of
 * freshness. Caller decides whether to use it (stale-while-revalidate
 * pattern). Always returns { ts, data, signal, fresh: bool } or null.
 */
export function peek(symbol, timeframe = 'today', mode = 'stock') {
    const entry = cache.get(keyOf(symbol, timeframe, mode));
    if (!entry) return null;
    return {
        ...entry,
        fresh: Date.now() - entry.ts < TTL_MS,
    };
}

/**
 * Run the full analysis pipeline and store the result. Returns the
 * { multiData, signal } pair. Throws if analysis fails — caller
 * decides whether to display the previous cached entry.
 */
export async function analyzeAndCache(symbol, timeframe = 'today', mode = 'stock', symbolOrCoinId = null) {
    const lookupId = symbolOrCoinId || symbol;
    const multiData = mode === 'crypto'
        ? await fetchCryptoMultiTimeframe(lookupId)
        : await fetchStockMultiTimeframe(symbol);
    // bulkScan=true skips the heavy single-symbol enrichments
    // (cross-asset, options, derivs, peer-confirm, social, options-iv)
    // that aren't needed for prewarm — we want the technical signal
    // available fast. The on-click path runs the full pipeline so
    // these enrichments still appear when the user actually views
    // the symbol.
    const signal = await computeFullConfidence(multiData, mode, lookupId, timeframe, { bulkScan: true });
    const entry = { ts: Date.now(), data: multiData, signal };
    cache.set(keyOf(symbol, timeframe, mode), entry);
    return entry;
}

/**
 * Force-refresh the cache for a symbol — used when the user clicks
 * a symbol whose entry is stale. Returns the fresh entry, or
 * propagates the error.
 */
export async function refresh(symbol, timeframe = 'today', mode = 'stock', symbolOrCoinId = null) {
    return analyzeAndCache(symbol, timeframe, mode, symbolOrCoinId);
}

// ── Prewarm path ─────────────────────────────────────────────────────

/**
 * Boot-time prewarm of the user's watchlist. Fires after a small
 * delay so the main page render doesn't fight for the network. Each
 * symbol is analyzed sequentially with a small gap between them so
 * we don't saturate the data sources or block the UI thread.
 *
 * Silent on failure — a watchlist symbol that 404s on Yahoo today
 * just doesn't get a cache entry; the user will see the normal
 * pipeline run when they click it.
 */
export async function prewarmWatchlist({ delayMs = 1500, gapMs = 800 } = {}) {
    await new Promise(r => setTimeout(r, delayMs));
    const symbols = getWatchlistSymbols();
    if (!symbols.length) return { warmed: 0, failed: 0 };
    let warmed = 0, failed = 0;
    for (const sym of symbols) {
        try {
            await analyzeAndCache(sym, 'today', 'stock');
            warmed++;
        } catch (_) {
            failed++;
        }
        if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
    }
    console.log(`[prewarm] watchlist: ${warmed} warmed, ${failed} failed`);
    return { warmed, failed };
}

/**
 * Store a freshly-computed analysis into the cache. Used by core.js
 * after the on-click full pipeline completes, so the next click on
 * the same symbol within 2 min hits the cache for instant render.
 */
export function _storeFresh(symbol, timeframe, mode, data, signal) {
    cache.set(keyOf(symbol, timeframe, mode), { ts: Date.now(), data, signal });
}

/** Inspect for debug-panel diagnostics. */
export function getCacheStates() {
    const out = {};
    const now = Date.now();
    for (const [key, entry] of cache) {
        out[key] = { ageMs: now - entry.ts, fresh: now - entry.ts < TTL_MS };
    }
    return out;
}

if (typeof window !== 'undefined') {
    window.__analysisCacheStates = getCacheStates;
}
