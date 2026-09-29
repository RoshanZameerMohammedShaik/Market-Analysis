// Hot Picks Scanner. Two-pass + progressive + cached.
//
// Old approach (slow): fetch full 3-month history for all 487 symbols
// sequentially → ~100 seconds.
//
// New approach:
//   Phase 1 — lightweight quote fetch for ALL 487 in batches of 50
//     via Yahoo's /v7/finance/quote multi-symbol endpoint. 5 round trips,
//     ~3-5 seconds.
//   Filter: rank by composite momentum+volume score, keep top 60.
//   Phase 2 — full multi-timeframe analysis on those 60 (batches of 12).
//   ~7-10 seconds.
//   Total: ~12-15s vs ~100s.
//
// Plus a 5-minute cache so repeat refreshes are instant.
// Plus onPartial callback so UI can render cards as they arrive.
//
// Honest trade-off: a stock with weak momentum but strong technicals
// won't survive Phase 1 filtering. Hot Picks is discovery, not exhaustive
// scan; user can search any symbol directly for the full pipeline.

import { fetchStockData, fetchWithProxy, coingeckoJson, withHistory } from './data.js';
import { getMarketConditionsScore } from './market.js';
import { UNIVERSE_CONFIG } from './markets.js';
import { computeFullConfidence } from './confidence.js';
import { getCalibrationThresholds, getCalibrationThresholdsSync } from './calibration-thresholds.js';
import { getEffectiveLock } from './ui/daily-lock.js';
import { applyLockToPrediction } from './ui/lock-view.js';

// THE CALL THE USER WILL SEE WHEN THEY OPEN THE SYMBOL.
//
// The signal card shows the session's LOCKED call (the cron's, or the one this browser first saw)
// while Hot Picks used to show the live engine output, so a card could read "BUY 50%" and open to
// "DON'T BUY 48%". Both now go through applyLockToPrediction. Read-only here: every scanned
// symbol is checked, but only the picks actually shown get a local lock (see lockShownPicks).
async function effectiveView(lockKey, result, timeframe) {
    if (timeframe !== 'today' || !lockKey || !result) return { view: result, locked: false };
    try {
        const lock = await getEffectiveLock(lockKey, result, { create: false });
        return lock ? { view: applyLockToPrediction(result, lock), locked: true } : { view: result, locked: false };
    } catch (_) { return { view: result, locked: false }; }
}

function pickFields(view) {
    const pt = view?.priceTargets || {};
    return {
        signal: view.signal,
        confidence: view.confidence,
        expectedHigh: pt.predictedHigh ?? null,
        expectedLow: pt.predictedLow ?? null,
        expectedPct: pt.highPercent ?? null,
        expectedLowPct: pt.lowPercent ?? null,
        reasons: view.reasons,
    };
}

// Lock the picks on screen that have no lock yet, so opening one shows the same call the card
// showed. Only these few: locking all ~70 scanned symbols would stamp calls the user never saw.
async function lockShownPicks(picks, timeframe) {
    if (timeframe !== 'today') {
        for (const p of picks) delete p._live;
        return;
    }
    for (const p of picks) {
        if (!p._locked && p._live && p._lockKey) {
            try {
                const lock = await getEffectiveLock(p._lockKey, p._live);
                // Re-read the pick from the lock just taken. A new lock is anchored on the SESSION
                // OPEN, not on the live price the scan saw, so on a symbol that has moved since
                // the open the range differs: MOD showed $165-$186 here and $184-$207 on its card.
                if (lock) Object.assign(p, pickFields(applyLockToPrediction(p._live, lock)), { _locked: true });
            } catch (_) { /* card will lock on open */ }
        }
        delete p._live;
    }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const stockCache = new Map(); // key -> { ts, picks }

// Exported so the manual ↻ Refresh button (in ui/core.js) can force a
// fresh scan instead of returning the 5-minute cached result. Without
// this, clicking Refresh within 5 min of the previous scan silently
// re-rendered the same cards — meaning users couldn't see new penny
// finalists right after a code update that expanded the universe.
export function clearHotPicksCache() {
    stockCache.clear();
    cryptoCache.clear();
}
const cryptoCache = new Map();

function cacheGet(map, key) {
    const v = map.get(key);
    if (!v) return null;
    if (Date.now() - v.ts > CACHE_TTL_MS) { map.delete(key); return null; }
    return v.picks;
}
function cacheSet(map, key, picks) {
    map.set(key, { ts: Date.now(), picks });
}

export async function scanStockHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null, onPartial = null) {
    const isTomorrow = timeframe === 'tomorrow';
    const cacheKey = `${timeframe}`;
    const cached = cacheGet(stockCache, cacheKey);
    if (cached) {
        if (onProgress) onProgress('Loaded recent picks from cache.');
        if (onPartial) onPartial(cached);
        return cached;
    }

    if (onProgress) onProgress('Scanning global markets for movers…');

    let symbols = [];
    const symbolMeta = {};

    // Stream 1: Yahoo predefined US screeners (live US movers).
    if (UNIVERSE_CONFIG.useUSScreeners) {
        const screeners = isTomorrow
            ? ['most_actives', 'undervalued_growth_stocks', 'aggressive_small_caps', 'growth_technology_stocks']
            : ['day_gainers', 'most_actives', 'day_losers', 'undervalued_growth_stocks', 'aggressive_small_caps'];

        const screenerResults = await Promise.allSettled(screeners.map(s => fetchYahooScreener(s)));
        const trendingResult = await fetchYahooTrending().catch(() => []);

        const symbolSet = new Set();
        screenerResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                result.value.forEach(stock => {
                    if (!symbolSet.has(stock.symbol)) { symbolSet.add(stock.symbol); symbolMeta[stock.symbol] = stock; }
                });
            }
        });
        trendingResult.forEach(s => {
            if (!symbolSet.has(s.symbol)) { symbolSet.add(s.symbol); symbolMeta[s.symbol] = s; }
        });
        symbols = [...symbolSet];
    }

    // Stream 2: global liquid pool.
    for (const sym of UNIVERSE_CONFIG.globalPool) {
        if (!symbolMeta[sym]) symbolMeta[sym] = { symbol: sym };
        if (!symbols.includes(sym)) symbols.push(sym);
    }

    // Stream 3: penny pool. Tracked separately because the Phase 1
    // ranking weight log10(volume) under-represents low-float pennies
    // even when they're moving. Pennies get their own ranking pass
    // (below) and a guaranteed slot allocation in the Phase 2 set.
    // Hybrid sourcing per Roshan's spec:
    //   (a) STABLE — js/penny-universe.js, ~500 hand-curated symbols.
    //   (b) DYNAMIC — Yahoo screeners (aggressive_small_caps,
    //       day_gainers, day_losers, most_actives) filtered to <$5
    //       at scan time, so live movers that aren't on the curated
    //       list still surface today and get recorded in the ledger.
    const stablePennyPool = UNIVERSE_CONFIG.pennyPool || [];
    for (const sym of stablePennyPool) {
        if (!symbolMeta[sym]) symbolMeta[sym] = { symbol: sym };
        if (!symbols.includes(sym)) symbols.push(sym);
    }
    // Dynamic — same Yahoo screeners as Stream 1, but we keep them
    // SEPARATE here so we can apply the <$5 filter and tag the
    // results as pennies (so Phase 1 routes them through the
    // momentum-dominant ranking, not the volume-heavy liquid one).
    const dynamicPennyScreeners = ['aggressive_small_caps', 'day_gainers', 'day_losers', 'most_actives'];
    const dynamicPennyResults = await Promise.allSettled(dynamicPennyScreeners.map(s => fetchYahooScreener(s)));
    const dynamicPennyAdded = new Set();
    for (const r of dynamicPennyResults) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        for (const q of r.value) {
            if (!q.symbol) continue;
            if (typeof q.price !== 'number' || q.price >= 5) continue;  // <$5 only
            if (!symbolMeta[q.symbol]) symbolMeta[q.symbol] = q;
            else symbolMeta[q.symbol] = { ...symbolMeta[q.symbol], ...q };
            if (!symbols.includes(q.symbol)) symbols.push(q.symbol);
            dynamicPennyAdded.add(q.symbol);
        }
    }
    // Effective penny set for Phase 1 ranking + tagging.
    const allPennies = new Set([...stablePennyPool, ...dynamicPennyAdded]);

    if (onProgress) onProgress(`Found ${symbols.length} candidates. Pre-filtering by momentum + volume…`);

    // Phase 1: pull lightweight quote data for all symbols at once.
    // Symbols already in symbolMeta with fresh changePct/volume from
    // screeners can skip the lookup.
    const needLookup = symbols.filter(s => {
        const m = symbolMeta[s];
        return !m || m.changePercent === undefined || m.regularMarketVolume === undefined;
    });
    if (needLookup.length) {
        const quotes = await yahooBatchQuotes(needLookup, msg => onProgress?.(msg));
        for (const q of quotes) {
            symbolMeta[q.symbol] = { ...(symbolMeta[q.symbol] || {}), ...q };
        }
    }

    // Phase 1 ranking — split into two streams so pennies get a fair
    // shot at Phase 2 slots. Liquid stream uses the original
    // momentum + log10(volume) score (large-caps need volume to be
    // credible). Penny stream uses a momentum-only score with a small
    // float-bonus so a 30%-mover with 500K shares isn't ranked behind
    // a 1%-mover with 50M shares.
    const liquidScored = [];
    const pennyScored = [];
    for (const sym of symbols) {
        const m = symbolMeta[sym] || {};
        const change = Math.abs(m.changePercent || 0);
        const vol = m.volume || m.regularMarketVolume || 0;
        if (allPennies.has(sym)) {
            // Penny score: raw |change| dominates; volume bonus is
            // capped (log10 already plateaus, but we squash it more)
            // so penny moves of 10-30% don't get out-ranked by
            // boring large-cap moves of 1-2% on huge volume.
            const volBonus = vol > 0 ? Math.min(2, Math.log10(vol + 1) / 4) : 0;
            const score = change * 1.4 + volBonus;
            if (score > 0) pennyScored.push({ sym, score });
        } else {
            const volScore = vol > 0 ? Math.log10(vol + 1) : 0;
            const score = change * 1.0 + volScore * 1.5;
            if (score > 0) liquidScored.push({ sym, score });
        }
    }
    liquidScored.sort((a, b) => b.score - a.score);
    pennyScored.sort((a, b) => b.score - a.score);
    // Phase 2 budget: 45 liquid + 25 penny = 70 finalists.
    const LIQUID_TOP = 45;
    const PENNY_TOP = 25;
    const filteredSymbols = [
        ...liquidScored.slice(0, LIQUID_TOP).map(s => s.sym),
        ...pennyScored.slice(0, PENNY_TOP).map(s => s.sym),
    ];

    if (onProgress) onProgress(`Filtered to top ${filteredSymbols.length}. Fetching market conditions…`);
    const marketScore = await getMarketConditionsScore('stock').catch(() => ({ score: 50 }));
    // Hot Picks floor learned from the live ledger. Awaited once per
    // scan so the cache is warm; rankPicks then reads it without
    // re-fetching per partial render.
    const calThresh = await getCalibrationThresholds();
    const hotFloor = calThresh.hotPicksFloor;

    if (onProgress) onProgress(`Running ${isTomorrow ? 'predictive' : 'real-time'} analysis on ${filteredSymbols.length} stocks…`);

    // Phase 2: FULL engine analysis on filtered set. Every Phase 1
    // finalist runs through computeFullConfidence — same code path as
    // a user click — so Hot Picks cards reflect the real engine
    // (LSTM + sentiment + market + macro/sector/yield/calendar/
    // ledger-track-record + 20+ enrichment layers), not just a
    // technicals-only preview.
    //
    // Cost: scan goes from ~12s to ~25-30s. Acceptable because
    // (a) the user only does this on demand, (b) the cache layer
    // means subsequent clicks on those symbols are instant, (c) the
    // cards now actually mean what their confidence number says.
    // Smaller batchSize (6) so the per-batch wait is short.
    const results = [];
    const batchSize = 6;
    for (let i = 0; i < filteredSymbols.length; i += batchSize) {
        const batch = filteredSymbols.slice(i, i + batchSize);
        const analyzed = i + batch.length;
        if (onProgress) onProgress(`${isTomorrow ? 'Predicting' : 'Analyzing'} (${analyzed}/${filteredSymbols.length})…`);

        const batchResults = await Promise.allSettled(
            batch.map(async (symbol) => {
                try {
                    // A year, split so the engine sees its usual 3 months and the trend gate
                    // sees the 200-day history (see withHistory in data.js).
                    const data = withHistory(await fetchStockData(symbol, '1y', '1d', { suffixProbe: false }));
                    if (!data.candles || data.candles.length < 30) return null;
                    const multiData = deriveMultiTimeframe(data);
                    // Full pipeline — same call as the user-click path
                    // in core.js. bulkScan=false so the LSTM, per-symbol
                    // ledger track record, and all enrichments fire.
                    const result = await computeFullConfidence(multiData, 'stock', symbol, timeframe, { bulkScan: false, newsLite: true });
                    const meta = symbolMeta[symbol] || {};
                    const sparkline = data.candles.slice(-30).map(c => c.close);
                    const lockKey = data.symbol || symbol;
                    const { view, locked } = await effectiveView(lockKey, result, timeframe);
                    return {
                        symbol: data.symbol,
                        name: data.name || meta.name || symbol,
                        price: data.currentPrice || meta.price,
                        ...pickFields(view),
                        currency: data.currency || 'USD',
                        change: meta.changePercent || (data.currentPrice && data.previousClose
                            ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                            : 0),
                        _sparkline: sparkline,
                        _lockKey: lockKey, _locked: locked, _live: result,
                    };
                } catch (e) {
                    return null;
                }
            })
        );
        batchResults.forEach(r => {
            if (r.status === 'fulfilled' && r.value) results.push(r.value);
        });
        if (onPartial) onPartial(rankPicks(results, maxPicks, hotFloor));
        if (i + batchSize < filteredSymbols.length) await new Promise(r => setTimeout(r, 100));
    }

    const finalPicks = rankPicks(results, maxPicks, hotFloor);
    await lockShownPicks(finalPicks, timeframe);
    cacheSet(stockCache, cacheKey, finalPicks);
    return finalPicks;
}

// Hot Picks floor = LEARNED hotPicksFloor from
// calibration-thresholds.js. That value is "the lowest confidence
// at which empirical hit rate from the live ledger is at least
// 55%". So "55% on a card" actually means "engine has been right
// 55%+ on similar setups" — not a hardcoded UI cutoff. NEUTRAL
// and NO_TRADE excluded entirely.
//
// Sync getter exposed so the empty-state UI message can show the
// current floor without duplicating the constant.
export function getHotPicksFloor() {
    return getCalibrationThresholdsSync().hotPicksFloor;
}

// Hot Picks = the engine's BUY opportunities only (Roshan's call: "I need only
// the ones with strong Buy there"), ranked strongest-first.
//   1. keep only BUY (drop SELL / NEUTRAL / NO_TRADE),
//   2. rank by calibrated confidence, take the top maxPicks — so the STRONGEST
//      available buys surface even though this engine's calibrated BUY
//      confidences currently sit low (near coin-flip). We intentionally do NOT
//      gate on the learned 55% hotPicksFloor here: on the current confidence
//      scale almost nothing clears 55%, so that gate left Hot Picks
//      permanently empty (the opposite of what the user wants). "Strong" =
//      top-ranked, and every card shows its real confidence % so nothing is
//      dressed up — a 27% card reads as 27%.
//
// Plus one floor that is not a tuning knob: calibrated confidence of at least 50%. The calibrated
// number is the live hit rate of calls like this one, so a BUY at 46% is, by the engine's own
// record, more often wrong than right. It used to be shown anyway with a "low track record"
// badge, which left the reader to reconcile "BUY" with "worse than a coin flip". The detail card
// still shows it (with its hedge) for anyone who opens the symbol.
function rankPicks(results, maxPicks, _floor) {
    return results
        .filter(r => r.signal === 'BUY' && Number.isFinite(r.confidence) && r.confidence >= 50)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxPicks);
}

/**
 * Yahoo's /v7/finance/quote takes up to ~50 symbols at once and returns
 * lightweight quote rows. We chunk if needed.
 */
async function yahooBatchQuotes(symbols, onProgress) {
    const out = [];
    const CHUNK = 50;
    for (let i = 0; i < symbols.length; i += CHUNK) {
        const chunk = symbols.slice(i, i + CHUNK);
        if (onProgress) onProgress(`Quote pre-fetch — ${i + chunk.length}/${symbols.length}…`);
        // Raw symbols — fetchWithProxy encodes the whole URL once at the
        // proxy layer. Pre-encoding each symbol then joining with comma
        // is the same shape since encodeURIComponent of ASCII tickers is
        // idempotent, but it would double-encode any future symbol with
        // ^ / : / non-ASCII chars. Keep the join with raw commas.
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.join(',')}`;
        try {
            const res = await fetchWithProxy(url);
            const json = await res.json();
            const rows = json?.quoteResponse?.result || [];
            for (const r of rows) {
                if (!r.symbol) continue;
                out.push({
                    symbol: r.symbol,
                    name: r.shortName || r.longName || r.symbol,
                    price: r.regularMarketPrice,
                    changePercent: r.regularMarketChangePercent || 0,
                    volume: r.regularMarketVolume || 0,
                    marketCap: r.marketCap || 0,
                });
            }
        } catch (_) {
            // Soft fail — those symbols just won't get pre-filter scores;
            // they'll fall to the bottom of the ranking.
        }
    }
    return out;
}

async function fetchYahooScreener(screener) {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${screener}&count=50`;
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const quotes = json?.finance?.result?.[0]?.quotes || [];
    return quotes
        .filter(q => {
            if (!q.regularMarketPrice || !q.symbol) return false;
            if (q.symbol.includes('.') || q.symbol.includes('=') || q.symbol.includes('-USD')) return false;
            const t = q.quoteType;
            return t === 'EQUITY' || t === 'ETF';
        })
        .map(q => ({
            symbol: q.symbol,
            name: q.shortName || q.longName || q.symbol,
            price: q.regularMarketPrice,
            changePercent: q.regularMarketChangePercent || 0,
            volume: q.regularMarketVolume || 0,
            marketCap: q.marketCap || 0,
            quoteType: q.quoteType,
        }));
}

async function fetchYahooTrending() {
    const url = 'https://query2.finance.yahoo.com/v1/finance/trending/US?count=50';
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const quotes = json?.finance?.result?.[0]?.quotes || [];
    return quotes
        .filter(q => q.symbol && !q.symbol.includes('-USD') && !q.symbol.includes('=') && !q.symbol.includes('.'))
        .map(q => ({ symbol: q.symbol, name: q.symbol }));
}

export async function scanCryptoHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null, onPartial = null) {
    const isTomorrow = timeframe === 'tomorrow';
    const cacheKey = `${timeframe}`;
    const cached = cacheGet(cryptoCache, cacheKey);
    if (cached) {
        if (onProgress) onProgress('Loaded recent picks from cache.');
        if (onPartial) onPartial(cached);
        return cached;
    }

    if (onProgress) onProgress('Scanning all crypto sources — market cap, trending, gainers...');

    const [marketPage1, marketPage2, trendingCoins] = await Promise.allSettled([
        fetchCryptoMarket(1),
        fetchCryptoMarket(2),
        fetchCryptoTrending(),
    ]);

    const coinMap = new Map();
    [marketPage1, marketPage2].forEach(result => {
        if (result.status === 'fulfilled' && result.value) result.value.forEach(coin => coinMap.set(coin.id, coin));
    });
    if (trendingCoins.status === 'fulfilled' && trendingCoins.value) {
        trendingCoins.value.forEach(coin => { if (!coinMap.has(coin.id)) coinMap.set(coin.id, coin); });
    }

    const STABLECOINS = ['usdt','usdc','dai','busd','tusd','usdp','usdd','frax','lusd','gusd','usd1','usde','fdusd','pyusd','eusd'];
    const coins = [...coinMap.values()].filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()) && !coin.name.toLowerCase().includes('usd'));
    if (coins.length === 0) return [];

    if (onProgress) onProgress(`Found ${coins.length} coins. Fetching market conditions...`);
    const marketScore = await getMarketConditionsScore('crypto').catch(() => ({ score: 50 }));
    const calThreshC = await getCalibrationThresholds();
    const cryptoFloor = calThreshC.hotPicksFloor;
    if (onProgress) onProgress(`Running ${isTomorrow ? 'predictive' : 'real-time'} analysis on ${coins.length} cryptocurrencies...`);

    const results = [];
    let analyzed = 0;
    // REAL DAILY BARS, one proxied Yahoo call per coin, in parallel batches like the stock scan.
    //
    // The scan used to rebuild "candles" from CoinGecko's 7-day hourly sparkline: 4-hour bars that
    // the engine read as DAILY ones. Every indicator ran on the wrong clock and the band came out
    // about a quarter of its true width (BTC day-7: 1.85% wide against 8.7% on daily bars), so a
    // pick's "Range High (80%)" was a number the price would blow through most days. Yahoo reuses
    // crypto tickers (TON-USD is "TON Token"), so a coin is kept only when Yahoo's last price
    // agrees with CoinGecko's for that coin; otherwise it is dropped rather than analysed as
    // something else.
    const dailyBars = new Map();
    const BATCH = 6;
    for (let i = 0; i < coins.length; i += BATCH) {
        const batch = coins.slice(i, i + BATCH);
        if (onProgress) onProgress(`Fetching daily bars (${Math.min(i + BATCH, coins.length)}/${coins.length})…`);
        await Promise.all(batch.map(async (coin) => {
            try {
                const d = withHistory(await fetchStockData(`${coin.symbol.toUpperCase()}-USD`, '1y', '1d', { suffixProbe: false }));
                const px = d?.currentPrice;
                if (d?.candles?.length >= 30 && px > 0 && coin.price > 0 && Math.abs(px / coin.price - 1) < 0.05) {
                    dailyBars.set(coin.id, d);
                }
            } catch (_) { /* dropped: no trustworthy bars */ }
        }));
    }
    for (const coin of coins) {
        analyzed++;
        if (onProgress) onProgress(`${isTomorrow ? 'Predicting' : 'Analyzing'} ${coin.name} (${coin.symbol.toUpperCase()})... (${analyzed}/${coins.length})`);
        try {
            let candles;
            let sparklineData = null;
            const bars = dailyBars.get(coin.id);
            if (bars) {
                candles = bars.candles;
                sparklineData = coin.sparkline && coin.sparkline.length >= 20 ? coin.sparkline : candles.slice(-30).map(c => c.close);
            } else {
                // No daily bars we can trust for this coin (Yahoo has no listing, or its price is a
                // different coin's). Dropped, and NOT fetched from CoinGecko: its free tier serves
                // about five calls a minute, answers the rest with a 429 the browser cannot read
                // (no CORS header on the error), and a single burst starves every other coin.
                continue;
            }
            if (!candles || candles.length < 30) continue;
            const sym = coin.symbol.toUpperCase();
            const px = bars.currentPrice || coin.price;
            const prev = candles.length > 1 ? candles[candles.length - 2].close : null;
            const tf = (c) => ({ symbol: sym, name: coin.name, currency: 'USD', exchange: 'Crypto', currentPrice: px, previousClose: prev, candles: c });
            const multiData = {
                daily: { ...tf(candles), history: bars.history || candles },
                // Crypto trades every day, so a week is 7 bars.
                weekly: tf(aggregateCandlesPeriod(candles, 7)),
                fourHour: tf(candles.slice(-20)),
            };
            // Full pipeline on crypto Hot Picks too — same engine as
            // the click-path. computeFullConfidence handles crypto by
            // routing through derivs / cross-asset enrichments.
            const result = await computeFullConfidence(multiData, 'crypto', coin.id, timeframe, { bulkScan: false, newsLite: true });
            const { view, locked } = await effectiveView(sym, result, timeframe);
            results.push({
                symbol: sym, name: coin.name, id: coin.id, price: px,
                ...pickFields(view),
                currency: 'USD',
                change: coin.change24h || 0, _sparkline: sparklineData,
                _lockKey: sym, _locked: locked, _live: result,
            });
            // Progressive update every ~10 coins so the UI can repaint.
            if (onPartial && analyzed % 10 === 0) onPartial(rankPicks(results, maxPicks, cryptoFloor));
        } catch (e) { continue; }
    }
    const finalPicks = rankPicks(results, maxPicks, cryptoFloor);
    await lockShownPicks(finalPicks, timeframe);
    cacheSet(cryptoCache, cacheKey, finalPicks);
    return finalPicks;
}

async function fetchCryptoMarket(page = 1) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=${page}&sparkline=true&price_change_percentage=24h`;
    // Through the shared CoinGecko gate+cache so it doesn't 429.
    const data = await coingeckoJson(url);
    if (!Array.isArray(data)) return [];
    return data.map(coin => ({
        id: coin.id, symbol: coin.symbol, name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h || 0,
        volume: coin.total_volume, marketCap: coin.market_cap,
        sparkline: coin.sparkline_in_7d?.price || [],
    }));
}

async function fetchCryptoTrending() {
    const url = 'https://api.coingecko.com/api/v3/search/trending';
    const data = await coingeckoJson(url);
    if (!data.coins) return [];
    return data.coins.map(c => ({
        id: c.item.id, symbol: c.item.symbol, name: c.item.name,
        price: c.item.data?.price || 0,
        change24h: c.item.data?.price_change_percentage_24h?.usd || 0,
        sparkline: [],
    }));
}

function deriveMultiTimeframe(data) {
    const candles = data.candles;
    const weeklyCandles = aggregateCandlesPeriod(candles, 5);
    const fourHourCandles = candles.slice(-20);
    return { daily: data, weekly: { ...data, candles: weeklyCandles }, fourHour: { ...data, candles: fourHourCandles } };
}

function aggregateCandlesPeriod(candles, periodSize) {
    if (!candles || candles.length < periodSize) return candles;
    const aggregated = [];
    for (let i = 0; i < candles.length; i += periodSize) {
        const slice = candles.slice(i, i + periodSize);
        if (slice.length === 0) continue;
        aggregated.push({
            time: slice[0].time, open: slice[0].open,
            high: Math.max(...slice.map(c => c.high)),
            low: Math.min(...slice.map(c => c.low)),
            close: slice[slice.length - 1].close,
            volume: slice.reduce((sum, c) => sum + (c.volume || 0), 0),
        });
    }
    return aggregated;
}
