// Did the expected-range band actually hold? The backward-looking half of the forecast panel.
//
// WHY
// ---
// The panel states a specific, falsifiable claim: "Confidence 80% that each day's high and
// low both land inside its row." A claim like that is worth nothing next to a price unless
// the reader can see it scored. Roshan asked for exactly that: the past sessions showing
// what was locked, what was predicted high and low, and how much of it we met.
//
// HOW THE PAST BAND IS OBTAINED
// -----------------------------
// Two sources, and the difference is stated in the UI rather than blurred:
//
//   'locked'   -- the band the cron actually committed for that date, read off the ledger
//                 row's forecastBand.days[0]. This is what was really promised. Only the
//                 last few days are available, because the browser reads a 3-day slice.
//   'modelled' -- a replay of what the band WOULD have been, computed with the same
//                 js/forecast-band.js the live panel uses.
//
// The replay is deliberately built to have no lookahead: sigma comes from bars strictly
// BEFORE the session being scored, and the band is anchored on that session's OPEN price,
// which is the information a trader actually had when the session began. Anchoring on the
// close would let the band see the very move it is being scored against, which would make
// coverage look far better than it is. (Note the stored 'locked' rows are anchored on the
// price when the cron ran, often hours into the session, so they had a small genuine
// information advantage. That is a reason to label the two sources, not to hide either.)
//
// WHAT "MET" MEANS
// ---------------
// Exactly what the panel claims and nothing more: BOTH edges held, i.e.
// actualLow >= predictedLow AND actualHigh <= predictedHigh. A day where price blew through
// the high but held the low is a miss, because the row promised both.
//
// fillPct is reported alongside because containment alone cannot distinguish a well-sized
// band from an absurdly wide one. A band that is never breached but only ever 20% filled is
// not accurate, it is useless -- it would "hold" 100% of the time by being too wide to say
// anything. Coverage and fill have to be read together.

import { forecastBands } from '../forecast-band.js';

// The replay needs enough history for the volatility lookback (30 bars) plus the sessions
// being scored. Below this we return null rather than score a band on a sigma computed from
// a handful of bars, which is how a "calm" tier gets assigned to something that just listed.
const MIN_BARS_FOR_REPLAY = 38;

function pct(a, b) { return b > 0 ? (a / b) * 100 : null; }

/**
 * Score the last N completed sessions against the band that applied to each.
 *
 * @param {Object} opts
 * @param {Array}  opts.candles      daily bars oldest-first, each {time, open, high, low, close}
 * @param {Array}  opts.lockedRows   ledger rows for THIS symbol (any dates); optional
 * @param {number} opts.sessions     how many past sessions to score (default 7)
 * @param {boolean} opts.cryptoMode  passed through to forecastBands for date labelling
 * @returns {Object|null} { rows, metCount, scored, coveragePct, medianFillPct, claimedPct }
 */
export function buildBandHistory({ candles, lockedRows = [], sessions = 7, cryptoMode = false } = {}) {
    if (!Array.isArray(candles) || candles.length < MIN_BARS_FOR_REPLAY) return null;

    // Only bars that actually traded. Yahoo emits a placeholder with close=null for a session
    // that has not opened, and scoring a band against a null high is a NaN in the UI.
    const bars = candles.filter(c =>
        c && Number.isFinite(c.open) && Number.isFinite(c.high)
        && Number.isFinite(c.low) && Number.isFinite(c.close)
        && c.open > 0 && c.high > 0 && c.low > 0);
    if (bars.length < MIN_BARS_FOR_REPLAY) return null;

    // EXCLUDE the final bar. It is the current session, its high and low are still forming,
    // and the forward-looking table already shows it as "Today". Scoring an unfinished
    // session would report a miss-free day simply because the range has not happened yet.
    const lastComplete = bars.length - 2;
    const firstScored = Math.max(30, lastComplete - sessions + 1);

    // date -> locked day-1 band, so the ledger overrides the replay where it exists.
    const lockedByDate = new Map();
    for (const r of (lockedRows || [])) {
        const d1 = r?.forecastBand?.days?.[0];
        if (r?.date && d1 && Number.isFinite(d1.low) && Number.isFinite(d1.high)) {
            lockedByDate.set(r.date, {
                low: d1.low,
                high: d1.high,
                anchor: Number.isFinite(r.entry) ? r.entry : null,
                confidence: r.forecastBand.confidence ?? null,
                calibrated: r.forecastBand.calibrated === true,
            });
        }
    }

    const rows = [];
    let claimedPct = null;
    for (let i = firstScored; i <= lastComplete; i++) {
        const bar = bars[i];
        const date = new Date(bar.time * 1000).toISOString().slice(0, 10);

        let pred = lockedByDate.get(date) || null;
        let source = pred ? 'locked' : 'modelled';

        if (!pred) {
            // Replay: sigma from bars strictly before this session, anchored on its open.
            const band = forecastBands({
                candles: bars.slice(0, i),          // strictly prior -- no lookahead
                currentPrice: bar.open,
                cryptoMode,
                mode: 'perDay',
            });
            const d1 = band?.days?.[0];
            if (!d1) continue;
            pred = {
                low: d1.low, high: d1.high, anchor: bar.open,
                confidence: band.confidence ?? null,
                calibrated: band.calibrated === true,
            };
        }
        if (claimedPct == null && Number.isFinite(pred.confidence)) claimedPct = pred.confidence;

        const lowHeld = bar.low >= pred.low;
        const highHeld = bar.high <= pred.high;
        const predWidth = pred.high - pred.low;
        const actWidth = bar.high - bar.low;

        rows.push({
            date,
            source,
            anchor: pred.anchor,
            predLow: pred.low,
            predHigh: pred.high,
            actualLow: bar.low,
            actualHigh: bar.high,
            actualClose: bar.close,
            lowHeld,
            highHeld,
            met: lowHeld && highHeld,
            // Which way it escaped, for the UI to say something more useful than "miss".
            brokeSide: lowHeld && highHeld ? null : (!lowHeld && !highHeld ? 'both' : (!lowHeld ? 'low' : 'high')),
            // How much of the predicted range price actually used. Read WITH coverage:
            // a band that is never breached but 20% filled is too wide to be informative.
            fillPct: predWidth > 0 ? +(pct(actWidth, predWidth)).toFixed(0) : null,
            // How far past the edge it went, as a % of the anchor, when it did break.
            missPct: lowHeld && highHeld ? null : +Math.max(
                lowHeld ? 0 : (pred.low - bar.low) / pred.anchor * 100,
                highHeld ? 0 : (bar.high - pred.high) / pred.anchor * 100,
            ).toFixed(2),
            calibrated: pred.calibrated,
        });
    }

    if (!rows.length) return null;

    const scored = rows.length;
    const metCount = rows.filter(r => r.met).length;
    const fills = rows.map(r => r.fillPct).filter(Number.isFinite).sort((a, b) => a - b);
    const medianFillPct = fills.length
        ? (fills.length % 2 ? fills[(fills.length - 1) / 2]
            : Math.round((fills[fills.length / 2 - 1] + fills[fills.length / 2]) / 2))
        : null;

    return {
        rows,
        scored,
        metCount,
        coveragePct: Math.round((metCount / scored) * 100),
        medianFillPct,
        claimedPct,
        lockedCount: rows.filter(r => r.source === 'locked').length,
    };
}

/**
 * One honest sentence about what the scored window shows.
 *
 * Deliberately refuses to call 7 sessions evidence. At n=7 the standard error on a coverage
 * estimate is around 15 percentage points, so "71% vs 80% claimed" is not a miss, it is
 * noise. Reporting it as a verdict is the same error as the 76%-accuracy-on-a-coin-flip
 * badge this project already had to remove.
 */
export function describeBandHistory(hist) {
    if (!hist) return '';
    const { metCount, scored, coveragePct, claimedPct, medianFillPct } = hist;
    const parts = [`Both edges held on ${metCount} of ${scored} sessions (${coveragePct}%)`];
    if (Number.isFinite(claimedPct)) parts.push(`against ${claimedPct}% claimed`);
    if (Number.isFinite(medianFillPct)) {
        parts.push(`and price used a median ${medianFillPct}% of the predicted range`);
    }
    // n=7 cannot separate a real calibration error from chance. Say so.
    return `${parts.join(', ')}. ${scored} sessions is too few to judge the ${claimedPct ?? 80}% `
        + `claim — expect swings of roughly ±15 points on this few samples.`;
}
