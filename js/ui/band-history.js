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
 * What fraction of a predicted move actually happened, as a percentage.
 *
 * Floored at 0 rather than allowed to go negative: a session whose high never got above the
 * anchor delivered none of the predicted upside, and "-40%" would read as though it moved
 * backwards along an axis that only has one direction. Returns null when the predicted move
 * is zero or negative, which would make the ratio meaningless rather than merely extreme.
 */
function reachOf(actualMove, predictedMove) {
    if (!Number.isFinite(actualMove) || !Number.isFinite(predictedMove)) return null;
    if (!(predictedMove > 0)) return null;
    return +Math.max(0, (actualMove / predictedMove) * 100).toFixed(0);
}

// The midpoint of the predicted move. Not a tuned threshold -- half the distance is the one
// cut that needs no justification, which matters because every fitted constant in this project
// has eventually turned out to be fitted to noise.
const HIT_PCT = 50;

/**
 * Which tier did this side land in?
 *
 * `reachedEdge` is passed separately and deliberately: Strong Hit is the DIRECT comparison
 * (actual high >= predicted high) and must not depend on the anchor arithmetic. A band whose
 * predicted edge sits on the wrong side of session start makes the reach ratio undefined, but
 * "did price get to the predicted level" is still perfectly well defined, so the top tier keeps
 * working when the percentage cannot.
 */
export function hitTier(reachPct, reachedEdge) {
    if (reachedEdge === true) return 'strong';
    if (!Number.isFinite(reachPct) || reachPct <= 0) return 'none';
    if (reachPct >= HIT_PCT) return 'hit';
    return 'partial';
}

export const HIT_LABELS = {
    strong: 'Strong Hit',
    hit: 'Hit',
    partial: 'Partial Hit',
    none: 'No Move',
};

// Narrow-screen forms. "Partial Hit" alone is wider than a whole price column at 400px, and
// the tier is the one thing in this table that survives being abbreviated -- the colour already
// says which edge, so the word only has to carry the degree.
export const HIT_LABELS_SHORT = {
    strong: 'Strong',
    hit: 'Hit',
    partial: 'Partial',
    none: '—',
};

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
                // WHEN the band was set, which the reach figures depend on completely.
                //
                // A locked band is anchored on the price at the moment the cron ran, and GitHub
                // delays those crons -- the 13:35Z NYSE run landed at 17:08Z on 2026-09-10, so
                // that band was anchored at 323.55, 3h40m into a session that opened at 316.79.
                // The day's LOW (316.51) had therefore already happened before the band existed,
                // and scoring it as "71% of the predicted downside delivered" credits a forecast
                // that was never made. Daily bars cannot tell us the range AFTER the band was
                // set, so the honest move is to carry the lateness and let the UI say so rather
                // than print a number that quietly means something different per row.
                predictedAt: r.predictedAt || null,
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
            // HOW MUCH OF THE PREDICTED MOVE ACTUALLY HAPPENED, per direction.
            //
            // Measured from the anchor, because the predicted high is a DISTANCE above it, not
            // an absolute target: on Sep 10 AAPL anchored at 316.79 with a predicted high of
            // 333.75, so the forecast upside was 16.96 and price delivered 9.95 -- 59%.
            // Dividing the raw prices instead (326.74 / 333.75 = 98%) would report near-perfect
            // accuracy for any expensive stock that barely moved, because the shared anchor
            // dominates the ratio. That is the same mistake as judging a forecast by the price
            // level rather than the move.
            //
            // Deliberately UNCAPPED here. 140% and 100% are different facts -- one blew through
            // the edge, the other touched it -- and the display can clamp the bar while the
            // data keeps the distinction. Clamping at source would erase it permanently.
            //
            // Note this asks a DIFFERENT question from `met`. Reaching the predicted high is
            // what a trader's sell limit needed, and simultaneously the point at which the
            // band's containment claim fails. So reachHighPct >= 100 always means highHeld is
            // false. Both are reported rather than picking one.
            // SESSION START is the reference for both sides, always -- the price the stock opened
            // the day at. Roshan's framing: "the price with which a stock starts its session will
            // be considered as Session Start". Predicted high 110 from a start of 100 means 10 of
            // predicted upside; a spike to 109 covered 9 of it, so 90%.
            //
            // This REPLACES using each band's own anchor. A locked band is centred on the price
            // when the cron ran, so on 2026-09-10 it was anchored at 323.55 in a session that
            // opened at 316.79, and the same day scored 71% downside off that anchor versus 9%
            // off the open. Two rows in one column meaning two different things is not a
            // comparison. Session start is the one reference every row shares, and it is the one
            // a trader actually measures a day against.
            sessionStart: bar.open,
            reachHighPct: reachOf(bar.high - bar.open, pred.high - bar.open),
            reachLowPct: reachOf(bar.open - bar.low, bar.open - pred.low),
            // Tiers. Strong Hit is the direct edge comparison and needs no anchor, so it survives
            // the case where a late band puts its predicted edge on the wrong side of the open
            // and the ratio becomes undefined.
            hitHigh: hitTier(reachOf(bar.high - bar.open, pred.high - bar.open), bar.high >= pred.high),
            hitLow: hitTier(reachOf(bar.open - bar.low, bar.open - pred.low), bar.low <= pred.low),
            // Minutes between this session's open and the moment the band was set. 0 for a
            // replayed row (open-anchored by construction). When this is large the reach figures
            // include movement that predates the forecast, so the UI marks the row instead of
            // presenting a number that is not comparable with the others.
            bandSetLateMin: pred.predictedAt
                ? Math.max(0, Math.round((Date.parse(pred.predictedAt) - bar.time * 1000) / 60000))
                : 0,
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
