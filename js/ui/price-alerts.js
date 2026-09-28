// Realtime price-threshold alerts (crypto only).
//
// Why crypto-only: free stock-data sources (Yahoo, Stooq) are 5-15 min
// delayed because real-time exchange feeds are licensed. A 15-min-late
// price alert for a market that moves second-by-second is worse than
// useless — it would tell users about moves that already played out.
// Crypto, by contrast, has free public WebSocket trade feeds (Binance, or
// Coinbase where Binance refuses the connection, as it does for US users).
// So this module covers the case where realtime is achievable and
// honestly omits where it isn't.
//
// Architecture:
//   - localStorage holds per-symbol thresholds: { "BTC-USD": {above, below} }
//   - One live subscription per active alert (crypto-stream.js reconnects).
//   - Each tick, compare against thresholds; fire Notification on cross
//     and clear that direction (one-shot — you don't want a $-1 dip
//     re-firing every tick).
//   - The watchlist UI gets a small inline "alert at" form for crypto
//     rows; stocks see a hint explaining why they're unsupported.
//
// Stays open as long as the tab is open. No service worker — closing
// the tab also closes the WS, and the alert won't fire. That matches
// the existing watchlist's tab-open-only model.

import { streamCryptoPrice } from '../crypto-stream.js';

const LS_KEY = 'ma-price-alerts-v1';

// { "BTC-USD": { above: 75000, below: null } }
let alerts = {};
const sockets = new Map(); // symbol -> { handle } (see crypto-stream.js)
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
    if (sockets.has(symbol)) return;
    // Live trades via crypto-stream.js: Binance, falling back to Coinbase for US connections.
    const handle = streamCryptoPrice(symbol, (price) => {
        lastPrices.set(symbol, price);
        document.dispatchEvent(new CustomEvent('ma:price-tick', { detail: { symbol, price } }));
        evaluate(symbol, price);
    });
    if (!handle) return; // unsupported symbol — UI surfaces this
    sockets.set(symbol, { handle });
}

function closeSocket(symbol) {
    const entry = sockets.get(symbol);
    if (!entry) return;
    sockets.delete(symbol);
    try { entry.handle?.close(); } catch (_) {}
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
