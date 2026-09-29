// The trend gate: withhold the directional calls this engine has always gotten wrong.
// MIRRORS trend_gate.py exactly; tools/trend_gate_sync_check.py holds the two together.
//
// Measured on this engine's own calls over 12 years (417,612 BUY/SELL on 440 US stocks):
//     BUY while below its 200-day average   111,963   49.5%   <- 60% of all BUYs, and they lose
//     BUY above its 200d, $50M+/day          52,822   53.3%   11 of 12 years at 51% or better
//     SELL while above its 200-day average  160,589   48.7%   <- 70% of all SELLs, and they lose
// The engine leans "buy the dip", and a dip in a downtrend is usually the next leg down.
//
// US listings only, because that is where it was measured.

export const MIN_HISTORY = 200;
export const MIN_PRICE = 5;
export const MIN_DOLLAR_VOL = 5e7;
const DOLLAR_VOL_WINDOW = 20;
const GATED_REGIONS = new Set(['NYSE']);

export const REASONS = {
    'no-history': 'fewer than 200 sessions of history, so the long-term trend is unknown',
    'below-200d': 'price is below its 200-day average (a downtrend)',
    'above-200d': 'price is above its 200-day average (an uptrend)',
    'low-price': 'price is under $5',
    'illiquid': 'it trades under $50M a day',
};

/** Long-term trend and liquidity from daily candles, oldest first. */
export function trendState(candles) {
    const c = (candles || []).map(x => Number(x?.close ?? x?.c)).filter(x => Number.isFinite(x));
    const n = c.length;
    if (n < MIN_HISTORY) return { known: false, bars: n };
    const tail = c.slice(-MIN_HISTORY);
    const ma200 = tail.reduce((a, b) => a + b, 0) / MIN_HISTORY;
    const px = c[n - 1];
    const vv = (candles || []).slice(-DOLLAR_VOL_WINDOW);
    let dv = 0;
    if (vv.length) {
        dv = vv.reduce((a, x) => a + Number(x?.close ?? x?.c ?? 0) * Number(x?.volume ?? x?.v ?? 0), 0) / vv.length;
    }
    return { known: true, bars: n, price: px, ma200, above200: px > ma200, dollarVol20: dv };
}

/** null when the call stands; otherwise the reason key it is withheld for. */
export function trendGate(signal, state, region) {
    if (!GATED_REGIONS.has(String(region || '').toUpperCase()) || (signal !== 'BUY' && signal !== 'SELL')) return null;
    if (!state || !state.known) return 'no-history';
    if (signal === 'BUY') {
        if (!state.above200) return 'below-200d';
        if (state.price < MIN_PRICE) return 'low-price';
        if (state.dollarVol20 < MIN_DOLLAR_VOL) return 'illiquid';
        return null;
    }
    return state.above200 ? 'above-200d' : null;
}
