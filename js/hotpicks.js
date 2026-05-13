// Hot Picks Scanner. Stock screeners filtered strictly to EQUITY/ETF
// so cryptocurrency entries from cross-asset Yahoo screeners can't leak
// into the stocks tab.

import { fetchStockData, fetchCryptoData, fetchWithProxy } from './data.js';
import { generatePrediction, generateMultiTimeframePrediction } from './analysis.js';
import { getMarketConditionsScore } from './market.js';

export async function scanStockHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null) {
    const isTomorrow = timeframe === 'tomorrow';
    if (onProgress) onProgress('Scanning all real-time market sources for movers...');

    const screeners = isTomorrow
        ? ['most_actives', 'undervalued_growth_stocks', 'aggressive_small_caps', 'growth_technology_stocks', 'most_actives']
        : ['day_gainers', 'most_actives', 'day_losers', 'undervalued_growth_stocks', 'aggressive_small_caps'];

    const screenerResults = await Promise.allSettled(screeners.map(s => fetchYahooScreener(s)));
    const trendingResult = await fetchYahooTrending().catch(() => []);

    const symbolSet = new Set();
    const symbolMeta = {};
    screenerResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            result.value.forEach(stock => {
                if (!symbolSet.has(stock.symbol)) {
                    symbolSet.add(stock.symbol);
                    symbolMeta[stock.symbol] = stock;
                }
            });
        }
    });
    trendingResult.forEach(s => {
        if (!symbolSet.has(s.symbol)) {
            symbolSet.add(s.symbol);
            symbolMeta[s.symbol] = s;
        }
    });

    let symbols = [...symbolSet];
    if (onProgress) onProgress(`Found ${symbols.length} stocks from ${screeners.length + 1} real-time sources...`);
    if (symbols.length === 0) return [];

    if (onProgress) onProgress(`Fetching market conditions (Fear & Greed, VIX, S&P 500 trend)...`);
    const marketScore = await getMarketConditionsScore('stock').catch(() => ({ score: 50 }));

    if (onProgress) onProgress(`Running ${isTomorrow ? 'predictive' : 'real-time'} analysis on ${symbols.length} stocks...`);

    const results = [];
    const batchSize = 6;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const analyzed = i + batch.length;
        if (onProgress) onProgress(`${isTomorrow ? 'Predicting' : 'Analyzing'} ${batch.join(', ')}... (${analyzed}/${symbols.length})`);

        const batchResults = await Promise.allSettled(
            batch.map(async (symbol) => {
                try {
                    const data = await fetchStockData(symbol, '3mo', '1d');
                    if (!data.candles || data.candles.length < 30) return null;
                    const multiData = deriveMultiTimeframe(data);
                    const prediction = generateMultiTimeframePrediction(multiData, timeframe);
                    const meta = symbolMeta[symbol] || {};
                    const techScore = convertSignalToScore(prediction.signal, prediction.confidence);
                    const blended = techScore * 0.60 + marketScore.score * 0.40;
                    let signal;
                    if (blended > 56) signal = 'BUY';
                    else if (blended < 44) signal = 'SELL';
                    else signal = 'NEUTRAL';
                    const deviation = Math.abs(blended - 50) / 50;
                    const confidence = Math.round(38 + deviation * 50);
                    const sparkline = data.candles.slice(-30).map(c => c.close);
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
        if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 150));
    }

    const buy = results.filter(r => r.signal === 'BUY').sort((a, b) => b.confidence - a.confidence);
    const neutral = results.filter(r => r.signal === 'NEUTRAL').sort((a, b) => b.confidence - a.confidence);
    const sell = results.filter(r => r.signal === 'SELL').sort((a, b) => b.confidence - a.confidence);
    return [...buy, ...neutral, ...sell].slice(0, maxPicks);
}

async function fetchYahooScreener(screener) {
    const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${screener}&count=50`;
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const quotes = json?.finance?.result?.[0]?.quotes || [];
    return quotes
        .filter(q => {
            // Strict equity/ETF only — keeps crypto/futures from cross-asset
            // screeners (most_actives in particular) out of the stocks tab.
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
    // Trending API doesn't return quoteType reliably, so we filter by symbol
    // shape — -USD suffix and = futures get dropped here too.
    return quotes
        .filter(q => q.symbol && !q.symbol.includes('-USD') && !q.symbol.includes('=') && !q.symbol.includes('.'))
        .map(q => ({ symbol: q.symbol, name: q.symbol }));
}

export async function scanCryptoHotPicks(timeframe = 'today', maxPicks = 20, onProgress = null) {
    const isTomorrow = timeframe === 'tomorrow';
    if (onProgress) onProgress('Scanning all crypto sources — market cap, trending, gainers...');

    const [marketPage1, marketPage2, trendingCoins] = await Promise.allSettled([
        fetchCryptoMarket(1),
        fetchCryptoMarket(2),
        fetchCryptoTrending(),
    ]);

    const coinMap = new Map();
    [marketPage1, marketPage2].forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            result.value.forEach(coin => coinMap.set(coin.id, coin));
        }
    });
    if (trendingCoins.status === 'fulfilled' && trendingCoins.value) {
        trendingCoins.value.forEach(coin => {
            if (!coinMap.has(coin.id)) coinMap.set(coin.id, coin);
        });
    }

    const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'usdd', 'frax', 'lusd', 'gusd', 'usd1', 'usde', 'fdusd', 'pyusd', 'eusd'];
    const coins = [...coinMap.values()]
        .filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()) && !coin.name.toLowerCase().includes('usd'));

    if (coins.length === 0) return [];
    if (onProgress) onProgress(`Found ${coins.length} coins. Fetching market conditions...`);
    const marketScore = await getMarketConditionsScore('crypto').catch(() => ({ score: 50 }));
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
            const prediction = generateMultiTimeframePrediction(multiData, timeframe);
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
    const buy = results.filter(r => r.signal === 'BUY').sort((a, b) => b.confidence - a.confidence);
    const neutral = results.filter(r => r.signal === 'NEUTRAL').sort((a, b) => b.confidence - a.confidence);
    const sell = results.filter(r => r.signal === 'SELL').sort((a, b) => b.confidence - a.confidence);
    return [...buy, ...neutral, ...sell].slice(0, maxPicks);
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
        const open = slice[0];
        const close = slice[slice.length - 1];
        const high = Math.max(...slice);
        const low = Math.min(...slice);
        candles.push({
            time: Date.now() / 1000 - (prices.length - i) * 3600,
            open, high, low, close, volume: 0,
        });
    }
    return candles;
}

function deriveMultiTimeframe(data) {
    const candles = data.candles;
    const weeklyCandles = aggregateCandlesPeriod(candles, 5);
    const fourHourCandles = candles.slice(-20);
    return {
        daily: data,
        weekly: { ...data, candles: weeklyCandles },
        fourHour: { ...data, candles: fourHourCandles },
    };
}

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

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
