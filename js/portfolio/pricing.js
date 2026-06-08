// Unified pricing layer for the portfolio simulator.
//
// Two patterns under the hood — one per asset class — but one subscribe()
// API for callers:
//
//   const handle = subscribe('BTC-USD', priceCb);  // Binance WS, real-time stream
//   const handle = subscribe('NVDA',     priceCb);  // Stooq snapshot, manual refresh
//   handle.close();
//
// Crypto: Binance WebSocket, true real-time. CB fires on every trade.
// Stocks: snapshot-on-demand. CB fires:
//   - immediately with cached price when available (so panel doesn't show '—')
//   - again whenever refreshStockPrices() runs (panel-open + manual ↻ button)
//
// Stock price sources, in priority order:
//   1. Public.com REALTIME quote via our Worker /stock-quote route (the
//      secret lives on the Worker; the browser only ever calls our route).
//      This is genuine realtime — when configured it replaces the delayed feed.
//   2. Stooq CSV snapshot — free, CORS-friendly, 5–15 min delayed.
//   3. Yahoo v7 quote via the Worker proxy — covers more low-volume / intl.
// If Public isn't configured (no Worker secret) or is down, we fall straight
// through to Stooq/Yahoo, so the app always has a price. We surface the
// source + a 'last refreshed HH:MM' timestamp so the user knows freshness.
//
// (History: we once polled Yahoo every 30s, but Yahoo's chart endpoint
// CORS-blocks browser fetches in prod, so that was silently broken. The
// honest design is "snapshot on demand" for the delayed sources, plus the
// realtime Public feed when available.)

// crypto: symbol -> { ws, retryMs, retryTimer, subs: Set<cb>, lastPrice }
const cryptoStreams = new Map();
// stocks: symbol -> { subs: Set<cb>, lastPrice, lastFetchedAt }
const stockSubs = new Map();

export function isCryptoSymbol(symbol) {
    return /-USD$/i.test(String(symbol || ''));
}

function toBinanceStream(symbol) {
    const s = String(symbol || '').toUpperCase();
    const m = s.match(/^([A-Z0-9]+)-USD$/);
    if (!m) return null;
    return `${m[1].toLowerCase()}usdt@trade`;
}

// ── crypto path ───────────────────────────────────────────────────────

function openCryptoSocket(symbol) {
    const stream = toBinanceStream(symbol);
    if (!stream) return; // unsupported coin → callers stay null-safe
    const entry = cryptoStreams.get(symbol) || {
        ws: null, retryMs: 1000, retryTimer: null, subs: new Set(), lastPrice: null,
    };
    cryptoStreams.set(symbol, entry);

    const open = () => {
        let ws;
        try { ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`); }
        catch (_) { scheduleRetry(); return; }
        entry.ws = ws;
        ws.onopen = () => { entry.retryMs = 1000; };
        ws.onmessage = (ev) => {
            try {
                const m = JSON.parse(ev.data);
                const price = parseFloat(m.p);
                if (!Number.isFinite(price)) return;
                entry.lastPrice = price;
                for (const cb of entry.subs) {
                    try { cb(price, { symbol, ts: Date.now(), source: 'binance' }); } catch (_) {}
                }
            } catch (_) {}
        };
        ws.onerror = () => { /* onclose handles cleanup */ };
        ws.onclose = () => {
            entry.ws = null;
            if (entry.subs.size > 0) scheduleRetry();
        };
    };
    const scheduleRetry = () => {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout(() => { entry.retryTimer = null; open(); }, entry.retryMs);
        entry.retryMs = Math.min(entry.retryMs * 2, 30_000);
    };
    open();
    return entry;
}

function subscribeCrypto(symbol, cb) {
    let entry = cryptoStreams.get(symbol);
    if (!entry) entry = openCryptoSocket(symbol);
    if (!entry) return null; // unsupported coin
    entry.subs.add(cb);
    if (entry.lastPrice != null) {
        // Fire once immediately so the UI doesn't sit on '—' until the
        // next trade tick. Some thinly-traded pairs have several seconds
        // between trades.
        try { cb(entry.lastPrice, { symbol, ts: Date.now(), source: 'binance', cached: true }); } catch (_) {}
    }
    return {
        symbol,
        kind: 'crypto',
        close: () => unsubscribeCrypto(symbol, cb),
    };
}

function unsubscribeCrypto(symbol, cb) {
    const entry = cryptoStreams.get(symbol);
    if (!entry) return;
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
        if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
        if (entry.ws) {
            try { entry.ws.onclose = null; entry.ws.close(); } catch (_) {}
        }
        cryptoStreams.delete(symbol);
    }
}

// ── stock path (Stooq snapshot, on-demand) ─────────────────────────────

// Stooq's symbol convention differs slightly from Yahoo / what we use
// internally. US tickers append '.us'. International tickers use lower-
// case + their own suffix (e.g., RELIANCE on NSE → 'reliance.in', though
// coverage is spotty). We map common cases; any unmapped symbol gets
// '.us' which is correct for ~95% of what users buy.
function toStooqSymbol(symbol) {
    const s = String(symbol || '').toLowerCase();
    if (s.endsWith('.ns')) return s.replace(/\.ns$/, '.in');
    if (s.endsWith('.l')) return s.replace(/\.l$/, '.uk');
    if (s.endsWith('.de')) return s.replace(/\.de$/, '.de'); // Stooq uses .de natively
    if (s.endsWith('.hk') || s.endsWith('.t') || s.endsWith('.ax')) return s; // try as-is
    if (/\./.test(s)) return s; // already has a country suffix we don't recognize
    return `${s}.us`; // default: treat as US ticker
}

// Worker base that fronts the Public.com brokerage API (same Worker as the
// Yahoo proxy). The secret lives on the Worker, not here.
const PUBLIC_QUOTE_URL = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev/stock-quote';

// Realtime stock price via Public.com (through our Worker). Resolves a finite
// price, or throws so the caller falls back to Stooq. Treats "not configured"
// (no Worker secret yet) and any non-realtime payload as a miss — silently —
// so the feature degrades to the delayed sources until the key is set.
let _publicQuoteDisabled = false;   // flips true after a 'configured:false' so we stop trying
async function fetchStockPriceFromPublic(symbol) {
    if (_publicQuoteDisabled) throw new Error('public quote disabled');
    const res = await fetch(`${PUBLIC_QUOTE_URL}?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error(`public ${res.status}`);
    const json = await res.json();
    if (json && json.configured === false) {
        _publicQuoteDisabled = true;   // no secret on the Worker — don't keep asking this session
        throw new Error('public not configured');
    }
    const price = json?.price;
    if (!Number.isFinite(price) || price <= 0) throw new Error('public no price');
    return price;
}

async function fetchStockPriceFromStooq(symbol) {
    const stooqSym = toStooqSymbol(symbol);
    // Stooq's CSV "last quote" endpoint. f=sd2t2ohlcv → symbol, date, time,
    // open, high, low, close, volume. We only need 'close' (which is the
    // most recent traded price for intraday calls).
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('empty stooq response');
    const cols = lines[1].split(',');
    if (cols.length < 7) throw new Error('unexpected stooq response shape');
    const close = parseFloat(cols[6]);
    if (!Number.isFinite(close) || close <= 0) {
        // Stooq returns 'N/D' literally for symbols it doesn't carry —
        // surfaces here as NaN. Throw so the caller can try Yahoo.
        throw new Error(`stooq has no data for ${symbol}`);
    }
    return close;
}

async function fetchStockPriceFromYahoo(symbol) {
    // Yahoo's v7/finance/quote endpoint — lightweight last-trade lookup.
    // Same one hotpicks uses for batch quotes. Goes through fetchWithProxy
    // because Yahoo's chart/quote endpoints don't send CORS headers.
    // Lazy-import to keep the portfolio module dependency-light at boot.
    const { fetchWithProxy } = await import('../data.js');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
    const res = await fetchWithProxy(url);
    const json = await res.json();
    const row = json?.quoteResponse?.result?.[0];
    const price = row?.regularMarketPrice;
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`yahoo has no live price for ${symbol}`);
    }
    return price;
}

async function fetchStockPrice(symbol) {
    // Returns { price, source }. Priority: Public (realtime) → Stooq (delayed,
    // fast, CORS-friendly) → Yahoo (delayed, broader coverage, via proxy).
    // Each tier throws on miss; we only error after ALL fail.
    try {
        return { price: await fetchStockPriceFromPublic(symbol), source: 'public' };
    } catch (_) { /* fall through to delayed sources */ }
    try {
        return { price: await fetchStockPriceFromStooq(symbol), source: 'stooq' };
    } catch (_) {
        return { price: await fetchStockPriceFromYahoo(symbol), source: 'yahoo' };
    }
}

function subscribeStock(symbol, cb) {
    const sym = String(symbol || '').toUpperCase();
    let entry = stockSubs.get(sym);
    if (!entry) {
        entry = { subs: new Set(), lastPrice: null, lastFetchedAt: null, lastSource: null };
        stockSubs.set(sym, entry);
    }
    entry.subs.add(cb);
    if (entry.lastPrice != null) {
        try {
            cb(entry.lastPrice, {
                symbol: sym, ts: entry.lastFetchedAt || Date.now(),
                source: entry.lastSource || 'stooq', cached: true,
            });
        } catch (_) {}
    }
    // NOTE: no auto-poll. Caller (portfolio panel) calls refreshStockPrices()
    // when they want a fresh snapshot.
    return {
        symbol: sym,
        kind: 'stock',
        close: () => {
            const e = stockSubs.get(sym);
            if (!e) return;
            e.subs.delete(cb);
            if (e.subs.size === 0) stockSubs.delete(sym);
        },
    };
}

// Refresh ALL currently-subscribed stock symbols with a fresh Stooq fetch.
// Sequential to keep request rate moderate. Returns a summary object so
// the caller (panel) can show a toast or update a "last refreshed at"
// indicator.
export async function refreshStockPrices() {
    const symbols = [...stockSubs.keys()];
    if (!symbols.length) {
        return { refreshed: 0, failed: 0, ts: Date.now() };
    }
    let refreshed = 0;
    let failed = 0;
    for (const sym of symbols) {
        try {
            const { price, source } = await fetchStockPrice(sym);
            const entry = stockSubs.get(sym);
            if (!entry) continue;
            entry.lastPrice = price;
            entry.lastFetchedAt = Date.now();
            entry.lastSource = source;
            for (const cb of entry.subs) {
                try { cb(price, { symbol: sym, ts: entry.lastFetchedAt, source }); } catch (_) {}
            }
            refreshed++;
        } catch (_) {
            failed++;
        }
    }
    return { refreshed, failed, ts: Date.now() };
}

// Snapshot of when each stock was last fetched, for UI 'last refreshed
// HH:MM' display. Returns null for symbols never fetched.
export function getStockFreshness(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const entry = stockSubs.get(sym);
    return entry?.lastFetchedAt || null;
}

// ── public API ────────────────────────────────────────────────────────

export function subscribe(symbol, cb) {
    if (isCryptoSymbol(symbol)) return subscribeCrypto(symbol, cb);
    return subscribeStock(symbol, cb);
}

// One-shot price fetch (no subscription). Used at trade execution time
// where we want a single 'current price' for the fill, not an ongoing
// stream. Crypto goes through whatever the most recent WS tick was;
// stocks fetch fresh from Stooq.
export async function getCurrentPrice(symbol) {
    if (isCryptoSymbol(symbol)) {
        const entry = cryptoStreams.get(symbol);
        if (entry?.lastPrice != null) return entry.lastPrice;
        // No active subscription yet. Open a temporary one, await first tick.
        return await new Promise((resolve, reject) => {
            const handle = subscribe(symbol, (price) => {
                handle.close();
                resolve(price);
            });
            if (!handle) return reject(new Error(`Symbol ${symbol} not supported on Binance.`));
            setTimeout(() => {
                try { handle.close(); } catch (_) {}
                reject(new Error('Timed out waiting for first tick.'));
            }, 8000);
        });
    }
    const sym = String(symbol || '').toUpperCase();
    const { price, source } = await fetchStockPrice(sym);
    _lastStockSourceBySym.set(sym, source);
    _lastStockSourceAny = source;
    if (_lastStockSourceBySym.size > 500) _lastStockSourceBySym.delete(_lastStockSourceBySym.keys().next().value);
    return price;
}

// Source of the most recent getCurrentPrice() fetch PER SYMBOL, so callers that
// only get the number back (trade fills, Mia) can tell realtime from delayed —
// keyed by symbol so concurrent fetches (e.g. portfolio pricing several
// positions at once) don't clobber each other's source. Pass the symbol you
// just fetched; omit to get the most-recent of any (best-effort).
const _lastStockSourceBySym = new Map();
let _lastStockSourceAny = null;
export function getLastStockSource(symbol) {
    if (symbol) return _lastStockSourceBySym.get(String(symbol).toUpperCase()) || null;
    return _lastStockSourceAny;
}

export function isStale(meta) {
    // UI metadata: tells the panel whether to show a 'delayed' badge.
    // 'public' is realtime → NOT stale. stooq/yahoo are delayed.
    const src = typeof meta === 'string' ? meta : meta?.source;
    return src === 'stooq' || src === 'yahoo';
}
