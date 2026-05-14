// Currency conversion layer. Owns USD↔INR live FX rate, mode toggle, and formatting.
//
// Architecture:
//   - One module, one source of truth.
//   - format(usd) is the only function the rest of the app calls.
//   - Toggle flips a localStorage flag and emits a 'currency-change' event.
//   - A MutationObserver re-renders any element carrying data-usd="<n>" so
//     newly-rendered dynamic content (Mia replies, lazy hot picks, etc.)
//     also picks up the active currency without each render site knowing.
//
// FX source: Yahoo's free USDINR=X chart endpoint via the existing CORS proxy.
// Cached 1h. Acceptable for a free retail tool; surfaced in the tooltip.

import { fetchWithProxy } from './data.js';

const MODE_KEY = 'ma-currency-mode';
const RATE_KEY = 'ma-fx-rate';
const RATE_TTL_MS = 60 * 60 * 1000; // 1h

const LISTENERS = new Set();

let cachedRate = null; // { usdToInr, ts }
let inflightFetch = null;

export function getMode() {
    try { return localStorage.getItem(MODE_KEY) === 'INR' ? 'INR' : 'USD'; } catch (_) { return 'USD'; }
}
function setMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode === 'INR' ? 'INR' : 'USD'); } catch (_) {}
    LISTENERS.forEach(fn => { try { fn(mode); } catch (_) {} });
    document.dispatchEvent(new CustomEvent('currency-change', { detail: { mode } }));
    rerenderAll();
}

export function onCurrencyChange(fn) { LISTENERS.add(fn); }

export async function toggle() {
    const next = getMode() === 'USD' ? 'INR' : 'USD';
    if (next === 'INR' && !cachedRate) {
        try { await fetchRate(); } catch (_) { /* fall through; will display USD */ }
    }
    setMode(next);
}

function loadCachedRate() {
    if (cachedRate) return cachedRate;
    try {
        const raw = localStorage.getItem(RATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.usdToInr === 'number' && typeof parsed.ts === 'number') {
            cachedRate = parsed;
            return parsed;
        }
    } catch (_) {}
    return null;
}

function saveCachedRate(rate) {
    cachedRate = rate;
    try { localStorage.setItem(RATE_KEY, JSON.stringify(rate)); } catch (_) {}
}

export async function fetchRate(force = false) {
    if (!force) {
        const c = loadCachedRate();
        if (c && Date.now() - c.ts < RATE_TTL_MS) return c;
    }
    if (inflightFetch) return inflightFetch;
    inflightFetch = (async () => {
        try {
            const res = await fetchWithProxy('https://query2.finance.yahoo.com/v8/finance/chart/USDINR=X?range=1d&interval=1d');
            const json = await res.json();
            const meta = json?.chart?.result?.[0]?.meta;
            const rate = meta?.regularMarketPrice;
            if (typeof rate === 'number' && rate > 0) {
                const v = { usdToInr: rate, ts: Date.now() };
                saveCachedRate(v);
                return v;
            }
            throw new Error('no rate in response');
        } catch (e) {
            // Fall back to last cached if any, even stale.
            if (cachedRate) return cachedRate;
            throw e;
        } finally {
            inflightFetch = null;
        }
    })();
    return inflightFetch;
}

export function getRate() {
    return loadCachedRate();
}

/**
 * Format a USD numeric value as currency text, in the active mode.
 * Returns e.g. "$298.87" or "₹24,870.91" depending on toggle state.
 */
export function format(usd, opts = {}) {
    if (usd == null || !Number.isFinite(Number(usd))) return '—';
    const num = Number(usd);
    const mode = getMode();
    if (mode === 'INR') {
        const r = loadCachedRate();
        if (r && r.usdToInr) {
            const inr = num * r.usdToInr;
            return '₹' + inr.toLocaleString('en-IN', {
                minimumFractionDigits: opts.digits ?? (Math.abs(inr) < 1 ? 4 : 2),
                maximumFractionDigits: opts.digits ?? (Math.abs(inr) < 1 ? 4 : 2),
            });
        }
        // INR mode requested but no rate cached — fall through to USD with marker.
    }
    return '$' + num.toLocaleString('en-US', {
        minimumFractionDigits: opts.digits ?? (Math.abs(num) < 1 ? 4 : 2),
        maximumFractionDigits: opts.digits ?? (Math.abs(num) < 1 ? 4 : 2),
    });
}

/**
 * Mark up an element so the MutationObserver-based rerender flips it on toggle.
 * Returns the markup. Used by render functions that produce HTML strings.
 */
export function priceTag(usd, opts = {}) {
    const n = Number(usd);
    if (!Number.isFinite(n)) return '<span class="price" data-usd="">—</span>';
    const txt = format(n, opts);
    return `<span class="price" data-usd="${n}">${txt}</span>`;
}

// Rerender every node previously tagged with data-usd. Cheap; runs only on toggle.
function rerenderAll() {
    document.querySelectorAll('[data-usd]').forEach(el => {
        const usd = parseFloat(el.getAttribute('data-usd'));
        if (Number.isFinite(usd)) el.textContent = format(usd);
    });
}

// Initial setup: warm the rate cache lazily so the first toggle to INR is instant.
export function initCurrency() {
    // Pre-fetch in background. If it fails, we fall back gracefully on toggle.
    fetchRate().catch(() => {});
    // If user already had INR mode last session, surface formatted prices once cached.
    if (getMode() === 'INR') {
        // Wait briefly for the first fetch then rerender.
        setTimeout(() => rerenderAll(), 1500);
    }
}
