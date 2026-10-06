// The live record of published pullback setups (model/setups_record.json, tools/grade_setups.py).
//
// The backtest figure beside each setup is a cell average, the same for every setup in the cell
// and every night: an attempt to give each setup its own probability did not beat it on unseen
// trades, so it is not dressed up as one. What moves is this: every confirmed setup, graded with
// the published rule after it was published. Shared by the landing list and the card.

import { escapeHtml } from './escape.js';

export const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const bps = (x) => `${x >= 0 ? '+' : ''}${Math.round(x)} bps`;
const signed = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

export function shortDate(iso) {
    try {
        return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) { return iso; }
}

/** One status chip for one published setup. */
export function statusHtml(e) {
    if (e.status === 'closed') {
        const cls = e.won ? 'sr-won' : 'sr-lost';
        const word = e.won ? 'Recovered' : (e.timedOut ? 'Lost · timed out' : 'Lost');
        return `<span class="sr-chip ${cls}" title="Bought ${shortDate(e.entryDate)} at ${e.entry}, sold ${shortDate(e.exitDate)} at ${e.exit}, after costs">${word} ${bps(e.netBps)}</span>`;
    }
    if (e.status === 'exiting') {
        return `<span class="sr-chip sr-exit" title="Closed above its 5-day average on ${shortDate(e.triggerDate)}; sells at the next open">Trigger hit · sells next open (${signed(e.markPct)})</span>`;
    }
    if (e.status === 'open' && e.held != null) {
        return `<span class="sr-chip sr-open" title="Marked at the ${shortDate(e.markDate)} close against the entry open">Open · day ${e.held} of 10 · ${signed(e.markPct)}</span>`;
    }
    return `<span class="sr-chip sr-pending" title="Graded after the close of the session it enters">Enters at the next session's open</span>`;
}

/**
 * The headline sentence: live hit rate with its uncertainty, beside what the backtest expected
 * for these same trades. Before anything has closed it says so, rather than printing 0 of 0.
 */
export function liveSummaryHtml(rec, { scope = 'every setup published here' } = {}) {
    const o = rec?.overall;
    if (!o) return '';
    const since = rec.since ? shortDate(rec.since) : '';
    if (!o.n) {
        return `<strong>Live record:</strong> ${o.open} setups published since ${since}, none closed yet.
            Each is graded with the rule above once it exits, usually within 2-5 sessions, and the
            result lands here the night it does.`;
    }
    const range = o.hitLo95 != null ? ` (95% range ${pct(o.hitLo95, 0)}-${pct(o.hitHi95, 0)})` : '';
    const thin = o.n < 100 ? ' Too few trades yet to tell a good month from a real change, the range says how far it could be from the true rate.' : '';
    return `<strong>Live record</strong>, ${scope} since ${since}: <strong>${o.wins} of ${o.n}</strong> closed
        trades recovered, <strong>${pct(o.hitRate)}</strong>${range}, averaging <strong>${bps(o.netBps)}</strong>
        after costs. The backtest expected ${pct(o.expectedHitRate)} and ${bps(o.expectedNetBps)} for these same
        trades.${o.open ? ` ${o.open} more still open.` : ''}${thin}`;
}

export function recordTableHtml(entries, { limit = 40, symbolCol = true } = {}) {
    const rows = entries.slice(0, limit).map(e => `
        <tr class="${symbolCol ? 'su-row' : ''}" data-symbol="${escapeHtml(e.symbol)}" ${symbolCol ? 'tabindex="0"' : ''}>
            <td>${escapeHtml(shortDate(e.session))}</td>
            ${symbolCol ? `<td class="su-sym">${escapeHtml(e.symbol)}</td>` : ''}
            <td>${statusHtml(e)}</td>
        </tr>`).join('');
    return `<div class="su-table-wrap"><table class="su-table sr-table">
        <thead><tr><th title="Session whose close confirmed the setup">Signal</th>${symbolCol ? '<th>Symbol</th>' : ''}
            <th>What happened</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}
