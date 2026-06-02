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

import { fetchStockData, fetchCryptoData, fetchWithProxy } from './data.js';
import { generatePrediction, generateMultiTimeframePrediction } from './analysis.js';
import { getMarketConditionsScore } from './market.js';
import { UNIVERSE_CONFIG } from './markets.js';
import { computeFullConfidence } from './confidence.js';
import { getCalibrationThresholds, getCalibrationThresholdsSync } from './calibration-thresholds.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const stockCache = new Map(); // key -> { ts, picks }
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

    // Score each symbol by a simple momentum + volume composite.
    // |changePct| favors movers; volume favors liquid names.
    const scored = symbols.map(sym => {
        const m = symbolMeta[sym] || {};
        const change = Math.abs(m.changePercent || 0);
        const vol = m.volume || m.regularMarketVolume || 0;
        const volScore = vol > 0 ? Math.log10(vol + 1) : 0; // 6 = 1M, 7 = 10M, 8 = 100M
        const score = change * 1.0 + volScore * 1.5;
        return { sym, score };
    }).filter(s => s.score > 0);

    scored.sort((a, b) => b.score - a.score);
    const TOP_N = 60;
    const filteredSymbols = scored.slice(0, TOP_N).map(s => s.sym);

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
                    const data = await fetchStockData(symbol, '3mo', '1d', { suffixProbe: false });
                    if (!data.candles || data.candles.length < 30) return null;
                    const multiData = deriveMultiTimeframe(data);
                    // Full pipeline — same call as the user-click path
                    // in core.js. bulkScan=false so the LSTM, per-symbol
                    // ledger track record, and all enrichments fire.
                    const result = await computeFullConfidence(multiData, 'stock', symbol, timeframe, { bulkScan: false });
                    const meta = symbolMeta[symbol] || {};
                    const sparkline = data.candles.slice(-30).map(c => c.close);
                    return {
                        symbol: data.symbol,
                        name: data.name || meta.name || symbol,
                        price: data.currentPrice || meta.price,
                        signal: result.signal,
                        confidence: result.confidence,
                        expectedPct: result.priceTargets?.highPercent ?? null,
                        expectedHigh: result.priceTargets?.predictedHigh ?? null,
                        expectedLow: result.priceTargets?.predictedLow ?? null,
                        expectedLowPct: result.priceTargets?.lowPercent ?? null,
                        currency: data.currency || 'USD',
                        reasons: result.reasons,
                        change: meta.changePercent || (data.currentPrice && data.previousClose
                            ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                            : 0),
                        _sparkline: sparkline,
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

// Always surface the engine's top-conviction directional picks for the
// session. The learned floor is now metadata, not a visibility gate:
// each card carries a `qualityTier` field that the UI uses to mark
// picks as "above-bar" or "below-bar" so the user can see what's
// historically reliable vs. speculative without Hot Picks looking
// empty on weak-conviction days.
function rankPicks(results, maxPicks, floor) {
    const directional = results
        .filter(r => r.signal === 'BUY' || r.signal === 'SELL')
        .sort((a, b) => b.confidence - a.confidence)
        .map(r => ({
            ...r,
            qualityTier: r.confidence >= floor ? 'above-bar' : 'below-bar',
            historicalFloor: floor,
        }));
    return directional.slice(0, maxPicks);
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
    for (const coin of coins) {
        analyzed++;
        if (onProgress) onProgress(`${isTomorrow ? 'Predicting' : 'Analyzing'} ${coin.name} (${coin.symbol.toUpperCase()})... (${analyzed}/${coins.length})`);
        try {
            let candles;
            let sparklineData = null;
            if (coin.sparkline && coin.sparkline.length >= 20) {
                candles = sparklineToCandles(coin.sparkline);
                sparklineData = coin.sparkline;
            } else {
                const data = await fetchCryptoData(coin.id, 30);
                candles = data.candles;
                sparklineData = candles.slice(-30).map(c => c.close);
                await new Promise(r => setTimeout(r, 500));
            }
            if (!candles || candles.length < 20) continue;
            const multiData = {
                daily: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles },
                weekly: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles: aggregateCandlesPeriod(candles, 7) },
                fourHour: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles },
            };
            // Full pipeline on crypto Hot Picks too — same engine as
            // the click-path. computeFullConfidence handles crypto by
            // routing through derivs / cross-asset enrichments.
            const result = await computeFullConfidence(multiData, 'crypto', coin.id, timeframe, { bulkScan: false });
            results.push({
                symbol: coin.symbol.toUpperCase(), name: coin.name, id: coin.id, price: coin.price,
                signal: result.signal,
                confidence: result.confidence,
                expectedPct: result.priceTargets?.highPercent ?? null,
                expectedHigh: result.priceTargets?.predictedHigh ?? null,
                expectedLow: result.priceTargets?.predictedLow ?? null,
                expectedLowPct: result.priceTargets?.lowPercent ?? null,
                currency: 'USD', // CoinGecko data is always USD
                reasons: result.reasons,
                change: coin.change24h || 0, _sparkline: sparklineData,
            });
            // Progressive update every ~10 coins so the UI can repaint.
            if (onPartial && analyzed % 10 === 0) onPartial(rankPicks(results, maxPicks, cryptoFloor));
        } catch (e) { continue; }
    }
    const finalPicks = rankPicks(results, maxPicks, cryptoFloor);
    cacheSet(cryptoCache, cacheKey, finalPicks);
    return finalPicks;
}

async function fetchCryptoMarket(page = 1) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=${page}&sparkline=true&price_change_percentage=24h`;
    const res = await fetchWithProxy(url);
    const data = await res.json();
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
    const res = await fetchWithProxy(url);
    const data = await res.json();
    if (!data.coins) return [];
    return data.coins.map(c => ({
        id: c.item.id, symbol: c.item.symbol, name: c.item.name,
        price: c.item.data?.price || 0,
        change24h: c.item.data?.price_change_percentage_24h?.usd || 0,
        sparkline: [],
    }));
}

function sparklineToCandles(prices) {
    if (!prices || prices.length < 20) return [];
    const periodSize = 4;
    const candles = [];
    for (let i = 0; i < prices.length; i += periodSize) {
        const slice = prices.slice(i, i + periodSize);
        if (slice.length === 0) continue;
        candles.push({
            time: Date.now() / 1000 - (prices.length - i) * 3600,
            open: slice[0], high: Math.max(...slice), low: Math.min(...slice),
            close: slice[slice.length - 1], volume: 0,
        });
    }
    return candles;
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

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
