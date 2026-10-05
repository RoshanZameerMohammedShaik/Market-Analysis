// The 7-day High/Low forecast panel.
//
// What it shows: for each of the next 7 sessions, an expected Low, an expected
// High, and a confidence that has been MEASURED rather than asserted (80%
// claimed, 80.0% realized across 56 tier/horizon cells, 70k+ observations).
//
// What it deliberately does NOT show: direction. Which edge of the band price
// ends up nearer is the coin flip this app cannot call (49.5% on correctly
// graded rows). Every label here is written to avoid implying otherwise.
//
// Replaces the multi-horizon block, which reused ONE direction for every horizon
// and scaled magnitude by a hand-picked confidence multiplier.

import { forwardDates } from '../forecast-band.js';
import { sessionDateFor, bandDates, exchangeToday } from '../earnings-calendar-slice.js';

// CURRENCY GOES THROUGH THE SAME PATH AS EVERY OTHER PRICE IN THE APP.
//
// This module used to carry its own `money()` helper: a hardcoded symbol table and
// toLocaleString, with no FX conversion at all. The price-target cards above it use
// fmtPriceTag, which converts to the user's display currency. So for every non-US listing the
// panel printed the SAME quantity twice in two different currencies. Measured across a symbol
// sweep on 2026-09-14:
//
//   7203.T    headline 20.16   table 3115.95   ratio 154.6  = JPY/USD
//   0700.HK   headline 56.35   table  440.98   ratio   7.8  = HKD/USD
//   SAP.DE    headline 222.74  table  190.82   ratio   1.17 = EUR->USD
//   RELIANCE  headline 13.36   table 1283.04   ratio  96.0  = INR/USD
//
// Roshan found the disagreement on INTC, where both blocks happen to be USD so the cause was an
// anchor mismatch. Fixing that one symbol and checking three more US large caps proved nothing
// about the universe -- his words, "it has to be dynamically working for all other symbols that
// exist." The sweep is what found this.
//
// Two helpers, and the distinction matters: fmtPriceTag returns MARKUP (a span carrying data-usd
// and data-src, so the value re-renders when the user toggles currency) and therefore cannot go
// inside a title="" attribute. fmtPrice returns plain text for exactly that case.
import { fmtPriceTag, fmtPrice } from './format.js';

const money = (v, cur) => fmtPriceTag(v, { srcCurrency: cur });
const moneyText = (v, cur) => fmtPrice(v, { srcCurrency: cur });

// DERIVED, never read off the band.
//
// This used to format `d.date` from the band object. The cron does not store per-day dates on the
// rows it writes -- only {day, low, high, widthPct} -- so the moment the locked band started
// feeding this table, rows 3 through 7 rendered "Invalid Date": `new Date(undefined + 'T00:00:00Z')`
// is an Invalid Date, and only rows 0 and 1 survived because "Today" and "Tomorrow" are hardcoded.
//
// Computing the labels from now also fixes the case a stored date could never handle: a locked
// band from an earlier session would carry that session's dates and mislabel every row.
// Stocks: the rows ARE the exchange's sessions, holidays skipped (js/market-sessions.js). Row 1
// is the session in progress or the most recent one, the same anchor the earnings check uses, so
// on a Saturday it reads "Fri, Oct 2", not "Today", and a row lands on Monday only if Monday trades.
function sessionLabels(n, region) {
    const today = exchangeToday(region);
    const sess = sessionDateFor(region);
    const dates = bandDates(sess, region, n);
    if (!today || dates.length !== n) return null;
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tIso = tomorrow.toISOString().slice(0, 10);
    return dates.map((iso) => {
        if (iso === today) return 'Today';
        if (iso === tIso) return 'Tomorrow';
        return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    });
}

function dayLabels(n, cryptoMode, region = null) {
    if (!cryptoMode && region && region !== 'CRYPTO') {
        try {
            const s = sessionLabels(n, region);
            if (s) return s;
        } catch (_) { /* fall through to the weekday labels */ }
    }
    const out = ['Today', 'Tomorrow'];
    let dates = [];
    try { dates = forwardDates(n, { cryptoMode }); } catch (_) { dates = []; }
    for (let i = 2; i < n; i++) {
        // forwardDates[0] is the NEXT session, i.e. our "Tomorrow" row, so row i maps to index i-1.
        const d = dates[i - 1];
        out.push(d instanceof Date && !Number.isNaN(d.getTime())
            ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
            : `Session +${i}`);
    }
    return out.slice(0, n);
}

// Two labels, one shown at a time by a media query. Doing this in CSS rather than by
// measuring the viewport in JS means it stays correct through a rotation or a resize without
// a re-render, and the panel is built as a string so it cannot respond to resize anyway.
function pastLabel(iso) {
    try {
        const d = new Date(iso + 'T00:00:00Z');
        const long = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
        const short = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        return `<span class="fb-d-long">${long}</span><span class="fb-d-short">${short}</span>`;
    } catch (_) { return iso; }
}

/**
 * The scored past sessions, one line each: did the day stay inside the range it was given?
 *
 * Rebuilt 2026-10-05. The seven-column table (session start, predicted and actual low and high,
 * "Hit Reach" bars graded Strong/Hit/Partial) answered a question nobody was asking and made
 * days that stayed safely inside read as "Partial Hit", which sounds like a failure. Its red
 * lows, red down-arrows and red breaches read as losses. Roshan: "the red should be removed".
 *
 * Now each day is a small picture on its own scale: grey is the predicted range, blue is where
 * price actually went, amber is any part of the day outside the range. The verdict is a word.
 * The reach figures live on in the tooltip for anyone who wants them.
 */
function rowViz(r) {
    const lo = Math.min(r.predLow, r.actualLow), hi = Math.max(r.predHigh, r.actualHigh);
    const span = hi - lo;
    if (!(span > 0)) return '';
    const x = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
    const seg = (a, b, cls) => (b > a ? `<span class="${cls}" style="left:${x(a).toFixed(2)}%;width:${(x(b) - x(a)).toFixed(2)}%"></span>` : '');
    const inLo = Math.max(r.actualLow, r.predLow), inHi = Math.min(r.actualHigh, r.predHigh);
    return `<span class="bh-viz">
        ${seg(r.predLow, r.predHigh, 'bh-pred')}
        ${seg(inLo, inHi, 'bh-act')}
        ${r.actualHigh > r.predHigh ? seg(r.predHigh, r.actualHigh, 'bh-out') : ''}
        ${r.actualLow < r.predLow ? seg(r.actualLow, r.predLow, 'bh-out') : ''}
        ${Number.isFinite(r.sessionStart) ? `<span class="bh-start" style="left:${x(r.sessionStart).toFixed(2)}%"></span>` : ''}
    </span>`;
}

function renderHistory(hist, currency) {
    if (!hist || !hist.rows?.length) return '';
    const rows = hist.rows.slice().reverse().map(r => {
        // A breach under 0.05% is a touch: the two printed prices are the same to the cent, and
        // "Above by 0%" next to them reads as a contradiction.
        const touch = Number.isFinite(r.missPct) && r.missPct < 0.05;
        const side = !r.highHeld && !r.lowHeld ? 'Both sides' : !r.highHeld ? 'Above' : 'Below';
        const verdict = r.met
            ? '<span class="bh-res bh-in">Inside</span>'
            : touch
                ? `<span class="bh-res bh-outside">At the ${!r.highHeld ? 'high' : 'low'}</span>`
                : `<span class="bh-res bh-outside">${side}${Number.isFinite(r.missPct) ? ` by ${r.missPct}%` : ''}</span>`;
        // Only live rows are tagged; the legend says what an untagged row is. Two tags per row
        // collided with the bar on a phone.
        const src = r.source === 'locked'
            ? '<span class="bh-src" title="Recorded live: the range the app committed that day.">live</span>'
            : '';
        const reach = (Number.isFinite(r.reachHighPct) || Number.isFinite(r.reachLowPct))
            ? ` Price used ${Number.isFinite(r.reachHighPct) ? `${r.reachHighPct}% of the room up` : ''}${Number.isFinite(r.reachHighPct) && Number.isFinite(r.reachLowPct) ? ' and ' : ''}${Number.isFinite(r.reachLowPct) ? `${r.reachLowPct}% of the room down` : ''}.`
            : '';
        const title = `Predicted ${moneyText(r.predLow, currency)} to ${moneyText(r.predHigh, currency)}; actual ${moneyText(r.actualLow, currency)} to ${moneyText(r.actualHigh, currency)}; opened ${moneyText(r.sessionStart, currency)}.${reach}`;
        return `
            <div class="bh-row" title="${title}">
                <span class="bh-day">${pastLabel(r.date)} ${src}</span>
                ${rowViz(r)}
                ${verdict}
                <span class="bh-nums">Range ${money(r.predLow, currency)}–${money(r.predHigh, currency)} · Actual ${money(r.actualLow, currency)}–${money(r.actualHigh, currency)}</span>
            </div>`;
    }).join('');
    const good = hist.claimedPct != null && hist.coveragePct >= hist.claimedPct;
    return `
        <div class="fb-history">
            <div class="fb-head">
                <span class="fb-title">Last ${hist.scored} sessions: did price stay inside?</span>
                <span class="fb-score ${good ? 'is-good' : 'is-under'}">${hist.metCount} of ${hist.scored} inside</span>
            </div>
            <div class="bh-legend"><span class="bh-key bh-key-pred"></span>predicted range <span class="bh-key bh-key-act"></span>where price went <span class="bh-key bh-key-out"></span>outside the range</div>
            <div class="bh-list">${rows}</div>
            <div class="fb-caveat">The range aims to hold 8 days in 10. ${hist.scored} days is too few to judge that: expect ±15 points of luck either way.
                Rows without a <span class="bh-src">live</span> tag were rebuilt afterwards from only the prices available before that day.</div>
        </div>`;
}

/**
 * @param {Object} band  the `forecastBand` object from computeFullConfidence
 * @param {Object} opts  { currency, currentPrice, history }
 * @returns {string} HTML, or '' when there is nothing trustworthy to show
 */
export function renderForecastBand(band, { currency = 'USD', currentPrice = null, history = null, cryptoMode = null, region = null } = {}) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return '';

    // Refuse to print a confidence we cannot stand behind. An uncalibrated band
    // still has a shape, but the percentage would be a guess, and a guessed
    // percentage next to a price is exactly how this app previously came to
    // display 76% accuracy on a coin flip.
    const calibrated = band.calibrated === true;

    // The caller says whether this is crypto. The band cannot: a band read back from the ledger
    // carries only {day, low, high, widthPct}, so BTC's table skipped Saturday and Sunday and
    // labelled its last two rows Mon/Tue, days the coin trades like any other.
    const isCrypto = cryptoMode != null ? cryptoMode === true : (band.mode === 'crypto' || band.cryptoMode === true);
    const labels = dayLabels(band.days.length, isCrypto, region);
    // Rows from the earnings day on are drawn with the wider earnings z (see
    // js/earnings-calendar-slice.js). Saying which ones, and why, is the difference between "the
    // band suddenly jumped on Thursday" and "Thursday is the earnings reaction".
    const earnDay = Number.isFinite(band.earningsDay) && band.earningsDay > 0 ? band.earningsDay : null;
    const rows = band.days.map((d, i) => {
        const spanPct = currentPrice > 0
            ? ((d.high - d.low) / currentPrice * 100) : null;
        const isEarn = earnDay != null && d.day >= earnDay;
        const tag = (earnDay != null && d.day === earnDay)
            ? ' <span class="fb-earn-tag" title="Earnings are expected to move this session, so this row and the ones after it use the wider band measured on earnings weeks.">earnings</span>'
            : '';
        return `
            <tr class="fb-row${isEarn ? ' fb-row-earn' : ''}">
                <td class="fb-day">${labels[i]}${tag}</td>
                <td class="fb-low">${money(d.low, currency)}</td>
                <td class="fb-high">${money(d.high, currency)}</td>
                <td class="fb-span">${spanPct != null ? `±${(spanPct / 2).toFixed(1)}%` : '—'}</td>
            </tr>`;
    }).join('');

    const conf = calibrated
        ? `<span class="fb-conf-value">${band.confidence}%</span>`
        : `<span class="fb-conf-value fb-uncal" title="No calibration loaded for this volatility tier, so no confidence can be stated honestly.">not calibrated</span>`;

    const tierNote = band.volTier
        ? `<span class="fb-tier" title="Assigned from this symbol's own recent volatility, so it moves as the symbol does.">${band.volTier} · ${band.sigmaDaily}%/day</span>`
        : '';

    return `
        <div class="forecast-band-section">
            <div class="fb-head">
                <span class="fb-title">Expected trading range, next 7 sessions</span>
                ${tierNote}
            </div>
            <table class="fb-table">
                <thead>
                    <tr>
                        <th class="fb-day">Day</th>
                        <th class="fb-low"><span class="fb-th-long">Expected low</span><span class="fb-th-short">Low</span></th>
                        <th class="fb-high"><span class="fb-th-long">Expected high</span><span class="fb-th-short">High</span></th>
                        <th class="fb-span">Width</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="fb-foot">
                <div class="fb-conf">
                    Confidence ${conf}
                    <span class="fb-conf-note">that each day's high and low both land inside its row</span>
                </div>
                <div class="fb-caveat">
                    Range only. This does <strong>not</strong> predict whether price rises or falls,
                    and the band widens with time because uncertainty grows.
                    Coverage is a long-run average: when volatility jumps sharply after the band is
                    set, it holds far less often.
                    ${earnDay != null
                        ? `Earnings are due on the ${labels[earnDay - 1] ? `<strong>${labels[earnDay - 1]}</strong> row` : `${earnDay}th session`}, so that row and the ones after it use the band width measured on earnings weeks, which is far wider.`
                        : ''}
                </div>
            </div>
            ${renderHistory(history, currency)}
        </div>`;
}
