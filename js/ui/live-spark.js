// Live-ticking sparklines for Hot Picks cards.
//
// CRYPTO ONLY — and deliberately so. Binance's public WebSocket gives
// true real-time crypto trades for free; stock feeds on the free path
// (Stooq / Yahoo) are 5–15 min delayed, so animating a stock sparkline
// tick-by-tick would be faking liveness. We honour the same honesty
// line the price-alerts module draws.
//
// For each visible crypto card we:
//   1. seed a rolling price buffer from the card's existing _sparkline,
//   2. subscribe to the symbol's Binance trade stream,
//   3. on each tick push the price (capped buffer), redraw the inline
//      sparkline SVG, and update the "Current Price" label in place,
//   4. briefly flash the card so the tick is perceptible.
//
// Subscriptions are torn down + rebuilt whenever the visible card set
// changes (mode switch, penny filter, re-scan) so we never leak sockets.

import { subscribe } from '../portfolio/pricing.js';
import { sparkline } from './sparkline.js';
import { state } from './state.js';

const MAX_POINTS = 40;          // rolling window length
const REDRAW_THROTTLE_MS = 600; // cap redraws so high-volume pairs don't thrash

// symbol -> { handle, buffer, lastDraw, lastPrice }
const active = new Map();

function cardSymbolToPair(cardSymbol) {
    // Hot Picks crypto cards carry the bare ticker ("BTC"); the pricing
    // layer + Binance want "BTC-USD".
    const s = String(cardSymbol || '').toUpperCase();
    if (!s) return null;
    return /-USD$/.test(s) ? s : `${s}-USD`;
}

// Redraw one card's sparkline + price label from its rolling buffer.
function paintCard(card, buffer, price) {
    const sparkHost = card.querySelector('.hot-pick-spark');
    if (sparkHost && buffer.length > 1) {
        sparkHost.innerHTML = sparkline(buffer);
    }
    const priceValue = card.querySelector('.hot-pick-current-price .hot-pick-target-value');
    if (priceValue && Number.isFinite(price)) {
        // Adaptive precision — alts can be sub-cent. Keep it dependency
        // -free here (no currency FX) because crypto cards are USD-native
        // and this is a live overlay, not the canonical render.
        const txt = price >= 1000 ? price.toFixed(2)
            : price >= 1 ? price.toFixed(3)
            : price >= 0.01 ? price.toFixed(5)
            : price.toFixed(8);
        priceValue.textContent = `$${txt}`;
    }
    // Perceptible tick flash.
    card.classList.remove('spark-tick');
    void card.offsetWidth;
    card.classList.add('spark-tick');
}

// Tear down every active subscription. Called before re-binding to a
// new card set and on mode switch away from crypto.
export function stopLiveSparks() {
    for (const [, entry] of active) {
        try { entry.handle?.close(); } catch (_) {}
    }
    active.clear();
}

// Bind live sparklines to every crypto card currently inside `grid`.
// Idempotent per symbol: re-binding the same visible set reuses the
// existing buffer/socket. Symbols no longer visible are unsubscribed.
export function bindLiveSparks(grid) {
    if (!grid) return;
    // Live ticking is CRYPTO-ONLY: stocks have no real-time feed on the
    // free path. Crucially, we must gate on the actual app MODE, not on
    // the symbol shape — appending "-USD" to a stock ticker (VERA →
    // VERA-USD) would otherwise look "crypto" and wrongly open a Binance
    // socket for every stock card. In stock mode we tear down and bail.
    if (state.mode !== 'crypto') { stopLiveSparks(); return; }
    const cards = [...grid.querySelectorAll('.hot-pick-card')];
    const seen = new Set();

    for (const card of cards) {
        const rawSym = card.dataset.symbol;
        // Only cards that carry a live-spark seed (emitted for crypto in
        // hotpicks.js) are eligible — a second guard behind the mode check.
        if (!card.dataset.spark) continue;
        const pair = cardSymbolToPair(rawSym);
        if (!pair) continue;
        seen.add(pair);

        if (active.has(pair)) {
            // Already streaming — repoint the entry at the (possibly new)
            // card node so redraws hit the on-screen element.
            active.get(pair).card = card;
            continue;
        }

        // Seed the rolling buffer from whatever sparkline data the card
        // was rendered with, so the first ticks extend a real line rather
        // than starting from a flat point.
        const seedAttr = card.dataset.spark;
        let buffer = [];
        if (seedAttr) {
            try { buffer = JSON.parse(decodeURIComponent(seedAttr)).slice(-MAX_POINTS); } catch (_) { buffer = []; }
        }

        const entry = { handle: null, buffer, lastDraw: 0, lastPrice: null, card };
        active.set(pair, entry);

        entry.handle = subscribe(pair, (price) => {
            if (!Number.isFinite(price)) return;
            entry.lastPrice = price;
            entry.buffer.push(price);
            if (entry.buffer.length > MAX_POINTS) entry.buffer.shift();
            const now = performance.now();
            if (now - entry.lastDraw < REDRAW_THROTTLE_MS) return;
            entry.lastDraw = now;
            // Card node may have been replaced by a surgical re-render;
            // re-resolve by symbol if our cached node is detached.
            let node = entry.card;
            if (!node || !node.isConnected) {
                node = grid.querySelector(`.hot-pick-card[data-symbol="${rawSym}"]`);
                entry.card = node;
            }
            if (node) paintCard(node, entry.buffer, price);
        });
        // subscribe() returns null for pairs Binance doesn't carry —
        // drop the entry so we don't hold a dead slot.
        if (!entry.handle) active.delete(pair);
    }

    // Unsubscribe any symbol that's no longer on screen.
    for (const [pair, entry] of [...active]) {
        if (!seen.has(pair)) {
            try { entry.handle?.close(); } catch (_) {}
            active.delete(pair);
        }
    }
}
