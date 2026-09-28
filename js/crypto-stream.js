// One live crypto price feed with a fallback venue, shared by the portfolio pricer, the live
// sparklines and the price alerts.
//
// WHY A FALLBACK. Every live crypto price in the app came from Binance.com's public WebSocket, and
// Binance.com refuses connections from the United States (the handshake is rejected; its REST API
// answers 451 "restricted location"). Some networks do not resolve it at all. For a US user that
// meant no live price anywhere: the socket failed, retried with backoff, and failed again every
// 30 seconds per coin, forever, while the header sat on a stale snapshot. On 2026-09-28 the BTC
// header read $84,442 while the market was at $83,908.
//
// So: Binance first (deepest book, one socket per pair), and after two sockets in a row fail
// without ever opening, this session switches to Kraken's public v2 feed. Kraken is a US-licensed
// venue that serves US connections, it is already the app's fallback for crypto BARS (see
// fetchCryptoMultiTimeframe), and it was the only one of Binance, Coinbase and Kraken reachable
// from every network this was tested on. One shared socket, one subscription per pair. A pair
// Kraken does not list simply never ticks, and callers keep their snapshot price.

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/';
const KRAKEN_WS = 'wss://ws.kraken.com/v2';
const BINANCE_FAIL_LIMIT = 2;
const MAX_BACKOFF_MS = 30_000;

let binanceFailures = 0;
// Remembered for a few hours: a network that refuses Binance keeps refusing it, and finding that
// out again costs every page load one failed handshake per coin (10 s each where DNS is blocked).
const VENUE_MEMO_KEY = 'ma-crypto-venue-v1';
const VENUE_MEMO_MS = 6 * 3600 * 1000;
let binanceDown = (() => {
    try {
        const m = JSON.parse(localStorage.getItem(VENUE_MEMO_KEY) || 'null');
        return !!(m && m.venue === 'kraken' && m.until > Date.now());
    } catch (_) { return false; }
})();
const subs = new Map();   // BASE -> { cbs: Set, venue, ws, retryMs, retryTimer, last }
let kr = null;            // Kraken shared socket state

const canSocket = () => typeof WebSocket === 'function';

/** Which venue is serving live prices this session. For the status line and tests. */
export function cryptoStreamVenue() {
    return binanceDown ? 'kraken' : 'binance';
}

/**
 * Subscribe to live trades for a coin. `base` is the ticker ("BTC") or a pair ("BTC-USD").
 * onPrice(price, { source, ts, cached }) fires on every trade, and once immediately with the last
 * known price if there is one. Returns { close } or null for an unusable symbol.
 */
export function streamCryptoPrice(base, onPrice) {
    const b = String(base || '').toUpperCase().replace(/-USDT?$/, '');
    if (!/^[A-Z0-9]{2,12}$/.test(b) || typeof onPrice !== 'function' || !canSocket()) return null;
    let e = subs.get(b);
    if (!e) {
        e = { cbs: new Set(), venue: null, ws: null, retryMs: 1000, retryTimer: null, last: null };
        subs.set(b, e);
        connect(b, e);
    }
    e.cbs.add(onPrice);
    if (e.last != null) {
        try { onPrice(e.last, { source: e.venue, ts: Date.now(), cached: true }); } catch (_) { /* caller's problem */ }
    }
    return { close: () => unsubscribe(b, onPrice) };
}

function emit(b, e, price, venue) {
    e.last = price;
    for (const fn of e.cbs) {
        try { fn(price, { source: venue, ts: Date.now() }); } catch (_) { /* one bad listener must not stop the rest */ }
    }
}

function unsubscribe(b, fn) {
    const e = subs.get(b);
    if (!e) return;
    e.cbs.delete(fn);
    if (e.cbs.size) return;
    subs.delete(b);
    if (e.retryTimer) { clearTimeout(e.retryTimer); e.retryTimer = null; }
    if (e.ws) { try { e.ws.onclose = null; e.ws.close(); } catch (_) {} e.ws = null; }
    if (e.venue === 'kraken' && kr) {
        kr.pairs.delete(`${b}/USD`);
        if (kr.open) sendKraken({ method: 'unsubscribe', params: { channel: 'ticker', symbol: [`${b}/USD`] } });
    }
}

// ── Binance ─────────────────────────────────────────────────────────────────

function connect(b, e) {
    if (binanceDown) { krakenAdd(b, e); return; }
    e.venue = 'binance';
    let opened = false;
    let ws;
    try { ws = new WebSocket(`${BINANCE_WS}${b.toLowerCase()}usdt@trade`); }
    catch (_) { binanceFailed(b, e); return; }
    e.ws = ws;
    ws.onopen = () => { opened = true; binanceFailures = 0; e.retryMs = 1000; };
    ws.onmessage = (ev) => {
        try {
            const price = parseFloat(JSON.parse(ev.data).p);
            if (Number.isFinite(price) && price > 0) emit(b, e, price, 'binance');
        } catch (_) { /* malformed frame */ }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
        e.ws = null;
        if (subs.get(b) !== e) return;           // unsubscribed meanwhile
        if (binanceDown) { krakenAdd(b, e); return; }
        if (!opened) binanceFailed(b, e);
        else retryLater(b, e);
    };
}

function binanceFailed(b, e) {
    binanceFailures += 1;
    if (binanceFailures < BINANCE_FAIL_LIMIT) { retryLater(b, e); return; }
    binanceDown = true;
    try { localStorage.setItem(VENUE_MEMO_KEY, JSON.stringify({ venue: 'kraken', until: Date.now() + VENUE_MEMO_MS })); } catch (_) { /* no storage (Node, private mode) */ }
    // Move everything still waiting on Binance, not just this coin.
    for (const [sym, x] of subs) {
        if (x.venue === 'kraken') continue;
        if (x.retryTimer) { clearTimeout(x.retryTimer); x.retryTimer = null; }
        if (x.ws) { try { x.ws.onclose = null; x.ws.close(); } catch (_) {} x.ws = null; }
        krakenAdd(sym, x);
    }
}

function retryLater(b, e) {
    if (e.retryTimer) clearTimeout(e.retryTimer);
    e.retryTimer = setTimeout(() => {
        e.retryTimer = null;
        if (subs.get(b) === e) connect(b, e);
    }, e.retryMs);
    e.retryMs = Math.min(e.retryMs * 2, MAX_BACKOFF_MS);
}

// ── Kraken (shared socket) ──────────────────────────────────────────────────

function sendKraken(msg) {
    try { kr?.ws?.send(JSON.stringify(msg)); } catch (_) { /* reconnect will resubscribe */ }
}

function subscribeKraken(pair) {
    // One pair per message, so one unlisted coin's rejection cannot take the others with it.
    sendKraken({ method: 'subscribe', params: { channel: 'ticker', symbol: [pair] } });
}

function krakenAdd(b, e) {
    e.venue = 'kraken';
    const pair = `${b}/USD`;
    ensureKraken();
    if (kr.pairs.has(pair)) return;
    kr.pairs.add(pair);
    if (kr.open && !kr.bad.has(pair)) subscribeKraken(pair);
}

function ensureKraken() {
    if (kr && kr.ws && (kr.ws.readyState === 0 || kr.ws.readyState === 1)) return;
    if (!kr) kr = { ws: null, open: false, pairs: new Set(), bad: new Set(), retryMs: 1000, retryTimer: null };
    if (kr.retryTimer) return;
    let ws;
    try { ws = new WebSocket(KRAKEN_WS); }
    catch (_) { scheduleKraken(); return; }
    kr.ws = ws;
    kr.open = false;
    ws.onopen = () => {
        kr.open = true;
        kr.retryMs = 1000;
        for (const p of kr.pairs) if (!kr.bad.has(p)) subscribeKraken(p);
    };
    ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m?.channel === 'ticker' && Array.isArray(m.data)) {
            for (const d of m.data) {
                const b = String(d?.symbol || '').replace(/\/USD$/, '');
                const e = subs.get(b);
                const price = Number(d?.last);
                if (e && Number.isFinite(price) && price > 0) emit(b, e, price, 'kraken');
            }
        } else if (m?.method === 'subscribe' && m.success === false && m.symbol) {
            // "Currency pair not supported NOPE/USD": stop asking for it this session.
            kr.bad.add(String(m.symbol));
        }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
        kr.open = false;
        kr.ws = null;
        if ([...subs.values()].some(x => x.venue === 'kraken')) scheduleKraken();
    };
}

function scheduleKraken() {
    if (kr.retryTimer) return;
    kr.retryTimer = setTimeout(() => { kr.retryTimer = null; ensureKraken(); }, kr.retryMs);
    kr.retryMs = Math.min(kr.retryMs * 2, MAX_BACKOFF_MS);
}
