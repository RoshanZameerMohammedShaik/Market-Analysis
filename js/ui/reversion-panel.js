// The pullback setup, on the signal card. See js/reversion-setup.js for the rule and evidence.
//
// The number shown is how often the TRADE recovered, next to what it earned, next to the same
// figure on data the fit never saw. All three, always: a hit rate on its own is a dial (a nearer
// target raises it and loses money), and a fitted number on its own asks to be trusted.

import { fmtPriceTag } from './format.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const bps = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)} bps`;

export function renderReversionPanel(rs, { currency = 'USD' } = {}) {
    if (!rs) return '';
    const co = { srcCurrency: currency };
    if (!rs.eligible) {
        return `<div class="rv-panel rv-muted"><span class="rv-title">Pullback setup</span>
            <span class="rv-line">Not applicable: ${rs.reason}.</span></div>`;
    }
    if (!rs.active) {
        return `<div class="rv-panel rv-muted"><span class="rv-title">Pullback setup</span>
            <span class="rv-line">Not today. ${rs.reason}.</span></div>`;
    }
    const cell = rs.reliable ? rs.cell : null;
    if (!cell) {
        return `<div class="rv-panel rv-muted"><span class="rv-title">Pullback setup · present, not flagged</span>
            <span class="rv-line">The dip qualifies (RSI(2) ${rs.rsi2}), but in this volatility and VIX
            regime (${rs.tier}, VIX ${rs.vixBand}) the trade has not paid reliably in 12 years of
            history, so it is not treated as a signal.</span></div>`;
    }
    // Held-out figure for THIS cell when it has enough trades, else the pooled held-out figure.
    const ho = rs.heldOut && rs.heldOut.n >= 50 ? rs.heldOut : rs.pooledHeldOut;
    const hoLabel = rs.heldOut && rs.heldOut.n >= 50 ? 'on 2023-26 data the fit never saw' : 'across all setups on 2023-26 data the fit never saw';
    const state = rs.forming
        ? `<span class="rv-state rv-forming" title="The setup is defined at the close. Mid-session it is read off the live price as a provisional close.">forming · confirms at today's close</span>`
        : `<span class="rv-state rv-active">active</span>`;
    return `
        <div class="rv-panel">
            <div class="rv-head"><span class="rv-title">Pullback setup</span>${state}</div>
            <div class="rv-body">
                In 12 years of history, <strong>${pct(cell.hitRate)}</strong> of setups like this recovered
                to their 5-day average within 10 sessions, and the trade averaged
                <strong>${bps(cell.netBps)}</strong> after costs
                (${cell.n.toLocaleString()} trades, ${cell.positiveYears} of ${cell.years} years positive).
                ${ho ? `It held <strong>${pct(ho.hitRate)}</strong> / ${bps(ho.netBps)} ${hoLabel}.` : ''}
            </div>
            <div class="rv-rule">
                <span><strong>Buy</strong> at today's close, or tomorrow's open (about 6 bps less, measured).</span>
                <span><strong>Sell</strong> at the open after the first close above ${fmtPriceTag(rs.trigger, co)} (the 5-day average, recalculated each day). At most 10 sessions.</span>
                <span><strong>No stop.</strong> Every stop tested turned this trade from a gain into a loss.</span>
            </div>
            <div class="rv-note">This is how often the trade recovered, not a forecast that the price rises
                tomorrow: next-day direction on these same setups is 53%, a coin flip.</div>
        </div>`;
}
