// "Volatility outlook" on the landing page: tonight's most confident calmer/choppier calls across
// the liquid US universe, from model/vol_forecasts.json (tools/write_vol_slice.py). Each row opens
// the card, which shows the same forecast with its range and record.

import { escapeHtml } from './escape.js';
import { loadVolModel, loadVolSlice, loadVolRecord, bucketFor } from '../vol-forecast.js';
import { shortDate } from './setups-record.js';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const ROWS = 12;

function table(rows, model) {
    if (!rows.length) return '<div class="su-empty">None tonight.</div>';
    const body = rows.map(([sym, f]) => {
        const b = bucketFor({ accuracyByConfidence: model.accuracyByConfidenceLiquid || model.accuracyByConfidence }, f.c);
        return `<tr class="su-row" data-symbol="${escapeHtml(sym)}" tabindex="0">
            <td class="su-sym">${escapeHtml(sym)}${f.e === 1 ? ' <span class="sr-chip sr-exit" title="Earnings inside the next 5 sessions">earnings</span>' : ''}</td>
            <td class="su-num">±${pct(f.p20)}</td>
            <td class="su-num"><strong>±${pct(f.s)}</strong></td>
            <td class="su-num" title="${b ? `Past calls at this confidence were right ${pct(b.hitRate)} of the time` : ''}">${pct(f.c, 0)}</td>
        </tr>`;
    }).join('');
    return `<div class="su-table-wrap"><table class="su-table vo-table">
        <thead><tr><th>Symbol</th><th class="su-num" title="Typical daily move over the last 20 sessions">Recent</th>
            <th class="su-num" title="Forecast typical daily move over the next 5 sessions">Next 5</th>
            <th class="su-num" title="Calibrated: calls at this confidence were right about this often in years the model never saw">Confidence</th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
}

export async function renderVolOutlook(onPick) {
    const host = document.getElementById('vol-outlook-section');
    if (!host) return;
    const [slice, model, rec] = await Promise.all([loadVolSlice(), loadVolModel(), loadVolRecord()]);
    if (!slice?.forecasts || !model) { host.hidden = true; return; }
    const all = Object.entries(slice.forecasts);
    // Over 12% a day for 20 sessions on a liquid name is a corporate action in the raw prices
    // (CTVA read 40.7% on 2026-10-01), not volatility; "calmer" after it is true and meaningless.
    const liquid = all.filter(([, f]) => f.liq === 1 && f.p20 <= 0.12);
    const pick = (call) => liquid.filter(([, f]) => f.call === call).sort((a, b) => b[1].c - a[1].c).slice(0, ROWS);
    const wf = model.walkForward;
    const sure = (model.accuracyByConfidenceLiquid || model.accuracyByConfidence).filter(b => b.lo >= 0.8 && b.n);
    const sureN = sure.reduce((a, b) => a + b.n, 0);
    const sureHit = sure.reduce((a, b) => a + b.hitRate * b.n, 0) / (sureN || 1);
    const o = rec?.overall;
    const live = o?.n
        ? `Live since ${shortDate(rec.since)}: ${o.n.toLocaleString()} forecasts graded, ${pct(o.inRange / o.n)} inside their 80% range${o.calls ? `, calls right ${pct(o.right / o.calls)}` : ''}.`
        : `Live grading started ${rec?.since ? shortDate(rec.since) : 'tonight'}; each forecast is scored once its 5 sessions close.`;
    host.hidden = false;
    host.innerHTML = `
        <div class="section-header">
            <h2 class="section-title">〰 Volatility outlook: next 5 sessions, from the ${escapeHtml(shortDate(slice.sessionDate))} close</h2>
        </div>
        <div class="su-intro">
            How much these stocks are likely to move, not which way. Over ${wf.forecasts.toLocaleString()} forecasts in
            ${wf.years[0]}-${wf.years[1]} years the model never trained on, the calmer/choppier call was right
            ${pct(wf.upHitRate)} overall and <strong>${pct(sureHit)}</strong> when it was at least 80% sure; the
            confidence shown is that measured rate (on stocks this liquid). ${live}
        </div>
        <div class="vo-grid">
            <div class="vo-col"><h3>Getting choppier</h3>${table(pick('choppier'), model)}</div>
            <div class="vo-col"><h3>Getting calmer</h3>${table(pick('calmer'), model)}</div>
        </div>
        <div class="su-foot">Listed: US stocks over $5 trading $50M+ a day (${liquid.length} of ${all.length} forecast) ·
            ${liquid.filter(([, f]) => f.call === 'similar').length} of them not called (under 60% sure, or the size forecast points the other way) ·
            every other stock still gets its forecast on its own card</div>`;
    host.querySelectorAll('.su-row').forEach(tr => {
        const go = () => onPick?.({ mode: 'stock', symbol: tr.dataset.symbol, coinId: null });
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
}
