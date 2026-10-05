// "This week": the one block a US stock card leads with.
//
// It replaced six stacked blocks (direction header, Suggested Decision, volatility panel,
// pullback panel, confidence dial, status line) that repeated the same three numbers in three
// wordings and argued with each other: "DON'T BUY" over "no directional call" over "no edge".
// Roshan: "I hate the details provided in all of this section."
//
// So: one call, two numbers, one range, one line on direction. Everything that backs the
// numbers (hit rates, sample sizes, live grading) is one tap away, not in the way.

import { fmtPriceTag } from './format.js';
import { shortDate } from './setups-record.js';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

function pill(vf) {
    if (vf.call === 'choppier') return `<span class="wk-pill wk-up">Choppier week · ${Math.round(vf.confidence * 100)}% sure</span>`;
    if (vf.call === 'calmer') return `<span class="wk-pill wk-down">Calmer week · ${Math.round(vf.confidence * 100)}% sure</span>`;
    return '<span class="wk-pill wk-flat">Typical week</span>';
}

/** A pullback setup line, only when there is something to act on. */
function setupLine(rs, co) {
    if (!rs) return '';
    if (rs.active && rs.reliable && rs.cell) {
        return `<div class="wk-setup">↺ <strong>Pullback setup${rs.forming ? ' (confirms at the close)' : ''}:</strong> buy at the next open,
            sell at the open after a close above ${fmtPriceTag(rs.trigger, co)}. ${Math.round(rs.cell.hitRate * 100)}% of these recovered.</div>`;
    }
    const open = (rs.record?.symbol || []).find(e => e.status === 'open' || e.status === 'exiting' || e.status === 'pending');
    if (open) {
        return `<div class="wk-setup">↺ <strong>Open setup trade</strong> from ${shortDate(open.session)}:
            ${open.status === 'exiting' ? 'its exit fired, so it sells at the next open.'
                : `sell at the open after a close above ${rs.trigger ? fmtPriceTag(rs.trigger, co) : 'the 5-day average'}.`}</div>`;
    }
    return '';
}

function detailsHtml(vf, dirRec, rec) {
    const items = [];
    if (vf.call !== 'similar' && vf.bucket) {
        items.push(`When it is this sure, it has been right <strong>${pct(vf.bucket.hitRate, 0)}</strong> of the time
            (${vf.bucket.n.toLocaleString()} past calls, scored on years it never trained on).`);
    } else {
        items.push('It is not sure enough to call calmer or choppier, so it does not.');
    }
    items.push(`Last 20 sessions: ±${pct(vf.past20)} a day.`);
    if (vf.impliedVol) items.push(`Includes the options market's view (±${pct(vf.impliedVol / Math.sqrt(252))} a day).`);
    const o = rec?.overall;
    items.push(o?.n
        ? `Live so far: ${pct(o.inRange / o.n, 0)} of ${o.n.toLocaleString()} forecasts landed in their range (target 80%).`
        : `Live grading starts once the first forecasts are a week old${rec?.since ? ` (made ${shortDate(rec.since)})` : ''}.`);
    if (dirRec && dirRec.n >= 30) {
        items.push(`Up/down calls are hidden: they have been right ${pct(dirRec.hitRate, 0)} of the time live, a coin flip.`);
    }
    return `<details class="wk-why"><summary>Why trust this</summary><ul>${items.map(t => `<li>${t}</li>`).join('')}</ul></details>`;
}

export function renderWeekCard(vf, { price = null, currency = 'USD', rs = null, dirRec = null, record = null } = {}) {
    if (!vf) return '';
    const co = { srcCurrency: currency };
    const week = price ? vf.sigma * Math.sqrt(5) * price : null;
    return `
        <div class="wk-card wk-${vf.call}">
            <div class="wk-head">${pill(vf)}${vf.earnIn ? '<span class="wk-pill wk-earn">Earnings this week</span>' : ''}</div>
            <div class="wk-nums">
                <div class="wk-num"><span class="wk-big">±${pct(vf.sigma)}</span><span class="wk-cap">a typical day</span></div>
                ${week ? `<div class="wk-num"><span class="wk-big">±${fmtPriceTag(week, { ...co, digits: 2 })}</span><span class="wk-cap">over the week</span></div>` : ''}
            </div>
            <div class="wk-line">8 weeks in 10: between ${pct(vf.lo)} and ${pct(vf.hi)} a day.${vf.earnIn ? ' Most of the move comes on the earnings day.' : ''}</div>
            ${setupLine(rs, co)}
            <div class="wk-dir">Up or down: no edge, so no call.</div>
            ${detailsHtml(vf, dirRec, record)}
        </div>`;
}
