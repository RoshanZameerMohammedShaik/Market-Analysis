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

import { describeBandHistory, HIT_LABELS, HIT_LABELS_SHORT } from './band-history.js';

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
 * One direction's "how much of the predicted move happened" bar.
 *
 * The bar is CLAMPED at 100% while the printed number is not. A day that reached 140% of the
 * predicted upside and one that reached exactly 100% look the same as bars -- both full -- so
 * the figure has to carry the difference, and the full bar gets a distinct treatment to show
 * the edge was passed rather than merely touched.
 *
 * 100% is genuinely ambiguous and the tooltip says so: it is the moment a sell limit at the
 * predicted high would have filled, and the moment the band's containment claim failed. Which
 * of those matters depends on whether you were trading the level or trusting the range.
 */
function reachBar(dir, reachPct, tier, edge, sessionStart, currency, lateMin = 0) {
    const arrow = dir === 'up' ? '↑' : '↓';
    const label = HIT_LABELS[tier] || '—';
    // Long form on desktop, short on a phone, chosen by CSS for the same reason the dates are:
    // the panel is a string and cannot react to a resize.
    const labelHtml = `<span class="fb-d-long">${label}</span>`
        + `<span class="fb-d-short">${HIT_LABELS_SHORT[tier] || '—'}</span>`;
    if (!Number.isFinite(reachPct) && tier === 'none') {
        return `<span class="fbh-bar-row"><span class="fbh-arrow fbh-${dir}">${arrow}</span>`
            + `<span class="fbh-tier fbh-tier-none">${labelHtml}</span></span>`;
    }
    // Strong Hit means price met or passed the predicted edge. The bar is therefore full, and
    // the printed figure keeps going past 100 so "touched it" and "blew through it" stay
    // distinguishable -- 105% and 140% are different days.
    const strong = tier === 'strong';
    const w = Number.isFinite(reachPct) ? Math.min(100, reachPct) : (strong ? 100 : 0);
    const shown = Number.isFinite(reachPct) ? `${reachPct}%` : '';
    const predMove = Number.isFinite(edge) && Number.isFinite(sessionStart)
        ? Math.abs(edge - sessionStart) : null;
    const side = dir === 'up' ? 'high' : 'low';
    const dirWord = dir === 'up' ? 'upside' : 'downside';
    // When the band was set hours into the session its EDGES came from a mid-session anchor, so
    // they are not the levels an open-anchored band would have drawn. The reach figure is still
    // measured from session start like every other row, but the target it is measured against
    // is skewed, and that is worth saying on the number itself.
    const lateNote = lateMin > 20
        ? ` NOTE: this band was set ${lateMin >= 120 ? `${Math.floor(lateMin / 60)}h${String(lateMin % 60).padStart(2, '0')}m` : `${lateMin} min`} after the open, so its predicted ${side} was drawn from a mid-session price rather than the opening one. The reach is measured from session start as usual, but the target itself is skewed.`
        : '';
    const title = [
        `${label}: price covered ${Number.isFinite(reachPct) ? `${reachPct}%` : 'an unmeasurable share'} of the predicted ${dirWord}`,
        predMove != null ? ` (session start ${money(sessionStart, currency)} to predicted ${side} ${money(edge, currency)} is ${money(predMove, currency)} of movement).` : '.',
        strong ? ` Price met or passed the predicted ${side}, so an order resting there would have filled.` : '',
        lateNote,
    ].join('');
    return `
        <span class="fbh-bar-row${lateMin > 20 ? ' is-late' : ''}" title="${title}">
            <span class="fbh-arrow fbh-${dir}">${arrow}</span>
            <span class="fbh-track"><span class="fbh-fill fbh-fill-${dir}${strong ? ' is-hit' : ''}" style="width:${w}%"></span></span>
            <span class="fbh-pct${strong ? ' is-hit' : ''}">${shown}</span>
            <span class="fbh-tier fbh-tier-${tier} fbh-tier-${dir}">${labelHtml}</span>
        </span>`;
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
        // The held/broke verdict no longer has its own column -- Roshan replaced Result and
        // Range used with the reach bars. It is not lost: the row tint carries it, the actual
        // figure that breached is marked, and a reach of 100% or more IS the breach on that
        // side. One fact, three consistent signals, no redundant column.
        const tone = r.met ? 'fb-met' : 'fb-missed';
        // 'locked' = the band the cron actually committed that day. 'modelled' = replayed with
        // today's calibration from bars available before that session. Never blurred: one is
        // a promise that was made, the other is a reconstruction of what it would have been.
        const lateM = Number.isFinite(r.bandSetLateMin) ? r.bandSetLateMin : 0;
        const lateTxt = lateM >= 120 ? `${Math.floor(lateM / 60)}h${String(lateM % 60).padStart(2, '0')}m`
            : `${lateM} min`;
        const src = r.source === 'locked'
            ? `<span class="fb-src fb-src-locked${lateM > 20 ? ' is-late' : ''}" title="The band the engine committed for this date, read from the ledger.${lateM > 20 ? ` It was set ${lateTxt} after the open, so part of this session's range predates it and the reach figures are indicative only.` : ''}">locked${lateM > 20 ? ` +${lateTxt}` : ''}</span>`
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
                <td class="fbh-reach">
                    ${reachBar('up', r.reachHighPct, r.hitHigh, r.predHigh, r.sessionStart, currency, r.bandSetLateMin)}
                    ${reachBar('down', r.reachLowPct, r.hitLow, r.predLow, r.sessionStart, currency, r.bandSetLateMin)}
                </td>
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
                        <th class="fbh-day">Day</th>
                        <th class="fbh-plow"><span class="fb-d-long">Predicted low</span><span class="fb-d-short">Pred low</span></th>
                        <th class="fbh-alow"><span class="fb-d-long">Actual low</span><span class="fb-d-short">Act low</span></th>
                        <th class="fbh-phigh"><span class="fb-d-long">Predicted high</span><span class="fb-d-short">Pred high</span></th>
                        <th class="fbh-ahigh"><span class="fb-d-long">Actual high</span><span class="fb-d-short">Act high</span></th>
                        <th class="fbh-reach">Hit Reach</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            </div>
            <div class="fb-scroll-hint">Scroll sideways for the rest →</div>
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
