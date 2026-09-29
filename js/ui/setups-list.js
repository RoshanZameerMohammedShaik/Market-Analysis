// "Pullback setups" on the landing page: today's confirmed setups from model/setups.json.
//
// Published nightly by tools/write_setups_slice.py after the US close, from real closing prices,
// so nothing here is computed in the browser and the list is identical for everyone. Each row is a
// click through to the full card, which shows the same setup with its rule and evidence.

import { escapeHtml } from './escape.js';
import { fmtPriceTag } from './format.js';

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

export async function renderSetupsList(onPick) {
    const host = document.getElementById('setups-section');
    if (!host) return;
    const s = await loadSlice();
    if (!s) { host.hidden = true; return; }
    host.hidden = false;
    const rows = s.setups.slice(0, 30).map(x => `
        <tr class="su-row" data-symbol="${escapeHtml(x.symbol)}" tabindex="0">
            <td class="su-sym">${escapeHtml(x.symbol)}</td>
            <td class="su-num">${fmtPriceTag(x.close, { srcCurrency: 'USD' })}</td>
            <td class="su-num">${Number(x.rsi2).toFixed(1)}</td>
            <td class="su-num">${fmtPriceTag(x.trigger, { srcCurrency: 'USD' })}</td>
            <td class="su-num su-hit">${(x.hitRate * 100).toFixed(1)}%</td>
            <td class="su-num">${x.netBps >= 0 ? '+' : ''}${Math.round(x.netBps)} bps</td>
            <td class="su-num su-ho">${x.heldOutHitRate != null ? `${(x.heldOutHitRate * 100).toFixed(1)}%` : '—'}</td>
        </tr>`).join('');
    host.innerHTML = `
        <div class="section-header">
            <h2 class="section-title">↺ Pullback setups — ${escapeHtml(sessionLabel(s.sessionDate))} ${s.confirmed === false ? '(forming, not yet the close)' : 'close'}</h2>
        </div>
        <div class="su-intro">
            Uptrending, liquid US stocks after a sharp two-day dip. Buy at the next open; sell at the
            open after the first close above the trigger (the 5-day average), within 10 sessions; no
            stop. Over 12 years these recovered <strong>about two times in three</strong>, and held
            that on 2023-26 data the fit never saw. That is the trade's recovery rate, not a forecast
            that the price rises tomorrow.
        </div>
        ${s.setups.length ? `
        <div class="su-table-wrap"><table class="su-table">
            <thead><tr>
                <th>Symbol</th><th class="su-num">Close</th><th class="su-num" title="RSI over 2 sessions; the setup needs under 10">RSI(2)</th>
                <th class="su-num" title="Sell at the open after the first close above this (the 5-day average, recalculated daily)">Trigger</th>
                <th class="su-num" title="Share of setups like this that recovered, 2014-2022">Recovered</th>
                <th class="su-num" title="Average result per trade after costs">Net</th>
                <th class="su-num" title="The same figure on 2023-26 data the fit never saw">Held out</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`
        : `<div class="su-empty">No setups at this close. They cluster after sharp market-wide dips and can be absent for days.</div>`}
        <div class="su-foot">${s.scanned} liquid US names scanned · VIX ${s.vix ?? '—'}${s.unflagged ? ` · ${s.unflagged} more qualified in volatility/VIX regimes where the trade has not paid reliably, so they are not listed` : ''}</div>`;
    host.querySelectorAll('.su-row').forEach(tr => {
        const go = () => onPick?.({ mode: 'stock', symbol: tr.dataset.symbol, coinId: null });
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
}
