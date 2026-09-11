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

import { describeBandHistory } from './band-history.js';

const CUR = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥',
              HKD: 'HK$', AUD: 'A$' };

function money(v, cur) {
    if (!Number.isFinite(v)) return '—';
    const sym = CUR[cur] || '';
    // Sub-dollar names need more precision or every row reads the same.
    const dp = Math.abs(v) < 1 ? 4 : 2;
    return sym + v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function dayLabel(iso, idx) {
    if (idx === 0) return 'Today';
    if (idx === 1) return 'Tomorrow';
    try {
        const d = new Date(iso + 'T00:00:00Z');
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) { return iso; }
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
 * The scored past sessions: what the band promised, what price actually did, and whether
 * both edges held.
 *
 * Kept in the same panel as the forward table on purpose. A forecast shown without its
 * track record invites the reader to trust it; shown next to "held on 5 of 7", it invites
 * them to judge it. The band's own claim is that BOTH edges hold, so that is what the Met
 * column scores -- a day that blew through the high but held the low is a miss, not a half.
 */
function renderHistory(hist, currency) {
    if (!hist || !hist.rows?.length) return '';

    const rows = hist.rows.slice().reverse().map(r => {
        const tone = r.met ? 'fb-met' : 'fb-missed';
        const mark = r.met
            ? '<span class="fb-tick" title="Both the high and the low stayed inside the predicted range.">held</span>'
            : `<span class="fb-cross" title="Price left the predicted range through the ${r.brokeSide === 'both' ? 'high and the low' : r.brokeSide}, by ${r.missPct}% of the day's anchor price.">broke ${r.brokeSide}</span>`;
        // 'locked' = the band the cron actually committed that day. 'modelled' = replayed with
        // today's calibration from bars available before that session. Never blurred: one is
        // a promise that was made, the other is a reconstruction of what it would have been.
        const src = r.source === 'locked'
            ? '<span class="fb-src fb-src-locked" title="The band the engine committed for this date, read from the ledger.">locked</span>'
            : '<span class="fb-src fb-src-model" title="Replayed with the current calibration using only bars from before this session, anchored on its open. No lookahead, but it is a reconstruction, not a promise that was made at the time.">modelled</span>';
        // Now that predicted and actual sit in separate columns, the reader has to compare two
        // numbers across a gap instead of reading a stacked pair. Marking the actual figure
        // when IT is the one that breached its edge does that comparison for them, so the eye
        // lands on the number that broke rather than having to work out which side failed.
        const lowCls = r.lowHeld ? 'fb-act-ok' : 'fb-act-broke';
        const highCls = r.highHeld ? 'fb-act-ok' : 'fb-act-broke';
        const lowTitle = r.lowHeld ? 'Held above the predicted low.'
            : `Broke BELOW the predicted low by ${r.missPct}% of the day's anchor price.`;
        const highTitle = r.highHeld ? 'Held below the predicted high.'
            : `Broke ABOVE the predicted high by ${r.missPct}% of the day's anchor price.`;
        return `
            <tr class="fb-row ${tone}">
                <td class="fbh-day">${pastLabel(r.date)} ${src}</td>
                <td class="fbh-plow">${money(r.predLow, currency)}</td>
                <td class="fbh-alow ${lowCls}" title="${lowTitle}">${money(r.actualLow, currency)}</td>
                <td class="fbh-phigh">${money(r.predHigh, currency)}</td>
                <td class="fbh-ahigh ${highCls}" title="${highTitle}">${money(r.actualHigh, currency)}</td>
                <td class="fbh-res">${mark}</td>
                <td class="fbh-used" title="How much of the predicted range price actually travelled. A band that never breaks but is only 20% filled is too wide to be useful.">${Number.isFinite(r.fillPct) ? `${r.fillPct}%` : '—'}</td>
            </tr>`;
    }).join('');

    const good = hist.claimedPct != null && hist.coveragePct >= hist.claimedPct;
    return `
        <div class="fb-history">
            <div class="fb-head">
                <span class="fb-title">How the last ${hist.scored} sessions actually went</span>
                <span class="fb-score ${good ? 'is-good' : 'is-under'}">${hist.metCount}/${hist.scored} held · ${hist.coveragePct}%</span>
            </div>
            <div class="fb-scroll">
            <table class="fb-table fb-table-past">
                <thead>
                    <tr>
                        <th class="fbh-day">Session</th>
                        <th class="fbh-plow"><span class="fb-d-long">Predicted low</span><span class="fb-d-short">Pred low</span></th>
                        <th class="fbh-alow"><span class="fb-d-long">Actual low</span><span class="fb-d-short">Act low</span></th>
                        <th class="fbh-phigh"><span class="fb-d-long">Predicted high</span><span class="fb-d-short">Pred high</span></th>
                        <th class="fbh-ahigh"><span class="fb-d-long">Actual high</span><span class="fb-d-short">Act high</span></th>
                        <th class="fbh-res">Result</th>
                        <th class="fbh-used"><span class="fb-d-long">Range used</span><span class="fb-d-short">Used</span></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            </div>
            <div class="fb-scroll-hint">Scroll sideways for Result and Range used →</div>
            <div class="fb-caveat">${describeBandHistory(hist)}</div>
        </div>`;
}

/**
 * @param {Object} band  the `forecastBand` object from computeFullConfidence
 * @param {Object} opts  { currency, currentPrice, history }
 * @returns {string} HTML, or '' when there is nothing trustworthy to show
 */
export function renderForecastBand(band, { currency = 'USD', currentPrice = null, history = null } = {}) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return '';

    // Refuse to print a confidence we cannot stand behind. An uncalibrated band
    // still has a shape, but the percentage would be a guess, and a guessed
    // percentage next to a price is exactly how this app previously came to
    // display 76% accuracy on a coin flip.
    const calibrated = band.calibrated === true;

    const rows = band.days.map((d, i) => {
        const spanPct = currentPrice > 0
            ? ((d.high - d.low) / currentPrice * 100) : null;
        return `
            <tr class="fb-row">
                <td class="fb-day">${dayLabel(d.date, i)}</td>
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
                        <th class="fb-low">Expected low</th>
                        <th class="fb-high">Expected high</th>
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
                </div>
            </div>
            ${renderHistory(history, currency)}
        </div>`;
}
