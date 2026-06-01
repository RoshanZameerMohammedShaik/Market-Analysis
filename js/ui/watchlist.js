// Watchlist + signal-flip alerts.
//
// Lightweight design: a localStorage-stored set of symbols plus a
// background poller that re-fetches the daily ledger and notifies the
// user when any watched symbol's signal differs from the last seen
// value. Notifications use the browser Notifications API, which works
// while the tab is open without a service worker.
//
// The user gets:
//   - a star button on the chart header to toggle watch on the current symbol
//   - a panel showing all watched symbols with their current signal/conf
//   - browser notifications when a watched signal changes (BUY → SELL,
//     NEUTRAL → BUY, etc.) — only fires once per change
//
// The watchlist is persisted in localStorage; alerts only trigger
// while the tab is open. Future upgrade: replace polling + browser
// notifications with a service worker + Web Push when we want
// background alerts.
//
// Polling cadence: 5 min by default, matching the ledger cache TTL
// in scanner.js / ui-bridge.js. Cron writes ledger rows once at
// market open and once at outcome resolution time, so 5 min is
// plenty fresh.

import { initPriceAlerts, getAlert, setAlert, isCryptoSymbol, getLastPrice } from './price-alerts.js';

const LS_KEY = 'ma-watchlist-v1';
const LS_LAST_SEEN = 'ma-watchlist-last-seen-v1';
const POLL_MS = 5 * 60 * 1000;

let watchlist = new Set();
let lastSeenSignal = {}; // { symbol: 'BUY' }
let pollHandle = null;

function loadWatchlist() {
    try { watchlist = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch (_) { watchlist = new Set(); }
}
function saveWatchlist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify([...watchlist])); } catch (_) {}
}
function loadLastSeen() {
    try { lastSeenSignal = JSON.parse(localStorage.getItem(LS_LAST_SEEN) || '{}'); } catch (_) { lastSeenSignal = {}; }
}
function saveLastSeen() {
    try { localStorage.setItem(LS_LAST_SEEN, JSON.stringify(lastSeenSignal)); } catch (_) {}
}

export function isWatched(symbol) {
    return watchlist.has(String(symbol || '').toUpperCase());
}

// Snapshot of currently-watched symbols. Used by the prewarm path
// on app load to pull chart + analysis data into cache before the
// user clicks anything. Returns a copy so callers can iterate
// without worrying about mutation mid-loop.
export function getWatchlistSymbols() {
    // Read fresh from localStorage in case another tab updated it.
    try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
        return raw.map(s => String(s).toUpperCase());
    } catch (_) {
        return [...watchlist];
    }
}

export function toggleWatch(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return false;
    if (watchlist.has(sym)) watchlist.delete(sym);
    else watchlist.add(sym);
    saveWatchlist();
    refreshUI();
    return watchlist.has(sym);
}

async function loadLedger() {
    const year = new Date().getUTCFullYear();
    try {
        const res = await fetch(`./model/ledger/${year}.jsonl?t=${Math.floor(Date.now() / POLL_MS)}`);
        if (!res.ok) return [];
        const text = await res.text();
        const rows = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { rows.push(JSON.parse(t)); } catch (_) {}
        }
        return rows;
    } catch (_) { return []; }
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

async function getCurrentSignals() {
    const rows = await loadLedger();
    const today = todayIso();
    let scoped = rows.filter(r => r.date === today);
    if (!scoped.length) {
        const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
        if (dates.length) scoped = rows.filter(r => r.date === dates[0]);
    }
    const map = {};
    for (const r of scoped) {
        if (watchlist.has(String(r.symbol).toUpperCase())) {
            map[r.symbol.toUpperCase()] = {
                symbol: r.symbol,
                signal: r.signal,
                confidence: r.confidence,
                entry: r.entry,
                date: r.date,
                region: r.region,
            };
        }
    }
    return map;
}

function notifyChange(sym, oldSig, newSig, conf) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
        const body = `${oldSig || 'unknown'} → ${newSig} @ ${conf}% confidence`;
        new Notification(`Market Analyzer · ${sym}`, {
            body,
            tag: `ma-watch-${sym}`,
            silent: false,
        });
    } catch (_) {}
}

async function pollOnce() {
    if (!watchlist.size) return;
    const cur = await getCurrentSignals();
    let any = false;
    for (const [sym, info] of Object.entries(cur)) {
        const last = lastSeenSignal[sym];
        if (last !== info.signal) {
            // First time we see the symbol after subscribing also fires —
            // that's fine, it shows current state. Subsequent runs only
            // notify on actual changes.
            if (last !== undefined) notifyChange(sym, last, info.signal, info.confidence);
            lastSeenSignal[sym] = info.signal;
            any = true;
        }
    }
    if (any) saveLastSeen();
    refreshUI(cur);
}

function startPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(pollOnce, POLL_MS);
    pollOnce();
}

function refreshUI(currentSignalsMap = null) {
    refreshStarButton();
    refreshPanel(currentSignalsMap);
}

function refreshStarButton() {
    const btn = document.getElementById('watch-toggle');
    if (!btn) return;
    const sym = btn.dataset.symbol || '';
    const watched = isWatched(sym);
    btn.classList.toggle('watching', watched);
    btn.title = watched ? 'Remove from watchlist' : 'Add to watchlist';
    btn.innerHTML = watched
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15 9 22 9 17 14 19 22 12 17 5 22 7 14 2 9 9 9 12 2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><polygon points="12 2 15 9 22 9 17 14 19 22 12 17 5 22 7 14 2 9 9 9 12 2"/></svg>';
}

function refreshPanel(currentSignalsMap) {
    const list = document.getElementById('watchlist-list');
    if (!list) return;
    if (!watchlist.size) {
        list.innerHTML = '<div class="watchlist-empty">No symbols watched yet. Star a stock or crypto to track its signal.</div>';
        return;
    }
    const arr = [...watchlist].sort();
    const cur = currentSignalsMap || {};
    list.innerHTML = arr.map(sym => {
        const info = cur[sym];
        const alertHtml = renderAlertRow(sym);
        if (!info) {
            return `
                <div class="watchlist-item" data-symbol="${sym}">
                    <div class="watchlist-row-main">
                        <span class="watchlist-symbol">${sym}</span>
                        <span class="watchlist-meta">no ledger data today</span>
                        <button class="watchlist-remove" data-symbol="${sym}" title="Remove">✕</button>
                    </div>
                    ${alertHtml}
                </div>`;
        }
        const sigClass = (info.signal || 'NEUTRAL').toLowerCase();
        const sigLabel = info.signal === 'NO_TRADE' ? 'NO TRADE' : info.signal;
        return `
            <div class="watchlist-item" data-symbol="${sym}">
                <div class="watchlist-row-main">
                    <span class="watchlist-symbol">${sym}</span>
                    <span class="watchlist-sig sig-${sigClass}">${sigLabel}</span>
                    <span class="watchlist-conf">${info.confidence}%</span>
                    <button class="watchlist-remove" data-symbol="${sym}" title="Remove">✕</button>
                </div>
                ${alertHtml}
            </div>`;
    }).join('');
}

// Render the per-symbol price-alert section. Crypto symbols get a real
// form (above / below price inputs + live price tick); non-crypto get a
// short note explaining why realtime isn't available on the free path.
function renderAlertRow(sym) {
    if (!isCryptoSymbol(sym)) {
        return `
            <div class="watchlist-alert-row stocks-disabled">
                <span class="watchlist-alert-note">Realtime price alerts available on crypto only — free stock-data feeds are 5–15 min delayed.</span>
            </div>`;
    }
    const a = getAlert(sym) || {};
    const live = getLastPrice(sym);
    const livePart = live != null
        ? `<span class="watchlist-live-price" data-symbol="${sym}">$${formatPrice(live)}</span>`
        : `<span class="watchlist-live-price waiting" data-symbol="${sym}">waiting…</span>`;
    return `
        <div class="watchlist-alert-row" data-symbol="${sym}">
            ${livePart}
            <label class="watchlist-alert-field">
                <span>Above</span>
                <input type="number" inputmode="decimal" step="any" min="0" class="watchlist-alert-input" data-direction="above" data-symbol="${sym}" placeholder="—" value="${a.above != null ? a.above : ''}">
            </label>
            <label class="watchlist-alert-field">
                <span>Below</span>
                <input type="number" inputmode="decimal" step="any" min="0" class="watchlist-alert-input" data-direction="below" data-symbol="${sym}" placeholder="—" value="${a.below != null ? a.below : ''}">
            </label>
        </div>`;
}

// Adaptive precision: prices > $1000 show as integer-friendly; small-cap
// alts down to fractions of a cent need lots of decimals to be useful.
function formatPrice(p) {
    if (!Number.isFinite(p)) return '—';
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(3);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(8);
}

function ensureWatchlistPanel() {
    if (document.getElementById('watchlist-panel')) return;
    // Slot the panel after the scanner section so it lives in the same
    // power-user zone of the page and doesn't fight the chart for space.
    const after = document.getElementById('scanner-section') || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="watchlist-section" id="watchlist-section">
            <details class="watchlist-details">
                <summary class="watchlist-summary">
                    <span class="watchlist-title">⭐ Watchlist</span>
                    <span class="watchlist-hint">Get notified when a watched signal flips</span>
                </summary>
                <div class="watchlist-controls">
                    <button class="watchlist-perm-btn" id="watchlist-perm-btn">Enable browser notifications</button>
                    <span class="watchlist-perm-state" id="watchlist-perm-state"></span>
                </div>
                <div class="watchlist-list" id="watchlist-list"></div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);
    document.getElementById('watchlist-perm-btn').addEventListener('click', requestPermission);
    const listEl = document.getElementById('watchlist-list');
    listEl.addEventListener('click', (e) => {
        // Don't navigate when the user is interacting with the alert form.
        if (e.target.closest('.watchlist-alert-row')) return;
        const rm = e.target.closest('.watchlist-remove');
        if (rm) { e.stopPropagation(); toggleWatch(rm.dataset.symbol); return; }
        const item = e.target.closest('.watchlist-item');
        if (item) {
            const sym = item.dataset.symbol;
            const input = document.getElementById('search-input');
            if (input) {
                input.value = sym;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                setTimeout(() => {
                    document.querySelector(`.search-result-item[data-symbol="${sym}"]`)?.click();
                }, 400);
            }
        }
    });
    // Alert-input change handler: write through to the price-alerts module
    // immediately on change. WebSocket connection is opened/closed inside
    // setAlert based on whether any threshold is set.
    listEl.addEventListener('change', (e) => {
        const input = e.target.closest('.watchlist-alert-input');
        if (!input) return;
        const sym = input.dataset.symbol;
        const above = listEl.querySelector(`.watchlist-alert-input[data-direction="above"][data-symbol="${sym}"]`);
        const below = listEl.querySelector(`.watchlist-alert-input[data-direction="below"][data-symbol="${sym}"]`);
        const aboveVal = above && above.value !== '' ? parseFloat(above.value) : null;
        const belowVal = below && below.value !== '' ? parseFloat(below.value) : null;
        setAlert(sym, { above: aboveVal, below: belowVal });
        if ((aboveVal != null || belowVal != null) && 'Notification' in window && Notification.permission === 'default') {
            requestPermission();
        }
    });
    // Live price tick → patch the row's price label in place. Avoids
    // re-rendering the whole list (which would blow away the user's
    // half-typed threshold input).
    document.addEventListener('ma:price-tick', (e) => {
        const { symbol, price } = e.detail || {};
        const el = listEl.querySelector(`.watchlist-live-price[data-symbol="${symbol}"]`);
        if (!el) return;
        el.textContent = `$${formatPrice(price)}`;
        el.classList.remove('waiting');
    });
    // Alert fired → re-render so the threshold input shows blank and
    // any one-shot state is reflected.
    document.addEventListener('ma:price-alert-fired', () => {
        refreshUI();
    });
    refreshPermissionUI();
}

function requestPermission() {
    if (!('Notification' in window)) {
        alert('This browser does not support notifications.');
        return;
    }
    if (Notification.permission === 'granted') { refreshPermissionUI(); return; }
    Notification.requestPermission().then(refreshPermissionUI);
}

function refreshPermissionUI() {
    const btn = document.getElementById('watchlist-perm-btn');
    const state = document.getElementById('watchlist-perm-state');
    if (!btn || !state) return;
    if (!('Notification' in window)) {
        btn.disabled = true;
        state.textContent = 'Browser does not support notifications.';
        return;
    }
    if (Notification.permission === 'granted') {
        btn.style.display = 'none';
        state.textContent = '✓ Notifications enabled';
        state.classList.add('on');
    } else if (Notification.permission === 'denied') {
        btn.disabled = true;
        state.textContent = 'Notifications blocked by browser settings.';
    } else {
        btn.style.display = '';
        state.textContent = 'Click to allow signal-flip alerts.';
    }
}

// Wires the star button into the chart header. Called from chart.js
// every time a new symbol is loaded so the button reflects the right
// state and acts on the right symbol.
export function attachWatchButton(symbol) {
    const headerEl = document.getElementById('chart-header');
    if (!headerEl) return;
    let btn = document.getElementById('watch-toggle');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'watch-toggle';
        btn.className = 'watch-toggle';
        btn.addEventListener('click', () => {
            const s = btn.dataset.symbol;
            if (!s) return;
            const watched = toggleWatch(s);
            // First-time toggle: prompt for notification permission so the
            // user gets useful alerts. Idempotent if already granted/denied.
            if (watched && 'Notification' in window && Notification.permission === 'default') {
                requestPermission();
            }
            ensureWatchlistPanel();
        });
        headerEl.appendChild(btn);
    }
    btn.dataset.symbol = String(symbol || '').toUpperCase();
    refreshStarButton();
}

export function initWatchlist() {
    loadWatchlist();
    loadLastSeen();
    initPriceAlerts();
    ensureWatchlistPanel();
    refreshUI();
    startPolling();
}
