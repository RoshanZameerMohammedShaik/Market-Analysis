// Data fetching layer — Yahoo Finance (stocks) & CoinGecko (crypto).
// Strategy:
//   1) Direct fetch (works for non-Yahoo URLs that send CORS headers).
//   2) Our own Cloudflare Worker /yahoo proxy (always tried for Yahoo URLs;
//      handles cookies/crumb for v7 quote, has stable uptime).
//   3) Public CORS proxies as last-resort fallback (corsproxy.io etc.
//      regularly start gating; we keep them so non-Yahoo CORS-blocked
//      sources still have a path).

const WORKER_PROXY = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev/yahoo?u=';

const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://thingproxy.freeboard.io/fetch/',
];

let workingProxy = null;

function isYahooUrl(url) {
    return /^https?:\/\/(query1|query2)\.finance\.yahoo\.com\//i.test(url);
}

export async function fetchWithProxy(url) {
    const yahoo = isYahooUrl(url);

    // 1) Direct fetch — only for non-Yahoo URLs. Yahoo never sends CORS
    //    headers from the browser, so a direct attempt is guaranteed to
    //    log an error and waste a round-trip. Skip it.
    if (!yahoo) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const text = await res.text();
                if (isValidResponse(text)) return createTextResponse(text, res);
            }
        } catch (e) { /* fall through */ }
    }

    // 2) For Yahoo URLs, our Worker is the primary path.
    if (yahoo) {
        try {
            const res = await tryProxy(WORKER_PROXY, url);
            if (res) return res;
        } catch (e) { /* fall through */ }
    }

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

export async function fetchStockData(symbol, range = '3mo', interval = '1d', opts = {}) {
    // Raw symbol — fetchWithProxy encodes the URL exactly once at the
    // proxy layer (see regime.js comment). Pre-encoding here would
    // double-encode any '^' / ':' / non-ASCII characters and Yahoo
    // would 404. ASCII tickers are unaffected (encodeURIComponent is
    // idempotent for them), but the bug pattern is still wrong.
    //
    // Suffix retry chain: when the caller hands us a BARE ticker (no
    // .NS/.BO/.L/.HK/.T/.AX suffix), Yahoo's chart endpoint may return
    // no data for non-US listings (CORDSCABLE-style Indian small-caps)
    // because it can't resolve the exchange. We probe the bare form
    // first, then fall through major non-US exchanges in likelihood
    // order. EXPENSIVE on the miss path — 6 candidates × 2 URLs ×
    // proxy chain — so callers that operate on bulk universes (Hot
    // Picks scan, batch refresh) opt OUT via { suffixProbe: false } to
    // avoid the freeze when even one symbol is dead. User-initiated
    // searches keep the probe enabled (default true).
    const hasSuffix = /\.[A-Z]{1,3}$/.test(symbol);
    const probe = opts.suffixProbe !== false;
    const candidates = hasSuffix || !probe
        ? [symbol]
        : [symbol, `${symbol}.NS`, `${symbol}.BO`, `${symbol}.L`, `${symbol}.HK`, `${symbol}.T`];

    let json = null;
    let resolvedSymbol = symbol;
    outer:
    for (const candidate of candidates) {
        const urls = [
            `https://query1.finance.yahoo.com/v8/finance/chart/${candidate}?range=${range}&interval=${interval}&includePrePost=false`,
            `https://query2.finance.yahoo.com/v8/finance/chart/${candidate}?range=${range}&interval=${interval}&includePrePost=false`,
        ];
        for (const url of urls) {
            try {
                const res = await fetchWithProxy(url);
                const j = await res.json();
                if (j.chart && j.chart.result && j.chart.result.length > 0) {
                    json = j;
                    resolvedSymbol = candidate;
                    break outer;
                }
            } catch (e) { continue; }
        }
    }

    if (!json || !json.chart || !json.chart.result || json.chart.result.length === 0) {
        throw new Error(`No data found for: ${symbol}`);
    }
    // If we resolved via a suffix probe, expose the resolved symbol on
    // the meta so downstream callers (chart, signal, ledger) record the
    // correct exchange-tagged form.
    if (resolvedSymbol !== symbol && json.chart.result[0]?.meta) {
        json.chart.result[0].meta.symbol = resolvedSymbol;
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

    // Derive a sane previousClose. Order of preference:
    //   1. meta.previousClose       — yesterday's close (always 1-day prior)
    //   2. second-to-last candle    — yesterday's close, derived from the data
    //   3. meta.chartPreviousClose  — LAST resort. This is the close at the
    //      START of the requested range (3 months ago in our case), so using
    //      it here gives nonsense day-% values like "+401.8%" on AAOI.
    let previousClose = meta.previousClose;
    if (previousClose == null && candles.length >= 2) {
        previousClose = candles[candles.length - 2].close;
    }
    if (previousClose == null) {
        previousClose = meta.chartPreviousClose;
    }

    return {
        symbol: meta.symbol,
        name: meta.shortName || meta.symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        currentPrice: meta.regularMarketPrice,
        previousClose,
        candles,
    };
}

export async function fetchStockMultiTimeframe(symbol) {
    // Resolve the daily fetch FIRST — that one runs the suffix probe
    // (CORDSCABLE → CORDSCABLE.NS), so the weekly + 4h calls can
    // skip re-probing by using the resolved symbol with suffixProbe off.
    // Without this, an unsuffixed Indian ticker would re-probe through
    // 6 candidates × 2 URLs three separate times in parallel — major
    // slowdown on a search miss.
    const dailyRes = await fetchStockData(symbol, '3mo', '1d').catch(() => null);
    if (!dailyRes) throw new Error(`Could not fetch data for ${symbol}`);
    const resolved = dailyRes.symbol || symbol;
    const [weeklyRes, fourHourRes] = await Promise.allSettled([
        fetchStockData(resolved, '1y', '1wk', { suffixProbe: false }),
        fetchStockData(resolved, '1mo', '1h', { suffixProbe: false }),
    ]);

    const daily = dailyRes;
    const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
    const fourHourRaw = fourHourRes.status === 'fulfilled' ? fourHourRes.value : null;

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
    // Yahoo's autocomplete misses many Indian / global small-caps
    // (CORDSCABLE, etc.) — when search returns nothing we offer the
    // bare ticker plus exchange-suffixed candidates so the user can
    // pick the right listing. fetchStockData also probes these
    // suffixes transparently, but exposing them in the dropdown lets
    // the user choose explicitly when both NSE and BSE are listed.
    const upper = query.toUpperCase();
    if (/\.[A-Z]{1,3}$/.test(upper)) {
        return [{ symbol: upper, name: upper, exchange: '', type: 'EQUITY' }];
    }
    return [
        { symbol: upper,         name: `${upper} (try as US ticker)`,    exchange: 'US',  type: 'EQUITY' },
        { symbol: `${upper}.NS`, name: `${upper} (NSE India)`,           exchange: 'NSE', type: 'EQUITY' },
        { symbol: `${upper}.BO`, name: `${upper} (BSE India)`,           exchange: 'BSE', type: 'EQUITY' },
    ];
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
