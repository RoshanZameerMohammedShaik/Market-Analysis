// Hot Picks Scanner — FULLY DYNAMIC
// Fetches real-time market movers, trending, top gainers from live APIs
// Then runs prediction engine on each one

import { fetchStockData, fetchCryptoData, fetchWithProxy } from './data.js';
import { generatePrediction } from './analysis.js';

// ─── STOCK HOT PICKS (Dynamic from live market) ──────────────────────────────

export async function scanStockHotPicks(timeframe = 'today', maxPicks = 20) {
    // Fetch real-time market movers from multiple Yahoo Finance screener sources
    const [gainers, active, trending] = await Promise.allSettled([
        fetchYahooScreener('day_gainers'),
        fetchYahooScreener('most_actives'),
        fetchYahooScreener('day_losers'), // Include losers for SELL signals
    ]);

    // Collect unique symbols from all sources
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

    let symbols = [...symbolSet].slice(0, 40); // Analyze up to 40 live movers

    // If Yahoo screener failed, try fallback trending endpoint
    if (symbols.length === 0) {
        const fallback = await fetchYahooTrending().catch(() => []);
        symbols = fallback.map(s => s.symbol).slice(0, 30);
        fallback.forEach(s => { symbolMeta[s.symbol] = s; });
    }

    if (symbols.length === 0) {
        return []; // Total API failure
    }

    // Run predictions on each symbol
    const results = [];
    const batchSize = 6;

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
            batch.map(async (symbol) => {
                try {
                    const data = await fetchStockData(symbol, '3mo', '1d');
                    if (!data.candles || data.candles.length < 30) return null;

                    const prediction = generatePrediction(data.candles, timeframe);
                    const meta = symbolMeta[symbol] || {};

                    return {
                        symbol: data.symbol,
                        name: data.name || meta.name || symbol,
                        price: data.currentPrice || meta.price,
                        signal: prediction.signal,
                        confidence: prediction.confidence,
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

export async function scanCryptoHotPicks(timeframe = 'today', maxPicks = 20) {
    // Fetch real-time crypto market data from CoinGecko
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

    // Run predictions using sparkline data (faster than individual OHLC calls)
    const results = [];

    for (const coin of coins) {
        try {
            let candles;
            let sparklineData = null;

            if (coin.sparkline && coin.sparkline.length >= 20) {
                // Use sparkline for fast analysis (168 hourly data points = 7 days)
                candles = sparklineToCandles(coin.sparkline);
                sparklineData = coin.sparkline;
            } else {
                // Fallback: fetch OHLC data
                const data = await fetchCryptoData(coin.id, 30);
                candles = data.candles;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!candles || candles.length < 20) continue;

            const prediction = generatePrediction(candles, timeframe);

            results.push({
                symbol: coin.symbol.toUpperCase(),
                name: coin.name,
                id: coin.id,
                price: coin.price,
                signal: prediction.signal,
                confidence: prediction.confidence,
                reasons: prediction.reasons,
                change: coin.change24h || 0,
                _sparkline: sparklineData, // Pass to UI for caching
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
    // SVG sparklines aren't useful enough — return empty and fallback to OHLC
    return [];
}
