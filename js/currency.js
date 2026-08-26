// Currency conversion layer — multi-currency, no hardcoded pair list.
//
// Architecture:
//   - One module, one source of truth.
//   - format(value, opts) is the only function the rest of the app calls.
//   - setMode(code) flips a localStorage flag and emits a 'currency-change' event.
//   - A MutationObserver re-renders any element carrying data-usd="<n>" so
//     newly-rendered dynamic content (Mia replies, lazy hot picks, etc.)
//     also picks up the active currency without each render site knowing.
//
// FX source: Frankfurter.app (free, key-less, ECB-backed daily rates).
//   - Endpoint: https://api.frankfurter.dev/v1/latest?from=USD
//     The unversioned /latest path now returns 404; Frankfurter moved to
//     /v1/. Verified live: /latest -> 404, /v1/latest -> 200. This failed
//     silently because the fetch error path just falls back to no conversion.
//   - Returns { rates: { EUR: 0.92, GBP: 0.79, INR: 83.5, ... } }
//   - One fetch, all rates cached for 1h.
// Fallback: Yahoo USDINR=X path retained for INR-only compatibility
// when Frankfurter is down (rare).

import { fetchWithProxy } from './data.js';

const MODE_KEY = 'ma-currency-mode';
const RATE_KEY = 'ma-fx-rates-v2';
const RATE_TTL_MS = 60 * 60 * 1000; // 1h

const LISTENERS = new Set();

let cachedRates = null; // { base: 'USD', rates: { INR: 83.5, EUR: 0.92, ... }, ts }
let inflightFetch = null;

// All supported display currencies. Each entry has the ISO code,
// display symbol, and a friendly name. The Frankfurter API supplies
// rates for all of these. Currencies appear in the settings dropdown
// in this exact order.
export const SUPPORTED_CURRENCIES = [
    { code: 'USD', symbol: '$',    name: 'US Dollar' },
    { code: 'EUR', symbol: '€',    name: 'Euro' },
    { code: 'GBP', symbol: '£',    name: 'British Pound' },
    { code: 'JPY', symbol: '¥',    name: 'Japanese Yen' },
    { code: 'INR', symbol: '₹',    name: 'Indian Rupee' },
    { code: 'CNY', symbol: '¥',    name: 'Chinese Yuan' },
    { code: 'AUD', symbol: 'A$',   name: 'Australian Dollar' },
    { code: 'CAD', symbol: 'C$',   name: 'Canadian Dollar' },
    { code: 'CHF', symbol: 'CHF ', name: 'Swiss Franc' },
    { code: 'HKD', symbol: 'HK$',  name: 'Hong Kong Dollar' },
    { code: 'SGD', symbol: 'S$',   name: 'Singapore Dollar' },
    { code: 'KRW', symbol: '₩',    name: 'South Korean Won' },
    { code: 'BRL', symbol: 'R$',   name: 'Brazilian Real' },
    { code: 'MXN', symbol: 'MX$',  name: 'Mexican Peso' },
    { code: 'NZD', symbol: 'NZ$',  name: 'New Zealand Dollar' },
    { code: 'SEK', symbol: 'kr',   name: 'Swedish Krona' },
    { code: 'NOK', symbol: 'kr',   name: 'Norwegian Krone' },
    { code: 'ZAR', symbol: 'R',    name: 'South African Rand' },
];

const SYMBOL_MAP = Object.fromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, c.symbol]));
const NAME_MAP = Object.fromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, c.name]));
const SUPPORTED_CODES = SUPPORTED_CURRENCIES.map(c => c.code);

export function getMode() {
    try {
        const stored = localStorage.getItem(MODE_KEY);
        return SUPPORTED_CODES.includes(stored) ? stored : 'USD';
    } catch (_) { return 'USD'; }
}

export function setMode(code) {
    if (!SUPPORTED_CODES.includes(code)) return;
    try { localStorage.setItem(MODE_KEY, code); } catch (_) {}
    LISTENERS.forEach(fn => { try { fn(code); } catch (_) {} });
    document.dispatchEvent(new CustomEvent('currency-change', { detail: { mode: code } }));
    rerenderAll();
}

export function onCurrencyChange(fn) { LISTENERS.add(fn); }

export function getCurrencyName(code) { return NAME_MAP[code] || code; }
export function getCurrencySymbol(code) { return SYMBOL_MAP[code] || (code ? code + ' ' : ''); }

/**
 * Toggle to NEXT currency in the supported list. Cycles back to start
 * after the last. Used by the in-app keyboard shortcut and by any
 * caller that doesn't have a specific target currency.
 */
export async function toggle() {
    const cur = getMode();
    const idx = SUPPORTED_CODES.indexOf(cur);
    const next = SUPPORTED_CODES[(idx + 1) % SUPPORTED_CODES.length];
    if (next !== 'USD' && !cachedRates?.rates?.[next]) {
        try { await fetchRates(); } catch (_) {}
    }
    setMode(next);
}

function loadCachedRates() {
    if (cachedRates) return cachedRates;
    try {
        const raw = localStorage.getItem(RATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.base === 'USD' && parsed.rates && typeof parsed.ts === 'number') {
            cachedRates = parsed;
            return parsed;
        }
    } catch (_) {}
    return null;
}

function saveCachedRates(rates) {
    cachedRates = rates;
    try { localStorage.setItem(RATE_KEY, JSON.stringify(rates)); } catch (_) {}
}

export async function fetchRates(force = false) {
    if (!force) {
        const c = loadCachedRates();
        if (c && Date.now() - c.ts < RATE_TTL_MS) return c;
    }
    if (inflightFetch) return inflightFetch;
    inflightFetch = (async () => {
        try {
            // Frankfurter.app: free, ECB-backed, all major currencies in one call.
            const symbols = SUPPORTED_CODES.filter(c => c !== 'USD').join(',');
            const url = `https://api.frankfurter.dev/v1/latest?from=USD&to=${symbols}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
            const json = await res.json();
            if (!json.rates) throw new Error('no rates in response');
            const v = { base: 'USD', rates: { ...json.rates, USD: 1 }, ts: Date.now() };
            saveCachedRates(v);
            return v;
        } catch (e) {
            // Yahoo INR fallback so INR mode still works if Frankfurter is down.
            try {
                const res = await fetchWithProxy('https://query2.finance.yahoo.com/v8/finance/chart/USDINR=X?range=1d&interval=1d');
                const json = await res.json();
                const meta = json?.chart?.result?.[0]?.meta;
                const rate = meta?.regularMarketPrice;
                if (typeof rate === 'number' && rate > 0) {
                    const v = { base: 'USD', rates: { USD: 1, INR: rate }, ts: Date.now() };
                    saveCachedRates(v);
                    return v;
                }
            } catch (_) {}
            // Last resort: keep stale cache if any.
            if (cachedRates) return cachedRates;
            throw e;
        } finally {
            inflightFetch = null;
        }
    })();
    return inflightFetch;
}

export function getRates() { return loadCachedRates(); }

// Convert from `srcCurrency` to `dstCurrency` via the USD-base rates.
// Returns null if either rate is missing.
function convert(value, srcCurrency, dstCurrency, ratesObj) {
    if (srcCurrency === dstCurrency) return value;
    if (!ratesObj?.rates) return null;
    const fromRate = ratesObj.rates[srcCurrency];
    const toRate = ratesObj.rates[dstCurrency];
    if (fromRate == null || toRate == null) return null;
    // value is in srcCurrency. To USD: divide by fromRate. To dst: multiply by toRate.
    const valueInUsd = value / fromRate;
    return valueInUsd * toRate;
}

/**
 * Format a value as currency text in the active display mode.
 * srcCurrency = native currency of the input value (default USD).
 *
 * Display logic:
 *   - srcCurrency == display mode → no conversion, render with mode's symbol
 *   - both supported with cached rates → convert via FX
 *   - srcCurrency unsupported (no FX rate) → render in native (don't fabricate)
 */
export function format(value, opts = {}) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const num = Number(value);
    const mode = getMode();
    const src = (opts.srcCurrency || 'USD').toUpperCase();
    const r = loadCachedRates();
    const digits = (n) => opts.digits ?? (Math.abs(n) < 1 ? 4 : 2);
    const localeFor = (code) => code === 'INR' ? 'en-IN' : 'en-US';

    // No conversion path: src == mode.
    if (src === mode) {
        return getCurrencySymbol(mode) + num.toLocaleString(localeFor(mode), {
            minimumFractionDigits: digits(num),
            maximumFractionDigits: digits(num),
        });
    }
    // Supported pair with cached rates: convert.
    if (r && r.rates[src] != null && r.rates[mode] != null) {
        const converted = convert(num, src, mode, r);
        if (Number.isFinite(converted)) {
            return getCurrencySymbol(mode) + converted.toLocaleString(localeFor(mode), {
                minimumFractionDigits: digits(converted),
                maximumFractionDigits: digits(converted),
            });
        }
    }
    // Unsupported source currency (rate missing): render in native.
    return getCurrencySymbol(src) + num.toLocaleString('en-US', {
        minimumFractionDigits: digits(num),
        maximumFractionDigits: digits(num),
    });
}

/**
 * Mark up an element so the MutationObserver-based rerender flips it on toggle.
 * Returns the markup. Used by render functions that produce HTML strings.
 */
export function priceTag(value, opts = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '<span class="price" data-usd="">—</span>';
    const src = (opts.srcCurrency || 'USD').toUpperCase();
    const txt = format(n, opts);
    return `<span class="price" data-usd="${n}" data-src="${src}">${txt}</span>`;
}

function rerenderAll() {
    document.querySelectorAll('[data-usd]').forEach(el => {
        const value = parseFloat(el.getAttribute('data-usd'));
        const src = el.getAttribute('data-src') || 'USD';
        if (Number.isFinite(value)) el.textContent = format(value, { srcCurrency: src });
    });
}

export function initCurrency() {
    fetchRates().catch(() => {});
    if (getMode() !== 'USD') {
        setTimeout(() => rerenderAll(), 1500);
    }
}
