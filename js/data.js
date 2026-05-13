// Data fetching layer — Yahoo Finance (stocks) & CoinGecko (crypto).
// CORS-proxy chain with JSON validation. Stock searches strictly
// filter to EQUITY/ETF/INDEX so crypto hits don't leak into stock UI.

const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://thingproxy.freeboard.io/fetch/',
];

let workingProxy = null;

export async function fetchWithProxy(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
            const text = await res.text();
            if (isValidResponse(text)) return createTextResponse(text, res);
        }
    } catch (e) { /* fall through */ }

    if (workingProxy !== null) {
        try {
            const res = await tryProxy(CORS_PROXIES[workingProxy], url);
            if (res) return res;
        } catch (e) { workingProxy = null; }
    }

    for (let i = 0; i < CORS_PROXIES.length; i++) {
        if (i === workingProxy) continue;
        try {
            const res = await tryProxy(CORS_PROXIES[i], url);
            if (res) {
                workingProxy = i;
                return res;
            }
        } catch (e) { continue; }
    }
    throw new Error(`Unable to reach data source. Please try again.`);
}

async function tryProxy(proxy, url) {
    const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (!isValidResponse(text)) return null;
    return createTextResponse(text, res);
}

function isValidResponse(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<?xml') || trimmed.startsWith('<rss') || trimmed.startsWith('<feed')) return true;
    return false;
}

function createTextResponse(text, originalRes) {
    return {
        ok: true,
        status: originalRes.status,
        json: () => Promise.resolve(JSON.parse(text)),
        text: () => Promise.resolve(text),
    };
}

// ─── STOCK DATA ───────────────────────────────────────────────────────────────

export async function fetchStockData(symbol, range = '3mo', interval = '1d') {
    const urls = [
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
    ];

    let json = null;
    for (const url of urls) {
        try {
            const res = await fetchWithProxy(url);
            json = await res.json();
            if (json.chart && json.chart.result && json.chart.result.length > 0) break;
            json = null;
        } catch (e) { continue; }
    }

    if (!json || !json.chart || !json.chart.result || json.chart.result.length === 0) {
        throw new Error(`No data found for: ${symbol}`);
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
    const [dailyRes, weeklyRes, fourHourRes] = await Promise.allSettled([
        fetchStockData(symbol, '3mo', '1d'),
        fetchStockData(symbol, '1y', '1wk'),
        fetchStockData(symbol, '1mo', '1h'),
    ]);

    const daily = dailyRes.status === 'fulfilled' ? dailyRes.value : null;
    const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
    const fourHourRaw = fourHourRes.status === 'fulfilled' ? fourHourRes.value : null;

    if (!daily) throw new Error(`Could not fetch data for ${symbol}`);

    const fourHour = fourHourRaw
        ? { ...fourHourRaw, candles: aggregateCandles(fourHourRaw.candles, 4) }
        : daily;

    return { daily, weekly: weekly || daily, fourHour };
}

// ─── CRYPTO DATA ───────────────────────────────────────────────────────────────

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

    let currentPrice = candles[candles.length - 1]?.close;
    let change24h = 0;
    try {
        const priceRes = await fetchWithProxy(
            `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currency=usd&include_24hr_vol=true&include_24hr_change=true`
        );
        const priceData = await priceRes.json();
        const coinPrice = priceData[coinId] || {};
        if (coinPrice.usd) currentPrice = coinPrice.usd;
        if (coinPrice.usd_24h_change) change24h = coinPrice.usd_24h_change;
    } catch (e) { /* */ }

    const displayName = CRYPTO_NAMES[coinId] || coinId.charAt(0).toUpperCase() + coinId.slice(1).replace(/-/g, ' ');
    const displaySymbol = coinId === 'ripple' ? 'XRP' : coinId.split('-')[0].toUpperCase();

    return {
        symbol: displaySymbol,
        name: displayName,
        currency: 'USD',
        exchange: 'Crypto',
        currentPrice,
        previousClose: candles.length > 1 ? candles[candles.length - 2]?.close : null,
        change24h,
        candles,
    };
}

export async function fetchCryptoMultiTimeframe(coinId) {
    const [dailyRes, weeklyRes] = await Promise.allSettled([
        fetchCryptoData(coinId, 90),
        fetchCryptoData(coinId, 365),
    ]);

    const daily = dailyRes.status === 'fulfilled' ? dailyRes.value : null;
    const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
    if (!daily) throw new Error(`Could not fetch data for ${coinId}`);
    const weeklyCandles = aggregateCandles(daily.candles, 7);
    return {
        daily,
        weekly: weekly || { ...daily, candles: weeklyCandles },
        fourHour: daily,
    };
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────────
// Stock search excludes crypto/futures so the stock tab cannot return
// non-equity hits. The crypto tab uses CoinGecko separately.

export async function searchStocks(query) {
    if (!query || query.length < 1) return [];
    const searchUrls = [
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&enableFuzzyQuery=true`,
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`,
    ];
    for (const url of searchUrls) {
        try {
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
        } catch (e) { continue; }
    }
    const upper = query.toUpperCase();
    return [{ symbol: upper, name: upper, exchange: '', type: 'EQUITY' }];
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
        return [{ symbol: query.toUpperCase(), name: query, id: query.toLowerCase(), thumb: '' }];
    }
}

export const CRYPTO_NAMES = {
    'bitcoin': 'Bitcoin', 'ethereum': 'Ethereum', 'solana': 'Solana',
    'cardano': 'Cardano', 'dogecoin': 'Dogecoin', 'ripple': 'XRP',
    'polkadot': 'Polkadot', 'avalanche-2': 'Avalanche', 'chainlink': 'Chainlink',
    'matic-network': 'Polygon', 'litecoin': 'Litecoin', 'uniswap': 'Uniswap',
};

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
