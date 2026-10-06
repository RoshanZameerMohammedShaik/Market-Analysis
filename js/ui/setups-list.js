// "Pullback setups" on the landing page: the confirmed setups from model/setups.json.
//
// Published nightly by tools/write_setups_slice.py after the US close, from real closing prices,
// so nothing here is computed in the browser and the list is identical for everyone. Each row is a
// click through to the full card.
//
// Rebuilt 2026-10-05 after "why everything shows as 67% here? ... I cant understand a thing in
// that table." The odds are a GROUP figure (every setup in the same volatility/VIX regime shares
// it; per-stock odds were tested on 52,346 trades and did no better), so printing them on every
// row said nothing while looking like a per-stock claim. They are stated ONCE, above the table.
// The rows carry only what differs between stocks and what someone acting on the rule needs:
// the price, the run of down days that qualified it, the sell trigger, and how far price has to
// rise to reach it. No RSI(2), no bps, no "held out".

import { escapeHtml } from './escape.js';
import { fmtPriceTag } from './format.js';
import { loadSetupsRecord } from '../reversion-setup.js';
import { recordTableHtml } from './setups-record.js';

const SLICE_URL = 'model/setups.json';

async function loadSlice() {
    try {
        const r = await fetch(SLICE_URL, { cache: 'no-cache' });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
        const j = await r.json();
        return Array.isArray(j?.setups) ? j : null;
    } catch (_) { return null; }
}

function sessionLabel(iso) {
    try {
        return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) { return iso; }
}

const pct0 = (x) => `${Math.round(x * 100)}%`;

/** The shared odds, once: the group figures span a small range, so show the range if it is one. */
function sharedStats(setups, rec) {
    const hits = setups.map(x => x.hitRate).filter(Number.isFinite);
    const nets = setups.map(x => x.netBps).filter(Number.isFinite);
    const recent = setups.map(x => x.heldOutHitRate).filter(Number.isFinite);
    if (!hits.length) return '';
    // Figures within `tight` of each other are one number to a reader ("67%", not "67%, 68%"),
    // so print their mean; a real spread prints as a range.
    const span = (xs, f, tight) => {
        const lo = Math.min(...xs), hi = Math.max(...xs);
        if (f(lo) === f(hi) || hi - lo <= tight) return f(xs.reduce((a, b) => a + b, 0) / xs.length);
        return `${f(lo)}, ${f(hi)}`;
    };
    const signed = (b) => `${b >= 0 ? '+' : '−'}${Math.abs(b / 100).toFixed(1)}%`;
    const o = rec?.overall;
    const live = o?.n
        ? `<div class="su-stat"><span class="su-stat-big">${o.wins} of ${o.n}</span><span class="su-stat-cap">recovered live so far${o.open ? `, ${o.open} still open` : ''}${o.n < 30 ? ' (too early to judge)' : ''}</span></div>`
        : '';
    return `
        <div class="su-stats">
            <div class="su-stat"><span class="su-stat-big">${span(hits, pct0, 0.02)}</span><span class="su-stat-cap">of trades like these recovered over 12 years${recent.length ? ` (${span(recent, pct0, 0.02)} in 2023-26, which the model never saw)` : ''}</span></div>
            <div class="su-stat"><span class="su-stat-big">${span(nets, signed, 15)}</span><span class="su-stat-cap">average gain per trade, after costs</span></div>
            ${live}
        </div>`;
}

export async function renderSetupsList(onPick) {
    const host = document.getElementById('setups-section');
    if (!host) return;
    const [s, rec] = await Promise.all([loadSlice(), loadSetupsRecord()]);
    if (!s) { host.hidden = true; return; }
    host.hidden = false;
    const rows = s.setups.slice(0, 30).map(x => {
        const needs = Number.isFinite(x.trigger) && x.close > 0 ? (x.trigger / x.close - 1) * 100 : null;
        const run = Number.isFinite(x.downDays) && x.downDays > 0
            ? `−${Math.abs(x.downPct).toFixed(1)}%<span class="su-sub">${x.downDays} day${x.downDays === 1 ? '' : 's'}</span>`
            : '';
        return `
        <tr class="su-row" data-symbol="${escapeHtml(x.symbol)}" tabindex="0">
            <td class="su-sym">${escapeHtml(x.symbol)}</td>
            <td class="su-num">${fmtPriceTag(x.close, { srcCurrency: 'USD' })}</td>
            <td class="su-num su-run">${run}</td>
            <td class="su-num">${fmtPriceTag(x.trigger, { srcCurrency: 'USD' })}</td>
            <td class="su-num su-need">${needs != null ? `+${needs.toFixed(1)}%` : '-'}</td>
        </tr>`;
    }).join('');
    host.innerHTML = `
        <div class="section-header">
            <h2 class="section-title">↺ Pullback setups · from the ${escapeHtml(sessionLabel(s.sessionDate))} close${s.confirmed === false ? ' (forming, not final)' : ''}</h2>
        </div>
        <div class="su-intro">
            Stocks in an uptrend that just fell several days running. The rule: <strong>buy at the next open</strong>-<strong>sell at the open after it closes above its 5-day average</strong>, or after 10 trading days at most. No stop-loss.
        </div>
        ${sharedStats(s.setups, rec)}
        ${s.setups.length ? `
        <div class="su-table-wrap"><table class="su-table su-table-v2">
            <thead><tr>
                <th>Stock</th>
                <th class="su-num">Price</th>
                <th class="su-num" title="Consecutive down closes up to the signal, and how far they went">Down</th>
                <th class="su-num" title="Its 5-day average. Sell at the open after the first close above it.">Sell above</th>
                <th class="su-num" title="How far the price has to rise to reach the sell level">Needs</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`
        : `<div class="su-empty">No setups at this close. They cluster after sharp market-wide dips and can be absent for days.</div>`}
        <div class="su-foot">Every row shares the same odds: they come from the history of the whole group, not the single stock.
            Per-stock odds were tested and did no better, so none are shown.
            ${s.unflagged ? ` ${s.unflagged} more stocks qualified in market conditions where this trade has not paid, so they are left out.` : ''}</div>
        ${rec ? `
        <details class="sr-details">
            <summary>Every setup published so far and what happened (${rec.entries.length})</summary>
            ${recordTableHtml([...rec.entries].reverse())}
        </details>` : ''}`;
    host.querySelectorAll('.su-row').forEach(tr => {
        const go = () => onPick?.({ mode: 'stock', symbol: tr.dataset.symbol, coinId: null });
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
}
