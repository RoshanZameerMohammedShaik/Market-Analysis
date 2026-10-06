// The volatility forecast, on the signal card. See js/vol-forecast.js for the model and evidence.
//
// Three numbers, each with what backs it: the expected size of a day's move (with its 80% range),
// the calmer/choppier call with the measured hit rate of past calls made at the same confidence,
// and the live grade of this app's own forecasts. A call under 60% sure is not made at all.

import { fmtPriceTag } from './format.js';
import { shortDate } from './setups-record.js';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

function chip(vf) {
    if (vf.call === 'similar') return `<span class="vp-chip vp-similar" title="No confident call">Like recent weeks</span>`;
    const cls = vf.call === 'choppier' ? 'vp-up' : 'vp-down';
    return `<span class="vp-chip ${cls}">${vf.call === 'choppier' ? 'Choppier' : 'Calmer'} · ${pct(vf.confidence, 0)} confident</span>`;
}

function liveLine(rec) {
    if (!rec) return '';
    const o = rec.overall;
    if (!o?.n) {
        return `<div class="vp-live"><strong>Live record:</strong> forecasts are graded once their 5 sessions
            close; the first ones made ${rec.since ? shortDate(rec.since) : 'tonight'} are graded a week later.
            ${rec.pending ? `${rec.pending.toLocaleString()} waiting.` : ''}</div>`;
    }
    const calls = o.calls ? ` Calls right <strong>${o.right.toLocaleString()} of ${o.calls.toLocaleString()}</strong> (${pct(o.right / o.calls)}).` : '';
    return `<div class="vp-live"><strong>Live record</strong> since ${shortDate(rec.since)}: ${o.n.toLocaleString()} forecasts graded,
        <strong>${pct(o.inRange / o.n)}</strong> landed inside their 80% range (the target is 80%).${calls}</div>`;
}

function mineHtml(list) {
    if (!list?.length) return '';
    const rows = [...list].reverse().slice(0, 5).map(g => `
        <tr><td>${shortDate(g.session)}</td>
            <td class="su-num">±${pct(g.sigma)}</td>
            <td class="su-num">±${pct(g.realized)}</td>
            <td>${g.inRange ? '<span class="sr-chip sr-won">in range</span>' : '<span class="sr-chip sr-lost">outside</span>'}</td>
            <td>${g.call === 'similar' ? '<span class="vp-muted">no call</span>'
                : `${g.call} ${g.right ? '<span class="sr-chip sr-won">right</span>' : '<span class="sr-chip sr-lost">wrong</span>'}`}</td></tr>`).join('');
    return `<div class="su-table-wrap vp-mine"><table class="su-table">
        <thead><tr><th>Forecast</th><th class="su-num">Said</th><th class="su-num">Was</th><th>80% range</th><th>Call</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

export function renderVolPanel(vf, { currency = 'USD', price = null, record = null } = {}) {
    if (!vf) return '';
    const co = { srcCurrency: currency };
    const week = price ? vf.sigma * Math.sqrt(5) * price : null;
    const b = vf.bucket;
    const wf = vf.walkForward || {};
    const conf = vf.call === 'similar'
        ? (vf.confidence >= vf.minCall
            ? 'No call on calmer or choppier: the size forecast and the direction model point different ways, and in testing those calls were a coin flip.'
            : `Under ${pct(vf.minCall, 0)} sure either way, so no call on whether it gets calmer or choppier.`)
        : b ? `Past calls made at ${pct(b.lo, 0)}-${pct(Math.min(b.hi, 1), 0)} confidence were right
              <strong>${pct(b.hitRate)}</strong> of the time (${b.n.toLocaleString()} calls in ${wf.years?.[0]}-${String(wf.years?.[1]).slice(2)},
              all in years the model never trained on).` : '';
    const earn = vf.earnIn
        ? `<div class="vp-earn">Earnings land inside these 5 sessions. That is most of the expected jump, and the range is wider for it.</div>`
        : (vf.earnKnown === false ? `<div class="vp-note">This stock's earnings date could not be checked, if it reports this week, expect more than this.</div>` : '');
    return `
        <div class="vp-panel">
            <div class="rv-head"><span class="rv-title">Volatility · next 5 sessions</span>${chip(vf)}</div>
            <div class="vp-main">
                <div class="vp-big">±${pct(vf.sigma)}<span>a typical day</span></div>
                <div class="vp-side">
                    <div>Last 20 sessions: ±${pct(vf.past20)}</div>
                    <div>80% range: ${pct(vf.lo)} to ${pct(vf.hi)}</div>
                    ${week ? `<div>Over the week: about ±${fmtPriceTag(week, co)}</div>` : ''}
                    ${vf.impliedVol ? `<div title="Annualized ${pct(vf.impliedVol)} from the ${shortDate(vf.ivDate)} options close (DoltHub), an input to this forecast">Options market implies: ±${pct(vf.impliedVol / Math.sqrt(252))}</div>` : ''}
                </div>
            </div>
            <div class="vp-conf">${conf}</div>
            ${earn}
            ${liveLine(record)}
            ${mineHtml(record?.symbol)}
            <div class="vp-note">How much it moves, not which way. Size is predictable (scored R² ${wf.levelR2} against 0.53 for "same as the
                last 30 days"); direction is not. ${vf.impliedVol ? "Uses this stock's option-implied volatility and the VIX term structure."
                    : vf.ivLoaded ? 'No option-implied volatility for this stock in the data, so it runs on price history and the VIX term structure.'
                    : 'Option-implied volatility was not part of this forecast; it runs on price history alone.'}</div>
        </div>`;
}
