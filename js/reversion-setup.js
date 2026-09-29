// The pullback setup: the one short-horizon call in this app measured above 60%, out of sample.
//
// WHAT IT ANSWERS, and why it is not "direction". Next-day direction is a coin flip at this
// horizon: the app's own live ledger grades every committed BUY/SELL at 50.4%, and a 71-feature
// gradient-boosted model walked forward over 440 stocks and 12 years reached AUC 0.519. But on
// the same oversold entries, a different question is answerable:
//
//     "is it up tomorrow?"                                   53.4%
//     "does it close above its 5-day average within 10?"     67.4%
//
// THE TRADE, fully mechanical (tools/calibrate_reversion.py has every number):
//     ENTRY  at the close of a session where RSI(2) < 10, price is above its 200-day average,
//            and the name trades $50M+ a day (US listings)
//     EXIT   at the OPEN after the first close above the 5-day average, at most 10 sessions
//     STOP   none. Every stop tested destroyed the edge on this trade.
//
// Calibrated per (volatility tier x VIX band), fitted on 2014-2022 and verified on 2023-2026
// held out (66.0% vs 68.4% fitted, +41 vs +45 bps net). A cell whose fitted edge is not
// statistically positive is reported as present-but-unreliable rather than as a signal.
//
// HIT RATE IS A DIAL. A nearer target reverts more often and earns less; +0.5 sigma reverts 89% of
// the time and loses money after costs. So the payoff is always carried beside the hit rate.

import { rangeSigma } from './forecast-band.js';
import { trendState, MIN_PRICE, MIN_DOLLAR_VOL } from './trend-gate.js';

const CAL_URL = 'model/reversion_calibration.json';
export const RSI2_MAX = 10;
const MA_TRIGGER = 5;

let _cal = null;
let _calPromise = null;

export async function loadReversionCalibration() {
    if (_cal !== null) return _cal || null;
    if (_calPromise) return _calPromise;
    _calPromise = (async () => {
        try {
            const r = await fetch(CAL_URL, { cache: 'no-cache' });
            // Pages answers a missing file with 200 + index.html; the content type is the test.
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _cal = (j && j.cells && j.pooled) ? j : false;
        } catch (_) {
            _cal = false;
        }
        return _cal || null;
    })();
    return _calPromise;
}

/**
 * RSI over n periods with the smoothing the calibration used: pandas
 * ewm(alpha=1/n, adjust=False) over the close-to-close changes. null when there is no loss in the
 * window (the ratio is undefined, and the calibration drops those rows the same way).
 */
export function rsiEwm(closes, n = 2) {
    let up = null, dn = null;
    const a = 1 / n;
    for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (!Number.isFinite(d)) continue;
        const g = d > 0 ? d : 0;
        const l = d < 0 ? -d : 0;
        if (up === null) { up = g; dn = l; } else { up = (1 - a) * up + a * g; dn = (1 - a) * dn + a * l; }
    }
    if (up === null || !(dn > 0)) return null;
    return 100 - 100 / (1 + up / dn);
}

function tierFor(sigma, edges) {
    for (const [lo, hi, name] of edges) if (sigma >= lo && sigma < hi) return name;
    return edges[edges.length - 1][2];
}

function vixBandFor(vix, bands) {
    if (!Number.isFinite(vix)) return null;
    for (const [lo, hi, name] of bands) if (vix >= lo && vix < hi) return name;
    return bands[bands.length - 1][2];
}

/** Is the New York session in progress? The setup is defined AT the close, so mid-session it is
 *  only forming: the RSI is read off the live price as a provisional close. */
export function nyseSessionOpen(nowMs = Date.now()) {
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(new Date(nowMs));
    const g = (t) => p.find(x => x.type === t)?.value;
    const wd = g('weekday');
    if (wd === 'Sat' || wd === 'Sun') return false;
    const m = (Number(g('hour')) % 24) * 60 + Number(g('minute'));
    return m >= 9 * 60 + 30 && m < 16 * 60;
}

/**
 * Evaluate the setup for one symbol.
 * @param history daily candles oldest first, >= 200 bars; the LAST bar is today's (live) bar
 * @returns null when not applicable at all (not US, no calibration, too little history), else
 *          { active, forming, reliable, rsi2, trigger, ma200, tier, vixBand, cell, heldOut,
 *            pooled, reason }
 */
export function evaluateReversionSetup({ history, region, vix, cal, nowMs = Date.now() }) {
    if (!cal || String(region || '').toUpperCase() !== 'NYSE') return null;
    const bars = (history || []).filter(c => c && c.close > 0 && c.high >= c.low && c.low > 0);
    if (bars.length < 200) return null;
    const closes = bars.map(c => c.close);
    const trend = trendState(bars);
    const px = closes[closes.length - 1];
    const rsi2 = rsiEwm(closes.slice(-60), 2);
    const trigger = closes.slice(-MA_TRIGGER).reduce((a, b) => a + b, 0) / MA_TRIGGER;
    const sigma = rangeSigma(bars, 30);
    const edges = cal.tierEdges || [];
    const tier = Number.isFinite(sigma) && edges.length ? tierFor(sigma, edges) : null;
    const vixBand = vixBandFor(Number(vix), cal.vixBands || []);
    const key = tier && vixBand ? `${tier}:${vixBand}` : null;
    const cell = key ? cal.cells?.[key] || null : null;
    const heldOut = key ? cal.cellsHeldOut?.[key] || null : null;
    const base = {
        rsi2: rsi2 == null ? null : +rsi2.toFixed(1), trigger, ma200: trend.ma200 ?? null, tier, vixBand,
        cell, heldOut, pooled: cal.pooled, pooledHeldOut: cal.pooledHeldOut, price: px,
    };
    // Eligibility first, each measured: below the 200d the app's own BUYs earned +5 bps against
    // +40.6 above, and illiquid names lost 249 bps on the same rows.
    let reason = null;
    if (!trend.known) reason = 'not enough history for a 200-day average';
    else if (!trend.above200) reason = 'price is below its 200-day average, where this setup does not hold';
    else if (px < MIN_PRICE) reason = 'price is under $5';
    else if (trend.dollarVol20 < MIN_DOLLAR_VOL) reason = 'it trades under $50M a day, where costs eat the edge';
    if (reason) return { ...base, active: false, eligible: false, reason };
    const active = rsi2 != null && rsi2 < RSI2_MAX;
    // A fitted cell whose 95% lower bound is not positive has not shown a reliable edge, and saying
    // "setup active" there would be the confident-looking noise this module exists to replace.
    const reliable = !!(cell && cell.n >= (cal.minCellN || 150) && cell.netBpsLo95 > 0);
    return {
        ...base, eligible: true, active, reliable,
        forming: active && nyseSessionOpen(nowMs),
        reason: active ? null : `RSI(2) is ${rsi2 == null ? 'undefined' : rsi2.toFixed(0)}, not under ${RSI2_MAX}: no pullback today`,
    };
}
