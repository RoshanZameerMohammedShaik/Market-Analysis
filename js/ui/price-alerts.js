// Realtime price-threshold alerts (crypto only).
//
// Why crypto-only: free stock-data sources (Yahoo, Stooq) are 5-15 min
// delayed because real-time exchange feeds are licensed. A 15-min-late
// price alert for a market that moves second-by-second is worse than
// useless — it would tell users about moves that already played out.
// Crypto, by contrast, has Binance's public WebSocket which is true
// realtime and free. So this module covers the case where realtime
// is achievable and honestly omits where it isn't.
//
// Architecture:
//   - localStorage holds per-symbol thresholds: { "BTC-USD": {above, below} }
//   - One WebSocket per active alert; auto-reconnect with backoff.
//   - Each tick, compare against thresholds; fire Notification on cross
//     and clear that direction (one-shot — you don't want a $-1 dip
//     re-firing every tick).
//   - The watchlist UI gets a small inline "alert at" form for crypto
//     rows; stocks see a hint explaining why they're unsupported.
//
// Stays open as long as the tab is open. No service worker — closing
// the tab also closes the WS, and the alert won't fire. That matches
// the existing watchlist's tab-open-only model.

const LS_KEY = 'ma-price-alerts-v1';

// { "BTC-USD": { above: 75000, below: null } }
let alerts = {};
const sockets = new Map(); // symbol -> { ws, retryMs, retryTimer }
const lastPrices = new Map();

function loadAlerts() {
    try { alerts = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; }
    catch (_) { alerts = {}; }
}
function saveAlerts() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(alerts)); } catch (_) {}
}

export function isCryptoSymbol(symbol) {
    return /-USD$/i.test(String(symbol || ''));
}

// Yahoo-style "BTC-USD" → Binance "btcusdt". Returns null for symbols
// Binance doesn't carry (e.g., niche tokens that aren't on Binance Spot).
// We map only the common ones; the rest fail gracefully and the user
// is told the symbol isn't supported for realtime alerts.
function toBinanceStream(symbol) {
    const s = String(symbol || '').toUpperCase();
    const m = s.match(/^([A-Z0-9]+)-USD$/);
    if (!m) return null;
    const base = m[1].toLowerCase();
    return `${base}usdt@trade`;
}

export function getAlert(symbol) {
    return alerts[String(symbol || '').toUpperCase()] || null;
}

export function setAlert(symbol, { above = null, below = null } = {}) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return;
    const a = { above: above != null ? Number(above) : null, below: below != null ? Number(below) : null };
    if (a.above == null && a.below == null) {
        delete alerts[sym];
    } else {
        alerts[sym] = a;
    }
    saveAlerts();
    if (alerts[sym]) connectSocket(sym);
    else closeSocket(sym);
}

export function clearAlert(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!alerts[sym]) return;
    delete alerts[sym];
    saveAlerts();
    closeSocket(sym);
}

export function getLastPrice(symbol) {
    return lastPrices.get(String(symbol || '').toUpperCase()) ?? null;
}

function notify(symbol, direction, price, threshold) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
        const arrow = direction === 'above' ? '↑' : '↓';
        new Notification(`Market Analyzer · ${symbol} ${arrow} $${price}`, {
            body: `Crossed ${direction} threshold $${threshold}`,
            tag: `ma-price-${symbol}-${direction}`,
            silent: false,
        });
    } catch (_) {}
}

function evaluate(symbol, price) {
    const a = alerts[symbol];
    if (!a) return;
    let changed = false;
    if (a.above != null && price >= a.above) {
        notify(symbol, 'above', price, a.above);
        a.above = null; // one-shot — clear so it doesn't re-fire on every tick
        changed = true;
    }
    if (a.below != null && price <= a.below) {
        notify(symbol, 'below', price, a.below);
        a.below = null;
        changed = true;
    }
    if (changed) {
        // If both directions cleared, drop the entry entirely; otherwise
        // persist the partial state. UI will re-render to reflect it.
        if (a.above == null && a.below == null) delete alerts[symbol];
        saveAlerts();
        // Re-render the watchlist row so the user sees the alert disarm.
        document.dispatchEvent(new CustomEvent('ma:price-alert-fired', { detail: { symbol, price } }));
        // If no thresholds remain on this symbol, close the socket too.
        if (!alerts[symbol]) closeSocket(symbol);
    }
}

function connectSocket(symbol) {
    const stream = toBinanceStream(symbol);
    if (!stream) return; // unsupported symbol — UI surfaces this
    if (sockets.has(symbol)) return;

    const entry = { ws: null, retryMs: 1000, retryTimer: null };
    sockets.set(symbol, entry);

    const open = () => {
        const url = `wss://stream.binance.com:9443/ws/${stream}`;
        let ws;
        try { ws = new WebSocket(url); }
        catch (_) { scheduleRetry(); return; }

        entry.ws = ws;

        ws.onopen = () => { entry.retryMs = 1000; };
        ws.onmessage = (ev) => {
            try {
                const m = JSON.parse(ev.data);
                // @trade event fields: p = price (string), q = qty, T = trade time
                const price = parseFloat(m.p);
                if (!Number.isFinite(price)) return;
                lastPrices.set(symbol, price);
                document.dispatchEvent(new CustomEvent('ma:price-tick', { detail: { symbol, price } }));
                evaluate(symbol, price);
            } catch (_) {}
        };
        ws.onerror = () => { /* onclose will fire next */ };
        ws.onclose = () => {
            entry.ws = null;
            // If we still have alerts on this symbol, retry. Otherwise let go.
            if (alerts[symbol]) scheduleRetry();
            else sockets.delete(symbol);
        };
    };

    const scheduleRetry = () => {
        if (!alerts[symbol]) return;
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout(() => { entry.retryTimer = null; open(); }, entry.retryMs);
        // Cap backoff at 30s so a long outage doesn't end up waiting hours.
        entry.retryMs = Math.min(entry.retryMs * 2, 30_000);
    };

    open();
}

function closeSocket(symbol) {
    const entry = sockets.get(symbol);
    if (!entry) return;
    sockets.delete(symbol);
    if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
    if (entry.ws) {
        try { entry.ws.onclose = null; entry.ws.close(); } catch (_) {}
    }
}

export function initPriceAlerts() {
    loadAlerts();
    // Reopen any sockets for alerts that survived from a previous session.
    for (const sym of Object.keys(alerts)) {
        connectSocket(sym);
    }
}

export function listAlerts() {
    return { ...alerts };
}
