// Unified live-pricing layer for the portfolio simulator.
//
// One subscription model regardless of asset class:
//     const handle = subscribe('BTC-USD', priceCb);  // Binance WS, real-time
//     const handle = subscribe('NVDA',     priceCb);  // Yahoo poll, ~5min delay
//     handle.close();
//
// Crypto path: a single Binance WS per symbol, subscriber count tracked so
// closing the last subscriber tears down the socket. Reuses the same wss
// pattern as js/ui/price-alerts.js. Could be unified further later, but
// keeping it isolated now means portfolio doesn't pollute the existing
// alert path.
//
// Stock path: shared 30s-interval poller across all stock subscriptions
// (one fetch per symbol per tick, but multiple subs of the same symbol
// share the fetch). Yahoo's data is already 5–15min delayed, so a 30s
// poll cadence is appropriate for "live-feeling" P&L without rate-limit
// abuse. The portfolio panel surfaces a "delayed" badge on stock rows
// so the user knows.

const STOCK_POLL_MS = 30_000;

// crypto: symbol -> { ws, retryMs, retryTimer, subs: Set<cb>, lastPrice }
const cryptoStreams = new Map();
// stocks: symbol -> { subs: Set<cb>, lastPrice }
const stockSubs = new Map();
let stockTimer = null;

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
        // Fire once immediately so the UI doesn't sit on "—" until the
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

// ── stock path ────────────────────────────────────────────────────────

async function fetchStockPrice(symbol) {
    // Yahoo's quote endpoint can return CORS-blocked on some browsers,
    // but the chart endpoint works reliably and has a 1m candle that's
    // close enough to a real-time-ish quote for our purposes.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no chart result');
    // Prefer the live meta quote (regularMarketPrice) which Yahoo updates
    // continuously; fall back to the latest 1m close.
    const live = result.meta?.regularMarketPrice;
    if (Number.isFinite(live) && live > 0) return live;
    const closes = result.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) throw new Error('no closes');
    for (let i = closes.length - 1; i >= 0; i--) {
        if (Number.isFinite(closes[i]) && closes[i] > 0) return closes[i];
    }
    throw new Error('no usable close');
}

async function pollStocksOnce() {
    const symbols = [...stockSubs.keys()];
    if (!symbols.length) return;
    // Sequential fetch to keep request rate moderate. Yahoo gets cranky
    // about parallel bursts from a single client.
    for (const sym of symbols) {
        try {
            const price = await fetchStockPrice(sym);
            const entry = stockSubs.get(sym);
            if (!entry) continue;
            entry.lastPrice = price;
            for (const cb of entry.subs) {
                try { cb(price, { symbol: sym, ts: Date.now(), source: 'yahoo' }); } catch (_) {}
            }
        } catch (_) { /* swallow per-symbol errors so one bad ticker doesn't kill the loop */ }
    }
}

function ensureStockTimer() {
    if (stockTimer) return;
    stockTimer = setInterval(pollStocksOnce, STOCK_POLL_MS);
    // Kick once immediately so subscribers don't wait the full interval
    // for their first price.
    pollStocksOnce();
}

function maybeStopStockTimer() {
    if (stockSubs.size === 0 && stockTimer) {
        clearInterval(stockTimer);
        stockTimer = null;
    }
}

function subscribeStock(symbol, cb) {
    const sym = String(symbol || '').toUpperCase();
    let entry = stockSubs.get(sym);
    if (!entry) {
        entry = { subs: new Set(), lastPrice: null };
        stockSubs.set(sym, entry);
    }
    entry.subs.add(cb);
    if (entry.lastPrice != null) {
        try { cb(entry.lastPrice, { symbol: sym, ts: Date.now(), source: 'yahoo', cached: true }); } catch (_) {}
    }
    ensureStockTimer();
    return {
        symbol: sym,
        kind: 'stock',
        close: () => {
            const e = stockSubs.get(sym);
            if (!e) return;
            e.subs.delete(cb);
            if (e.subs.size === 0) stockSubs.delete(sym);
            maybeStopStockTimer();
        },
    };
}

// ── public API ────────────────────────────────────────────────────────

export function subscribe(symbol, cb) {
    if (isCryptoSymbol(symbol)) return subscribeCrypto(symbol, cb);
    return subscribeStock(symbol, cb);
}

// One-shot price fetch (no subscription). Used at trade execution time
// where we want a single "current price" for the fill, not an ongoing
// stream. Crypto goes through whatever the most recent WS tick was;
// stocks fetch fresh.
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
    return await fetchStockPrice(String(symbol || '').toUpperCase());
}

export function isStale(meta) {
    // Marketing metadata for the UI: tells the panel whether to show a
    // "delayed" badge on this row.
    return meta?.source === 'yahoo';
}
