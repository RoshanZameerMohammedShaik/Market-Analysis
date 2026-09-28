// Data fetching layer — Yahoo Finance (stocks) & CoinGecko (crypto).
// Strategy:
//   1) Direct fetch (works for non-Yahoo URLs that send CORS headers).
//   2) Our own Cloudflare Worker /yahoo proxy (always tried for Yahoo URLs;
//      handles cookies/crumb for v7 quote, has stable uptime).
//
// There used to be a third step: four public CORS proxies (corsproxy.io, allorigins,
// codetabs, thingproxy). Measured on 2026-09-28 every one was dead from the deployed origin:
// corsproxy.io answers 401 to anything but localhost, allorigins and codetabs abort, thingproxy
// no longer resolves. They were also a standing privacy and integrity cost: a third party saw
// every URL relayed through it and could have answered with anything. Sources a browser cannot
// read directly now go through our own Worker (news RSS, StockTwits) or a published slice
// (macro), so the chain only ever added failed requests and seconds of latency. Kept as an
// empty list so the fallback code below documents itself if one is ever added back.

import { isCooling, recordFailure } from './breaker.js';

const WORKER_PROXY = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev/yahoo?u=';

const CORS_PROXIES = [];

let workingProxy = null;

function isYahooUrl(url) {
    return /^https?:\/\/(query1|query2)\.finance\.yahoo\.com\//i.test(url);
}

// Per-target-host breaker. Independent of the per-proxy breaker
// below — this one trips when the TARGET URL's host is unreachable
// regardless of which proxy we tried. Catches the case where Hot
// Picks fires 5 parallel analyses, each calling fetchGoogleNews,
// before the news.js-level breaker has time to trip on the first
// failure. We trip THIS one fast (after a single chain failure) so
// concurrent callers in flight short-circuit at the proxy layer.
function targetBreakerName(url) {
    try { return 'target:' + new URL(url).hostname; }
    catch (_) { return null; }
}
// Targets we don't want to breaker-cool (they're our own infra OR
// reliably-up Yahoo paths that aren't crumb-walled). Without this,
// a single transient blip on chart endpoints would silence the whole
// engine.
const TARGET_BREAKER_EXEMPT = /(^|\.)yahoo\.com$|workers\.dev$|coingecko\.com$|stooq\.com$/i;
function shouldUseTargetBreaker(url) {
    try {
        const h = new URL(url).hostname;
        return !TARGET_BREAKER_EXEMPT.test(h);
    } catch (_) { return false; }
}

// Per-endpoint cool-down for Yahoo paths Yahoo started crumb-walling.
// /v10/quoteSummary and /v7/options/ require an auth cookie + crumb
// our worker proxy can't satisfy; Yahoo returns 401. Each endpoint
// family gets its own breaker (so a 401 on quoteSummary doesn't
// silence options too — they're independent fault domains).
const YAHOO_CRUMB_WALLED = [
    { re: /\/v10\/finance\/quoteSummary\//, name: 'yahoo-quoteSummary' },
    { re: /\/v7\/finance\/options\//, name: 'yahoo-options' },
];

function yahooBreakerNameFor(url) {
    for (const { re, name } of YAHOO_CRUMB_WALLED) {
        if (re.test(url)) return name;
    }
    return null;
}
function shouldSkipYahooUrl(url) {
    const name = yahooBreakerNameFor(url);
    return name ? isCooling(name) : false;
}
function recordYahooSkip(url) {
    const name = yahooBreakerNameFor(url);
    if (name) recordFailure(name);
}

// Each public CORS proxy gets its own breaker so a 503 on corsproxy.io
// doesn't cause us to retry it for every subsequent URL in a scan.
// Trip on first failure (per the centralized breaker contract);
// 10-min cooldown then probes again.
function proxyBreakerName(proxyUrl) {
    try { return 'cors-proxy:' + new URL(proxyUrl).hostname; }
    catch (_) { return 'cors-proxy:unknown'; }
}

export async function fetchWithProxy(url) {
    const yahoo = isYahooUrl(url);

    // Short-circuit Yahoo paths that we've already learned are
    // crumb-walled this session. Saves the round-trip-per-symbol.
    if (yahoo && shouldSkipYahooUrl(url)) {
        throw new Error('Yahoo endpoint crumb-walled (skipped).');
    }
    // Short-circuit any target host that's already cooling (e.g.
    // news.google.com after one failed chain). When 5 parallel
    // callers race in, only the first walks the chain; the rest
    // hit the breaker at the gate.
    const targetBreaker = shouldUseTargetBreaker(url) ? targetBreakerName(url) : null;
    if (targetBreaker && isCooling(targetBreaker)) {
        throw new Error(`Target host cooling (${targetBreaker}).`);
    }

    // 1) Direct fetch — only for non-Yahoo URLs. Yahoo never sends CORS
    //    headers from the browser, so a direct attempt is guaranteed to
    //    log an error and waste a round-trip. Skip it.
    //
    // Also skip direct for hosts we've already learned reject CORS —
    // news.google.com is the textbook example. After one failure the
    // target breaker covers it, but we additionally maintain a
    // hard-coded list of hosts that NEVER work via direct fetch from
    // a browser, so we don't even try once. Saves the first error
    // every session.
    const directBlockedHosts = /^([^.]+\.)?(news\.google\.com|reddit\.com)$/i;
    let urlHost = '';
    try { urlHost = new URL(url).hostname; } catch (_) {}

    // CORS is a BROWSER policy. Node has none, so every host in directBlockedHosts is
    // reachable directly there and the proxy chain is not just unnecessary but harmful:
    // it was the reason Mia's desk got zero news. news.google.com answers a plain fetch
    // from Node with HTTP 200 and 100 items, while the proxy chain failed and tripped the
    // breaker, so crypto sentiment -- which has no Yahoo fallback -- was always empty.
    // Detected by capability rather than by a NODE env var, so it is correct in a browser,
    // in Node, and in a worker without anyone having to remember to set a flag.
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    // OUTSIDE A BROWSER, GO DIRECT. ALWAYS.
    //
    // The `!yahoo` term meant every Yahoo request was forced through the Cloudflare Worker,
    // and that reasoning is browser-only: Yahoo sends no CORS headers, so a browser genuinely
    // cannot read a direct response. Node has no CORS at all, and a plain server-side fetch to
    // the chart endpoint returns HTTP 200 with full data -- which is exactly how yfinance works
    // in Python.
    //
    // The cost of getting this wrong was the Worker's request quota. fetchStockMultiTimeframe
    // makes THREE Yahoo calls per symbol (daily, weekly, hourly), the desk scans ~400 tradeable
    // names per cycle, and the trading loop runs many cycles per job. That is ~1,200 Worker
    // requests per cycle from a process that never needed the proxy for even one of them.
    //
    // Detected by capability rather than an env var, so it is correct in a browser, in Node and
    // in a worker without anyone having to remember to set a flag.
    const tryDirect = !isBrowser || (!yahoo && !directBlockedHosts.test(urlHost));
    if (tryDirect) {
        let definitive = null;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const text = await res.text();
                if (isValidResponse(text)) return createTextResponse(text, res);
            } else if (res.status === 400 || res.status === 404 || res.status === 451) {
                // 451 is a legal block ("restricted location"): no proxy route changes the law.
                definitive = res.status;
            }
        } catch (e) { /* fall through */ }
        // A 404 is the source's answer ("no such symbol"), not a transport failure. Walking the
        // proxy chain after it re-asks the same question through slower routes: an unknown crypto
        // ticker took 24 seconds that way before anything could fall back to another source.
        if (definitive) {
            const err = new Error(`Source answered ${definitive} for this request.`);
            err.status = definitive;
            throw err;
        }
    }

    // 2) For Yahoo URLs, our Worker is the primary path.
    if (yahoo) {
        try {
            const res = await tryProxy(WORKER_PROXY, url);
            if (res) return res;
        } catch (e) {
            // 401 from the worker on a crumb-walled Yahoo path means
            // EVERY downstream proxy will also 401 — they all hit the
            // same Yahoo endpoint that requires the auth cookie + crumb.
            // Trip the breaker IMMEDIATELY and abort the chain. Without
            // this, we'd cascade through 4 CORS proxies just to learn
            // the same thing 4 more times.
            if (e.status === 401 && yahooBreakerNameFor(url)) {
                recordYahooSkip(url);
                throw new Error('Yahoo endpoint crumb-walled (401, skipping chain).');
            }
            // Yahoo's 404 ("No data found, symbol may be delisted") is final. Every public proxy
            // would relay the same answer, only slower.
            if (e.status === 400 || e.status === 404) {
                const err = new Error(`Yahoo answered ${e.status} for this request.`);
                err.status = e.status;
                throw err;
            }
        }
    }

    // 3) Public CORS proxy chain. Each proxy has its own breaker so a
    //    503/timeout on corsproxy.io doesn't get retried for every
    //    subsequent URL in a Hot-Picks-style scan. The "lastWorking"
    //    sticky-pick stays — once one proxy works, future calls hit it
    //    first and skip the chain entirely on the happy path.
    if (workingProxy !== null) {
        const proxy = CORS_PROXIES[workingProxy];
        if (!isCooling(proxyBreakerName(proxy))) {
            try {
                const res = await tryProxy(proxy, url);
                if (res) return res;
            } catch (e) {
                recordFailure(proxyBreakerName(proxy));
                workingProxy = null;
            }
        } else {
            workingProxy = null;
        }
    }

    for (let i = 0; i < CORS_PROXIES.length; i++) {
        if (i === workingProxy) continue;
        const proxy = CORS_PROXIES[i];
        if (isCooling(proxyBreakerName(proxy))) continue;
        try {
            const res = await tryProxy(proxy, url);
            if (res) {
                workingProxy = i;
                return res;
            }
        } catch (e) {
            recordFailure(proxyBreakerName(proxy));
            continue;
        }
    }
    // Exhausted every proxy. Trip both the per-target breaker (so
    // future calls to the same host short-circuit) and any matching
    // Yahoo crumb-wall breaker.
    if (targetBreaker) recordFailure(targetBreaker);
    if (yahoo) recordYahooSkip(url);
    throw new Error(`Unable to reach data source. Please try again.`);
}

async function tryProxy(proxy, url) {
    const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
        // Surface the status so callers can record specific failures
        // (401 on Yahoo crumb-walled paths) rather than swallowing.
        const err = new Error(`proxy returned ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const text = await res.text();
    if (!isValidResponse(text)) return null;
    return createTextResponse(text, res);
}

// Does this look like real data rather than a proxy's HTML error page?
//
// The guard is worth keeping: a CORS proxy that is rate-limiting returns HTTP 200 with an
// HTML apology, and accepting that as data is how a scan silently fills with garbage. But it
// used to allow ONLY JSON, XML and RSS, which rejected valid CSV -- so FRED's macro series
// came back HTTP 200 with 209 KB of correct data and were thrown away, then the whole CORS
// chain was burned trying to "fix" a response that was never broken.
//
// CSV is recognised structurally rather than by trusting a content-type header, because the
// proxies rewrite headers. A first line of comma-separated tokens with no HTML tag start is
// data; anything opening a tag is a page.
function isValidResponse(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<?xml')
        || trimmed.startsWith('<rss') || trimmed.startsWith('<feed')) return true;
    return looksLikeCsv(trimmed);
}

function looksLikeCsv(trimmed) {
    if (!trimmed || trimmed.startsWith('<')) return false;
    const firstLine = trimmed.slice(0, 400).split('\n')[0];
    if (!firstLine.includes(',')) return false;
    // Needs a header AND at least one row, and no HTML tag near the top: a rate-limited
    // proxy answers 200 with an HTML apology, and accepting that as data is how a scan
    // silently fills with garbage.
    if (!trimmed.includes('\n')) return false;
    return !/<\s*(html|head|body|script)/i.test(trimmed.slice(0, 400));
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
    // Never probe exchange suffixes onto a crypto pair, an FX pair or an index: "UNI-USD.NS" is
    // not a listing anywhere, and each miss costs two proxied requests.
    const probe = opts.suffixProbe !== false && !/-USD$|[=^]/i.test(symbol);
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
                // Yahoo's own "No data found" is final for this candidate: query2 serves the same
                // index, so asking it too just doubles the cost of every unknown ticker.
                if (j?.chart?.error?.code === 'Not Found') continue outer;
            } catch (e) {
                if (e?.status === 404) continue outer;
                continue;
            }
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

    // Preserve the RAW 1h series (pre-4h-aggregation) so the intraday
    // LSTM can run on true 1h bars for the "Today" horizon. fourHourRaw
    // is the un-aggregated 1h fetch; we only aggregated a COPY into
    // fourHour above. null when the 1h fetch failed — the engine falls
    // back to the daily model for Today in that case.
    const hourly = fourHourRaw && fourHourRaw.candles?.length ? fourHourRaw : null;

    return { daily, weekly: weekly || daily, fourHour, hourly };
}

// ─── CRYPTO DATA ───────────────────────────────────────────────────────────────

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// CoinGecko's free API works directly from the browser (CORS-friendly, 200),
// but its rate limit (~10-30 calls/min) 429s when several calls fire at once —
// which is why crypto symbols intermittently "don't load". So we (a) SERIALIZE
// CoinGecko calls behind a min-interval gate, and (b) short-TTL CACHE responses
// so repeat lookups (chart + analysis of the same coin, or re-opens within a
// couple minutes) don't re-hit the network at all. fetchWithProxy still adds
// the CORS-proxy fallback for the rare case direct fails.
const _cgGate = { last: 0, chain: Promise.resolve() };
// MEASURED, not assumed. This was 650ms on the belief that the free tier allowed ~30/min. It does
// not: on 2026-09-18 a burst returned `200 200 200 429 429 429...` with Retry-After: 58, and at
// 6-second spacing only 5 of 8 got through. The sustainable rate is roughly 5 per minute, so 12s.
//
// A CoinGecko 429 also carries NO Access-Control-Allow-Origin header, which means the browser
// surfaces it as a CORS error and the code below cannot read the status at all -- every failure
// looks like a network error. That is why the retry had to go (see coingeckoFetch): retrying a
// rate-limit rejection doubles the doomed traffic and deepens the lockout.
const CG_MIN_INTERVAL_MS = 12_000;
// After this many consecutive failures, stop calling entirely for COOLDOWN. Without a readable
// status there is no way to tell a 429 from a real outage, and in both cases hammering is wrong.
const CG_FAIL_LIMIT = 2;
const CG_COOLDOWN_MS = 60_000;   // matches the observed Retry-After: 58
const _cgBreaker = { fails: 0, until: 0 };
function coingeckoFetch(url) {
    // Queue this fetch behind the previous one, spacing them by the min
    // interval, so concurrent callers don't burst CoinGecko into a 429.
    const run = _cgGate.chain.then(async () => {
        const wait = Math.max(0, CG_MIN_INTERVAL_MS - (Date.now() - _cgGate.last));
        if (wait) await new Promise(r => setTimeout(r, wait));
        _cgGate.last = Date.now();
        if (Date.now() < _cgBreaker.until) {
            // Fail fast and say why, rather than queue behind a 12s gate to be rejected anyway.
            throw new Error('CoinGecko is rate-limited; cooling off for '
                + `${Math.ceil((_cgBreaker.until - Date.now()) / 1000)}s`);
        }
        try {
            const res = await fetchWithProxy(url);
            _cgBreaker.fails = 0;
            return res;
        } catch (e) {
            // NO RETRY. A 429 here is invisible (no CORS header on the error response), so a retry
            // cannot distinguish "transient hiccup" from "you are locked out for the next minute" --
            // it just spends another request confirming the lockout and extends it.
            _cgBreaker.fails += 1;
            if (_cgBreaker.fails >= CG_FAIL_LIMIT) {
                _cgBreaker.until = Date.now() + CG_COOLDOWN_MS;
                _cgBreaker.fails = 0;
                console.warn(`[data] CoinGecko failed ${CG_FAIL_LIMIT}x; pausing calls for `
                    + `${CG_COOLDOWN_MS / 1000}s. Crypto lists will use cached data until then.`);
            }
            throw e;
        }
    });
    // Keep the chain alive even if this link rejects, so one failure doesn't
    // wedge every queued call behind it.
    _cgGate.chain = run.catch(() => {});
    return run;
}

// Short-TTL response cache keyed by full URL (OHLC + simple/price both cached).
const _cgCache = new Map();
const CG_CACHE_MS = 90 * 1000;
// Exported so other modules' CoinGecko calls (hotpicks market list / trending)
// share the SAME rate-limit gate + cache — otherwise they burst CoinGecko in
// parallel and 429, which is the main reason crypto symbols don't load.
export async function coingeckoJson(url) {
    const hit = _cgCache.get(url);
    if (hit && Date.now() - hit.ts < CG_CACHE_MS) return hit.data;
    const res = await coingeckoFetch(url);
    const data = await res.json();
    _cgCache.set(url, { ts: Date.now(), data });
    return data;
}

export async function fetchCryptoData(coinId, days = 90, opts = {}) {
    // withLivePrice makes a SECOND CoinGecko call (simple/price) for the exact
    // spot price + 24h change. Off by default: the latest OHLC close is a fine
    // price, and halving CoinGecko calls keeps bursts under the rate limit
    // (this was a big part of "crypto symbols don't load"). The single-symbol
    // chart/analysis path can opt in for the precise live figure.
    const { withLivePrice = false } = opts;
    const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    const data = await coingeckoJson(url);

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No crypto data for: ${coinId}`);
    }

    const candles = data.map(([time, open, high, low, close]) => ({
        time: Math.floor(time / 1000),
        open, high, low, close, volume: 0,
    }));

    let currentPrice = candles[candles.length - 1]?.close;
    let change24h = 0;
    if (withLivePrice) {
        try {
            const priceData = await coingeckoJson(
                `${COINGECKO_BASE}/simple/price?ids=${coinId}&vs_currency=usd&include_24hr_vol=true&include_24hr_change=true`
            );
            const coinPrice = priceData[coinId] || {};
            if (coinPrice.usd) currentPrice = coinPrice.usd;
            if (coinPrice.usd_24h_change) change24h = coinPrice.usd_24h_change;
        } catch (e) { /* close-as-price is fine */ }
    }

    const displayName = CRYPTO_NAMES[coinId] || coinId.charAt(0).toUpperCase() + coinId.slice(1).replace(/-/g, ' ');
    // A CoinGecko id is not a ticker ('bitcoin' -> 'BITCOIN' was on the chart header). Callers
    // that know the real ticker pass it; this is only the fallback label.
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

// ─── CRYPTO BARS: YAHOO, CROSS-CHECKED AGAINST KRAKEN ───────────────────────────────
//
// WHY NOT COINGECKO. Its free OHLC endpoint picks the candle size from the range: days=90 and
// days=365 both return candles FOUR DAYS apart. Both were handed to the engine as "daily" and
// "weekly" bars, and the 4h timeframe was the same 4-day series again. Measured on BTC: sigma
// 4.63%/day ("wild") against 2.20% on real daily bars, a 7-day band 16.5% wide against 8.7%, and
// "Daily: insufficient data for analysis" on the card, because 90 days of 4-day candles is 23
// bars. The header price was the close of the last 4-day candle, hours stale. The ledger grades
// bands built on yfinance daily bars, so its measured coverage never described the band a user
// was shown for any coin.
//
// WHY THE CROSS-CHECK. Yahoo reuses tickers. TON-USD is "TON Token" at $0.005, not Toncoin at
// $1.64; ARB-USD is "ARbit", not Arbitrum; UNI-USD, SUI-USD and PEPE-USD return nothing because
// the real coins live at UNI7083-USD, SUI20947-USD and PEPE24478-USD. Kraken lists real coins
// under their plain tickers and answers browsers directly (it echoes the Origin header), so it is
// both the referee and the fallback: Yahoo is used when its price agrees with Kraken's, and
// Kraken's own bars are used when it does not.

const KRAKEN_OHLC = 'https://api.kraken.com/0/public/OHLC';

function krakenCandles(json) {
    const r = json?.result;
    if (!r || (json.error && json.error.length)) return null;
    const key = Object.keys(r).find(k => k !== 'last');
    const rows = key ? r[key] : null;
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows.map(([t, o, h, l, c, _vwap, v]) => ({
        time: Number(t), open: +o, high: +h, low: +l, close: +c, volume: +v,
    })).filter(c => c.close > 0);
}

async function fetchKrakenCandles(base, intervalMin) {
    const b = String(base || '').toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(b)) return null;
    try {
        const res = await fetch(`${KRAKEN_OHLC}?pair=${b}USD&interval=${intervalMin}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        return krakenCandles(await res.json());
    } catch (_) { return null; }
}

const normCoinName = (s) => String(s || '').toLowerCase().replace(/\busd\b/g, '').replace(/[^a-z0-9]/g, '');
/** Exact after normalising ("Bitcoin USD" = "Bitcoin"). Prefixes are NOT accepted: "ARbit" is a prefix of "Arbitrum". */
export function coinNamesAgree(a, b) {
    const x = normCoinName(a), y = normCoinName(b);
    return !!x && x === y;
}

function wrapBars(base, name, candles, currentPrice) {
    const prev = candles.length > 1 ? candles[candles.length - 2].close : null;
    return { symbol: base, name, currency: 'USD', exchange: 'Crypto', currentPrice, previousClose: prev, candles };
}

// Monday-aligned weekly buckets from daily bars (crypto trades every day, so 7 per week).
function weeklyFromDaily(candles) {
    const out = [];
    let cur = null;
    for (const c of candles) {
        const d = new Date(c.time * 1000);
        const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) / 1000;
        if (!cur || cur.time !== monday) {
            cur = { time: monday, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
            out.push(cur);
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume || 0;
        }
    }
    return out;
}

async function krakenMultiTimeframe(base, name) {
    const [daily, hourly] = await Promise.all([fetchKrakenCandles(base, 1440), fetchKrakenCandles(base, 60)]);
    if (!daily || daily.length < 30) return null;
    const px = daily[daily.length - 1].close;
    const d = daily.slice(-90);
    const out = {
        daily: wrapBars(base, name, d, px),
        weekly: wrapBars(base, name, weeklyFromDaily(daily.slice(-371)), px),
        fourHour: wrapBars(base, name, d, px),
        source: 'kraken',
    };
    if (hourly && hourly.length >= 24) {
        out.hourly = wrapBars(base, name, hourly.slice(-720), px);
        out.fourHour = wrapBars(base, name, aggregateCandles(hourly.slice(-720), 4), px);
    }
    return out;
}

/**
 * Real daily/weekly/4h bars for a coin.
 * @param coinId  CoinGecko id (used only for the last-resort fallback)
 * @param opts.base  ticker ("BTC"). Without it the CoinGecko id's first word is used.
 * @param opts.name  coin name ("Bitcoin"), checked against Yahoo's name for the ticker
 */
export async function fetchCryptoMultiTimeframe(coinId, opts = {}) {
    const base = String(opts.base || (coinId === 'ripple' ? 'XRP' : String(coinId || '').split('-')[0]) || '').toUpperCase();
    const name = opts.name || CRYPTO_NAMES[coinId] || '';
    const [yahooRes, krakenRes] = await Promise.allSettled([
        base ? fetchStockMultiTimeframe(`${base}-USD`) : Promise.reject(new Error('no ticker')),
        base ? fetchKrakenCandles(base, 1440) : Promise.resolve(null),
    ]);
    const yahoo = yahooRes.status === 'fulfilled' ? yahooRes.value : null;
    const kraken = krakenRes.status === 'fulfilled' ? krakenRes.value : null;
    const yPx = yahoo?.daily?.currentPrice;
    const kPx = kraken?.length ? kraken[kraken.length - 1].close : null;
    const priceOk = (yPx > 0 && kPx > 0) ? Math.abs(yPx / kPx - 1) < 0.05 : null;
    const nameOk = (yahoo && name) ? coinNamesAgree(yahoo.daily?.name, name) : null;
    // Yahoo wins when Kraken confirms the price, or when there is no Kraken market to compare
    // against and Yahoo's own name for the ticker does not contradict the coin's.
    if (yahoo && yahoo.daily?.candles?.length >= 30 && (priceOk === true || (priceOk === null && nameOk !== false))) {
        const label = name || String(yahoo.daily.name || base).replace(/\s+USD$/i, '');
        for (const tf of ['daily', 'weekly', 'fourHour', 'hourly']) {
            if (yahoo[tf]) yahoo[tf] = { ...yahoo[tf], symbol: base, name: label, exchange: 'Crypto', currency: 'USD' };
        }
        yahoo.source = 'yahoo';
        yahoo.yahooTicker = `${base}-USD`;
        return yahoo;
    }
    if (kraken && kraken.length >= 30) {
        const k = await krakenMultiTimeframe(base, name || base);
        if (k) return k;
    }
    // Last resort: CoinGecko's 30-day window, the longest it serves at 4-hour granularity, rolled
    // up into true daily bars. Never the 90/365-day calls: those are the 4-day candles above.
    const four = await fetchCryptoData(coinId, 30);
    const perDay = [];
    for (const c of four.candles) {
        const day = Math.floor(c.time / 86400) * 86400;
        const last = perDay[perDay.length - 1];
        if (!last || last.time !== day) perDay.push({ ...c, time: day });
        else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
    }
    if (perDay.length < 20) throw new Error(`Could not fetch data for ${base || coinId}`);
    const px = four.currentPrice;
    return {
        daily: wrapBars(base || four.symbol, name || four.name, perDay, px),
        weekly: wrapBars(base || four.symbol, name || four.name, weeklyFromDaily(perDay), px),
        fourHour: wrapBars(base || four.symbol, name || four.name, four.candles, px),
        source: 'coingecko-30d',
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
