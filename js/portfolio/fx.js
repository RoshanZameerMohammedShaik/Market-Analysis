// FX rates from Yahoo Finance. We store the rate from a given currency
// TO USD — so a user with EUR sees rate=1.08-ish (1 EUR ≈ $1.08).
// Cached for 90s in localStorage so converting "show me my P&L in INR
// every render" doesn't burn through Yahoo's rate limit.
//
// Yahoo's FX symbol convention is XXXYYY=X meaning "1 XXX in YYY". So:
//   USDEUR=X  → how many EUR in 1 USD       (USD→EUR direction)
//   EURUSD=X  → how many USD in 1 EUR       (EUR→USD direction)
// We always want "amount of USD per 1 unit of LOCAL", i.e., LOCAL→USD.
// For LOCAL = EUR, we fetch EURUSD=X. General form: `${LOCAL}USD=X`.
//
// Special-case USD→USD (rate = 1, no fetch).

const CACHE_KEY = 'ma-fx-cache-v1';
const CACHE_MS = 90_000; // 90 seconds — FX moves slowly enough that this is fine for practice trading

// Common currencies the dropdown will offer. Not exhaustive — Yahoo
// supports far more. Computed structurally on the fly: any 3-letter
// code passed in will get a fetch attempt.
export const COMMON_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD',
    'CHF', 'CNY', 'HKD', 'SGD', 'KRW', 'BRL', 'MXN', 'NZD',
    'SEK', 'NOK', 'DKK', 'ZAR', 'TRY', 'AED', 'SAR',
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
// fall back to the cached value or block the user from instantiating).
export async function getRateToUSD(currency) {
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return 1;

    const cache = loadCache();
    const hit = cache[cur];
    if (hit && (Date.now() - hit.t) < CACHE_MS) return hit.rate;

    // Yahoo's chart endpoint is the same one the rest of the app uses for
    // candles. range=1d / interval=1m gives us the most recent intraday
    // close, which for FX pairs is updated continuously during FX market
    // hours (roughly 24×5).
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cur}USD=X?range=1d&interval=5m`;
    const res = await fetch(url);
    if (!res.ok) {
        // If we have an old-but-non-zero cache value, return it rather than
        // blocking the user. FX rates change slowly enough that a 6-hour-old
        // rate is still useful for a practice-trading sim.
        if (hit) return hit.rate;
        throw new Error(`FX fetch failed: ${res.status}`);
    }
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) {
        if (hit) return hit.rate;
        throw new Error('FX response shape unexpected.');
    }
    // Take the most recent non-null close. Yahoo sometimes pads the tail
    // with nulls when the interval hasn't closed yet.
    let rate = null;
    for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null && Number.isFinite(closes[i]) && closes[i] > 0) { rate = closes[i]; break; }
    }
    if (rate == null) {
        if (hit) return hit.rate;
        throw new Error('FX response had no usable close.');
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
