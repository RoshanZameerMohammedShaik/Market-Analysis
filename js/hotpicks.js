// Hot Picks Scanner — FULLY DYNAMIC
// Fetches real-time market movers, trending, top gainers from live APIs
// Runs technical analysis + applies shared market conditions for consistent scoring

import { fetchStockData, fetchCryptoData, fetchWithProxy } from './data.js';
import { generatePrediction, generateMultiTimeframePrediction } from './analysis.js';
import { getMarketConditionsScore } from './market.js';

// ─── STOCK HOT PICKS (Dynamic from live market) ──────────────────────────────

export async function scanStockHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null) {
    if (onProgress) onProgress('Fetching today\'s top gainers, most active, and losers...');

    const [gainers, active, trending] = await Promise.allSettled([
        fetchYahooScreener('day_gainers'),
        fetchYahooScreener('most_actives'),
        fetchYahooScreener('day_losers'),
    ]);

    const symbolSet = new Set();
    const symbolMeta = {};

    [gainers, active, trending].forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            result.value.forEach(stock => {
                if (!symbolSet.has(stock.symbol)) {
                    symbolSet.add(stock.symbol);
                    symbolMeta[stock.symbol] = stock;
                }
            });
        }
    });

    let symbols = [...symbolSet].slice(0, 40);

    if (symbols.length === 0) {
        if (onProgress) onProgress('Primary sources failed, trying trending stocks...');
        const fallback = await fetchYahooTrending().catch(() => []);
        symbols = fallback.map(s => s.symbol).slice(0, 30);
        fallback.forEach(s => { symbolMeta[s.symbol] = s; });
    }

    if (symbols.length === 0) return [];

    if (onProgress) onProgress(`Found ${symbols.length} market movers. Fetching Fear & Greed, VIX, S&P 500...`);

    const marketScore = await getMarketConditionsScore('stock').catch(() => ({ score: 50 }));

    // Run predictions on each symbol, blend with market conditions
    if (onProgress) onProgress(`Running technical analysis on ${symbols.length} stocks...`);

    const results = [];
    const batchSize = 6;

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const analyzed = i + batch.length;
        if (onProgress) onProgress(`Analyzing ${batch.join(', ')}... (${analyzed}/${symbols.length})`);

        const batchResults = await Promise.allSettled(
            batch.map(async (symbol) => {
                try {
                    const data = await fetchStockData(symbol, '3mo', '1d');
                    if (!data.candles || data.candles.length < 30) return null;

                    const multiData = deriveMultiTimeframe(data);
                    const prediction = generateMultiTimeframePrediction(multiData, timeframe);
                    const meta = symbolMeta[symbol] || {};

                    // Blend: 60% technical + 40% market conditions (same as full engine minus per-stock news/AI)
                    const techScore = convertSignalToScore(prediction.signal, prediction.confidence);
                    const blended = techScore * 0.60 + marketScore.score * 0.40;

                    let signal;
                    if (blended > 56) signal = 'BUY';
                    else if (blended < 44) signal = 'SELL';
                    else signal = 'NEUTRAL';

                    const deviation = Math.abs(blended - 50) / 50;
                    const confidence = Math.round(38 + deviation * 50);

                    return {
                        symbol: data.symbol,
                        name: data.name || meta.name || symbol,
                        price: data.currentPrice || meta.price,
                        signal,
                        confidence,
                        reasons: prediction.reasons,
                        change: meta.changePercent || (data.currentPrice && data.previousClose
                            ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                            : 0),
                    };
                } catch (e) {
                    return null;
                }
            })
        );

        batchResults.forEach(r => {
            if (r.status === 'fulfilled' && r.value) results.push(r.value);
        });

        if (i + batchSize < symbols.length) {
            await new Promise(r => setTimeout(r, 150));
        }
    }

    // Sort: BUY signals first by confidence, then NEUTRAL
    const buy = results.filter(r => r.signal === 'BUY').sort((a, b) => b.confidence - a.confidence);
    const neutral = results.filter(r => r.signal === 'NEUTRAL').sort((a, b) => b.confidence - a.confidence);
    const sell = results.filter(r => r.signal === 'SELL').sort((a, b) => b.confidence - a.confidence);

    return [...buy, ...neutral, ...sell].slice(0, maxPicks);
}

// Yahoo Finance Screener — fetches real-time market movers
async function fetchYahooScreener(screener) {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${screener}&count=25`;
    const res = await fetchWithProxy(url);
    const json = await res.json();

    const quotes = json?.finance?.result?.[0]?.quotes || [];
    return quotes
        .filter(q => q.regularMarketPrice && q.symbol && !q.symbol.includes('.'))
        .map(q => ({
            symbol: q.symbol,
            name: q.shortName || q.longName || q.symbol,
            price: q.regularMarketPrice,
            changePercent: q.regularMarketChangePercent || 0,
            volume: q.regularMarketVolume || 0,
            marketCap: q.marketCap || 0,
        }));
}

// Yahoo Finance Trending — fallback if screener fails
async function fetchYahooTrending() {
    const url = 'https://query2.finance.yahoo.com/v1/finance/trending/US?count=30';
    const res = await fetchWithProxy(url);
    const json = await res.json();

    const quotes = json?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => ({ symbol: q.symbol, name: q.symbol }));
}

// ─── CRYPTO HOT PICKS (Dynamic from live market) ─────────────────────────────

export async function scanCryptoHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null) {
    if (onProgress) onProgress('Fetching top crypto by market cap + trending coins...');

    const [marketCoins, trendingCoins] = await Promise.allSettled([
        fetchCryptoMarket(),
        fetchCryptoTrending(),
    ]);

    // Combine market top + trending into one list
    const coinMap = new Map();

    if (marketCoins.status === 'fulfilled' && marketCoins.value) {
        marketCoins.value.forEach(coin => coinMap.set(coin.id, coin));
    }

    if (trendingCoins.status === 'fulfilled' && trendingCoins.value) {
        trendingCoins.value.forEach(coin => {
            if (!coinMap.has(coin.id)) coinMap.set(coin.id, coin);
        });
    }

    // Filter out stablecoins — they don't move, useless for predictions
    const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'usdd', 'frax', 'lusd', 'gusd', 'usd1', 'usde', 'fdusd', 'pyusd', 'eusd'];
    const coins = [...coinMap.values()]
        .filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()) && !coin.name.toLowerCase().includes('usd'))
        .slice(0, 35);

    if (coins.length === 0) return [];

    if (onProgress) onProgress(`Found ${coins.length} coins. Fetching Crypto Fear & Greed Index...`);

    const marketScore = await getMarketConditionsScore('crypto').catch(() => ({ score: 50 }));

    if (onProgress) onProgress(`Running technical analysis on ${coins.length} cryptocurrencies...`);

    const results = [];
    let analyzed = 0;

    for (const coin of coins) {
        analyzed++;
        if (onProgress) onProgress(`Analyzing ${coin.name} (${coin.symbol.toUpperCase()})... (${analyzed}/${coins.length})`);
        try {
            let candles;
            let sparklineData = null;

            if (coin.sparkline && coin.sparkline.length >= 20) {
                candles = sparklineToCandles(coin.sparkline);
                sparklineData = coin.sparkline;
            } else {
                const data = await fetchCryptoData(coin.id, 30);
                candles = data.candles;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!candles || candles.length < 20) continue;

            const multiData = {
                daily: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles },
                weekly: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles: aggregateCandlesPeriod(candles, 7) },
                fourHour: { symbol: coin.symbol.toUpperCase(), name: coin.name, currentPrice: coin.price, previousClose: null, candles },
            };
            const prediction = generateMultiTimeframePrediction(multiData, timeframe);

            // Blend: 60% technical + 40% market conditions
            const techScore = convertSignalToScore(prediction.signal, prediction.confidence);
            const blended = techScore * 0.60 + marketScore.score * 0.40;

            let signal;
            if (blended > 56) signal = 'BUY';
            else if (blended < 44) signal = 'SELL';
            else signal = 'NEUTRAL';

            const deviation = Math.abs(blended - 50) / 50;
            const confidence = Math.round(38 + deviation * 50);

            results.push({
                symbol: coin.symbol.toUpperCase(),
                name: coin.name,
                id: coin.id,
                price: coin.price,
                signal,
                confidence,
                reasons: prediction.reasons,
                change: coin.change24h || 0,
                _sparkline: sparklineData,
            });
        } catch (e) {
            continue;
        }
    }

    // Sort: BUY first, then NEUTRAL, then SELL
    const buy = results.filter(r => r.signal === 'BUY').sort((a, b) => b.confidence - a.confidence);
    const neutral = results.filter(r => r.signal === 'NEUTRAL').sort((a, b) => b.confidence - a.confidence);
    const sell = results.filter(r => r.signal === 'SELL').sort((a, b) => b.confidence - a.confidence);

    return [...buy, ...neutral, ...sell].slice(0, maxPicks);
}

// CoinGecko Markets — top coins by market cap + gainers with sparkline data
async function fetchCryptoMarket() {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=true&price_change_percentage=24h';
    const res = await fetchWithProxy(url);
    const data = await res.json();

    if (!Array.isArray(data)) return [];

    return data.map(coin => ({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h || 0,
        volume: coin.total_volume,
        marketCap: coin.market_cap,
        sparkline: coin.sparkline_in_7d?.price || [],
    }));
}

// CoinGecko Trending — what's hot right now
async function fetchCryptoTrending() {
    const url = 'https://api.coingecko.com/api/v3/search/trending';
    const res = await fetchWithProxy(url);
    const data = await res.json();

    if (!data.coins) return [];

    return data.coins.map(c => ({
        id: c.item.id,
        symbol: c.item.symbol,
        name: c.item.name,
        price: c.item.data?.price || 0,
        change24h: c.item.data?.price_change_percentage_24h?.usd || 0,
        sparkline: c.item.data?.sparkline ? parseSparklineSVG(c.item.data.sparkline) : [],
    }));
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

// Convert sparkline (array of prices) into candle-like objects for the prediction engine
function sparklineToCandles(prices) {
    if (!prices || prices.length < 20) return [];

    // Aggregate hourly prices into ~4-hour candles for better signal detection
    const periodSize = 4;
    const candles = [];

    for (let i = 0; i < prices.length; i += periodSize) {
        const slice = prices.slice(i, i + periodSize);
        if (slice.length === 0) continue;

        const open = slice[0];
        const close = slice[slice.length - 1];
        const high = Math.max(...slice);
        const low = Math.min(...slice);

        candles.push({
            time: Date.now() / 1000 - (prices.length - i) * 3600,
            open, high, low, close,
            volume: 0,
        });
    }

    return candles;
}

// Parse sparkline SVG path data into price array (CoinGecko trending returns SVG)
function parseSparklineSVG(svgString) {
    if (!svgString || typeof svgString !== 'string') return [];
    return [];
}

// Derive multi-timeframe data from daily candles (for stocks)
// Aggregates daily into weekly, uses recent portion as "4H equivalent"
function deriveMultiTimeframe(data) {
    const candles = data.candles;
    const weeklyCandles = aggregateCandlesPeriod(candles, 5); // 5 trading days = 1 week
    const fourHourCandles = candles.slice(-20); // Last 20 days as short-term proxy

    return {
        daily: data,
        weekly: { ...data, candles: weeklyCandles },
        fourHour: { ...data, candles: fourHourCandles },
    };
}

// Aggregate candles into larger periods
function aggregateCandlesPeriod(candles, periodSize) {
    if (!candles || candles.length < periodSize) return candles;
    const aggregated = [];
    for (let i = 0; i < candles.length; i += periodSize) {
        const slice = candles.slice(i, i + periodSize);
        if (slice.length === 0) continue;
        aggregated.push({
            time: slice[0].time,
            open: slice[0].open,
            high: Math.max(...slice.map(c => c.high)),
            low: Math.min(...slice.map(c => c.low)),
            close: slice[slice.length - 1].close,
            volume: slice.reduce((sum, c) => sum + (c.volume || 0), 0),
        });
    }
    return aggregated;
}

// Convert signal + confidence to 0-100 bullish score (same as confidence.js)
function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
