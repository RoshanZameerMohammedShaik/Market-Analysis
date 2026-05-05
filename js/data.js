// Data fetching layer — Yahoo Finance (stocks) & CoinGecko (crypto)

const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
];

let currentProxy = 0;
let workingProxy = null;

async function fetchWithProxy(url) {
    // If we found a working proxy before, try it first
    if (workingProxy !== null) {
        try {
            const res = await fetch(CORS_PROXIES[workingProxy] + encodeURIComponent(url));
            if (res.ok) return res;
        } catch (e) { workingProxy = null; }
    }

    // Try direct first (works for CoinGecko which has permissive CORS)
    try {
        const res = await fetch(url);
        if (res.ok) return res;
    } catch (e) { /* fall through to proxies */ }

    // Try all proxies
    for (let i = 0; i < CORS_PROXIES.length; i++) {
        const idx = (currentProxy + i) % CORS_PROXIES.length;
        const proxy = CORS_PROXIES[idx];
        try {
            const res = await fetch(proxy + encodeURIComponent(url));
            if (res.ok) {
                workingProxy = idx;
                currentProxy = idx;
                return res;
            }
        } catch (e) { continue; }
    }
    throw new Error(`Failed to fetch data. Try refreshing the page.`);
}

// ─── STOCK DATA (Yahoo Finance) ───────────────────────────────────────────────

export async function fetchStockData(symbol, range = '3mo', interval = '1d') {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const res = await fetchWithProxy(url);
    const json = await res.json();

    if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
        throw new Error(`No data found for symbol: ${symbol}`);
    }

    const result = json.chart.result[0];
    const timestamps = result.timestamp || [];
    const quote = result.indicators.quote[0];
    const meta = result.meta;

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (quote.close[i] !== null) {
            candles.push({
                time: timestamps[i],
                open: quote.open[i],
                high: quote.high[i],
                low: quote.low[i],
                close: quote.close[i],
                volume: quote.volume[i],
            });
        }
    }

    return {
        symbol: meta.symbol,
        name: meta.shortName || meta.symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        currentPrice: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        candles,
    };
}

export async function fetchStockMultiTimeframe(symbol) {
    const [daily, weekly, fourHour] = await Promise.all([
        fetchStockData(symbol, '3mo', '1d'),
        fetchStockData(symbol, '1y', '1wk'),
        fetchStockData(symbol, '1mo', '1h'),
    ]);

    // Aggregate 1h candles into 4h
    const fourHourCandles = aggregateCandles(fourHour.candles, 4);

    return { daily, weekly, fourHour: { ...fourHour, candles: fourHourCandles } };
}

// ─── CRYPTO DATA (CoinGecko) ─────────────────────────────────────────────────

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export async function fetchCryptoData(coinId, days = 90) {
    const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    const res = await fetchWithProxy(url);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No crypto data for: ${coinId}`);
    }

    const candles = data.map(([time, open, high, low, close]) => ({
        time: Math.floor(time / 1000),
        open, high, low, close, volume: 0,
    }));

    // Get current price
    const priceRes = await fetchWithProxy(
        `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currency=usd&include_24hr_vol=true&include_24hr_change=true`
    );
    const priceData = await priceRes.json();
    const coinPrice = priceData[coinId] || {};

    return {
        symbol: coinId.toUpperCase(),
        name: coinId.charAt(0).toUpperCase() + coinId.slice(1),
        currency: 'USD',
        exchange: 'Crypto',
        currentPrice: coinPrice.usd || candles[candles.length - 1]?.close,
        previousClose: candles.length > 1 ? candles[candles.length - 2]?.close : null,
        volume24h: coinPrice.usd_24h_vol,
        change24h: coinPrice.usd_24h_change,
        candles,
    };
}

export async function fetchCryptoMultiTimeframe(coinId) {
    const [daily, weekly] = await Promise.all([
        fetchCryptoData(coinId, 90),
        fetchCryptoData(coinId, 365),
    ]);

    // For crypto, aggregate daily into weekly
    const weeklyCandles = aggregateCandles(daily.candles, 7);

    return {
        daily,
        weekly: { ...weekly, candles: weeklyCandles },
        fourHour: daily, // CoinGecko free doesn't give 4h, use daily as proxy
    };
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────

export async function searchStocks(query) {
    if (!query || query.length < 1) return [];

    // Try Yahoo Finance search
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true&quotesQueryId=tss_match_phrase_query`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        if (json.quotes && json.quotes.length > 0) {
            return json.quotes
                .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'INDEX')
                .map(q => ({
                    symbol: q.symbol,
                    name: q.shortname || q.longname || q.symbol,
                    exchange: q.exchange,
                    type: q.quoteType,
                }));
        }
    } catch (e) { /* fall through to fallback */ }

    // Fallback: try autocomplete endpoint
    try {
        const url = `https://query2.finance.yahoo.com/v6/finance/autocomplete?query=${encodeURIComponent(query)}&lang=en`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.ResultSet?.Result || []).map(r => ({
            symbol: r.symbol,
            name: r.name,
            exchange: r.exchDisp || r.exch,
            type: r.typeDisp || 'EQUITY',
        }));
    } catch (e) {
        // Final fallback: construct symbol directly for common patterns
        const upper = query.toUpperCase();
        return [{ symbol: upper, name: upper, exchange: 'Search', type: 'EQUITY' }];
    }
}

export async function searchCrypto(query) {
    if (!query || query.length < 1) return [];
    try {
        const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(query)}`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.coins || []).slice(0, 10).map(c => ({
            symbol: c.symbol.toUpperCase(),
            name: c.name,
            id: c.id,
            thumb: c.thumb,
        }));
    } catch (e) {
        // Fallback: try matching against known cryptos
        const lower = query.toLowerCase();
        const matches = HOT_CRYPTO.filter(c => c.includes(lower));
        return matches.map(id => ({
            symbol: id.toUpperCase(),
            name: id.charAt(0).toUpperCase() + id.slice(1),
            id: id,
            thumb: '',
        }));
    }
}

// ─── HOT PICKS LISTS ─────────────────────────────────────────────────────────

export const HOT_STOCKS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'AMD',
    'NFLX', 'JPM', 'V', 'DIS', 'BA', 'PYPL', 'SQ', 'COIN', 'PLTR',
    'SOFI', 'NIO', 'RIVN', 'MARA', 'RIOT', 'GME', 'AMC', 'SNAP',
];

export const HOT_CRYPTO = [
    'bitcoin', 'ethereum', 'solana', 'cardano', 'dogecoin', 'ripple',
    'polkadot', 'avalanche-2', 'chainlink', 'polygon-ecosystem-token',
    'litecoin', 'uniswap', 'stellar', 'cosmos', 'near',
];

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function aggregateCandles(candles, periodSize) {
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
