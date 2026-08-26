// FX rates from Frankfurter (frankfurter.app). Free, no key, CORS-enabled,
// daily-refreshed European Central Bank reference rates. Sufficient
// accuracy for practice trading; FX moves slowly enough that ECB daily
// rates are within a fraction of a percent of intraday.
//
// We originally used Yahoo's chart endpoint but Yahoo blocks browser-
// direct fetches via CORS in production — every page open spammed
// CORS errors and silently broke the FX cache. Frankfurter is the
// drop-in replacement.
//
// Stored convention: rate = number of USD that 1 unit of `currency`
// is worth. EUR rate ~ 1.08 means 1 EUR = $1.08.
//
// Cached for 6 hours in localStorage. Daily-refresh source means
// hammering it more frequently buys nothing.

const CACHE_KEY = 'ma-fx-cache-v1';
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours — Frankfurter refreshes once a day

// Common currencies the dropdown will offer. Limited to what Frankfurter
// supports (ECB-published rates) — we dropped AED/SAR/CNY-from-the-old-
// Yahoo-list because Frankfurter doesn't carry them. Any 3-letter code
// passed in will still get a fetch attempt, but the dropdown surfaces
// only the ones we know work.
export const COMMON_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD',
    'CHF', 'CNY', 'HKD', 'SGD', 'KRW', 'BRL', 'MXN', 'NZD',
    'SEK', 'NOK', 'DKK', 'ZAR', 'TRY',
];

function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}
function saveCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (_) {}
}

// Returns the number of USD that 1 unit of `currency` is worth.
// USD always returns 1 immediately. Throws on fetch failure (caller can
// fall back to the cached value).
//
// Frankfurter API: GET https://api.frankfurter.dev/v1/latest?from=EUR&to=USD
// (api.frankfurter.app/latest 301-redirects to this; requesting the
//  canonical host directly avoids depending on redirect-following.)
// Response: { amount: 1, base: "EUR", date: "2026-05-29", rates: { USD: 1.0823 } }
// We always query "from=<currency>&to=USD" so the response's rates.USD
// is exactly the rate we want.
export async function getRateToUSD(currency) {
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return 1;

    const cache = loadCache();
    const hit = cache[cur];
    if (hit && (Date.now() - hit.t) < CACHE_MS) return hit.rate;

    const url = `https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(cur)}&to=USD`;
    let res;
    try {
        res = await fetch(url);
    } catch (e) {
        // Network error — return stale cache if we have one rather than
        // throwing. Practice-trading display can keep showing yesterday's
        // rate; the alternative (blocking the panel) is worse UX.
        if (hit) return hit.rate;
        throw e;
    }
    if (!res.ok) {
        if (hit) return hit.rate;
        throw new Error(`FX fetch failed: ${res.status}`);
    }
    const data = await res.json();
    const rate = data?.rates?.USD;
    if (!Number.isFinite(rate) || rate <= 0) {
        if (hit) return hit.rate;
        throw new Error(`FX response had no usable rate for ${cur}→USD.`);
    }
    cache[cur] = { rate, t: Date.now() };
    saveCache(cache);
    return rate;
}

// Convenience: convert an amount IN USD to amount in `currency`. For UI
// display where everything internally is USD but we want to show the
// user their balance in EUR / INR / whatever they picked.
export async function fromUSD(amountUSD, currency) {
    const rate = await getRateToUSD(currency); // 1 LOCAL = `rate` USD
    if (rate <= 0) return amountUSD;
    return amountUSD / rate;
}

// Synchronous variant for hot UI render paths — uses cached rate or
// returns null if not cached. Caller decides what to do with null
// (typically: render in USD with a "fx loading…" hint).
export function fromUSDCached(amountUSD, currency) {
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return amountUSD;
    const cache = loadCache();
    const hit = cache[cur];
    if (!hit) return null;
    return amountUSD / hit.rate;
}

// Pre-warm a list of currencies so the dropdown renders rates without
// a flash of "loading". Called when the portfolio panel opens.
export async function warmCommonRates(list = COMMON_CURRENCIES) {
    const promises = list.map(c => getRateToUSD(c).catch(() => null));
    await Promise.allSettled(promises);
}
