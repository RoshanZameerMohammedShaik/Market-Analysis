// Accuracy-by-setup report — "which setups does the engine read well?"
//
// An honest meta-analysis from the live ledger: hit-rate broken down by
// the indicator context stored on each prediction (signal direction,
// RSI zone, MACD momentum, Bollinger position). Tells the user WHEN to
// lean on the engine and when to be skeptical.
//
// Honesty note: we don't fake a trending/ranging or risk-on/off split —
// ADX and macro regime aren't stored per ledger row, so those would be
// retroactive guesses. Every dimension here is derived from real logged
// fields. Thin buckets (< minN) are dimmed and labeled "low sample" so a
// 3-row 100% never masquerades as a trustworthy edge.

import { readAccuracyBySetup } from '../ledger-reader.js';

let loaded = false;
let loading = false;

function bucketRow(b, overallRate) {
    const tier = b.hitRate == null ? 'na' : b.hitRate >= 55 ? 'high' : b.hitRate >= 50 ? 'mid' : 'low';
    const delta = (b.hitRate != null && overallRate != null) ? b.hitRate - overallRate : null;
    const deltaStr = delta == null ? '' :
        `<span class="ar-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta} vs avg</span>`;
    return `
        <div class="ar-bucket ${b.enough ? '' : 'thin'}">
            <span class="ar-bucket-label">${b.label}</span>
            <div class="ar-bucket-bar"><div class="ar-bucket-fill ${tier}" style="width:${Math.min(100, b.hitRate || 0)}%"></div></div>
            <span class="ar-bucket-rate ${tier}">${b.hitRate == null ? '—' : b.hitRate + '%'}</span>
            <span class="ar-bucket-n">${b.resolved}${b.enough ? '' : ' · low sample'}</span>
            ${deltaStr}
        </div>`;
}

function renderReport(data) {
    if (!data || !data.available) {
        if (data?.rebuilding) {
            return `<div class="ar-empty">The engine was just improved, so its accuracy breakdown is rebuilding under the new logic. ${data.retiredRows} earlier predictions came from the previous engine — and since the update changed which setups it reads well, those numbers no longer apply and are set aside. The breakdown reappears as fresh calls resolve.</div>`;
        }
        return `<div class="ar-empty">Not enough resolved predictions yet to break accuracy down by setup${data?.totalResolved ? ` (${data.totalResolved} so far)` : ''}.</div>`;
    }
    const o = data.overall;
    const dims = data.dimensions.map(d => `
        <div class="ar-dim">
            <div class="ar-dim-title">${d.title}</div>
            ${d.buckets.length ? d.buckets.map(b => bucketRow(b, o.hitRate)).join('') : '<div class="ar-dim-empty">No data.</div>'}
        </div>`).join('');
    // Target-capture line — only shown once enough rows carry a stored
    // target (new rows). Two distinct truths: direction (did it go the
    // right way) AND capture (how much of the predicted move it got).
    const captureLine = (Number.isFinite(o.avgCapturedPct) && o.capturedSampleN >= 10)
        ? `<div class="ar-capture">…and captured <b>${o.avgCapturedPct}%</b> of the predicted move on average <span class="ar-capture-n">(${o.capturedSampleN} graded vs. their target)</span></div>`
        : '';
    return `
        <div class="ar-overall">
            Engine baseline: <b>${o.hitRate}%</b> right direction over ${o.resolved} resolved ${data.horizonDays}-day calls.
            ${captureLine}
            Each setup below is measured against the direction baseline — green setups are where the engine has the most edge.
        </div>
        ${dims}
        <div class="ar-caption">
            Direction = did price close the way we called it. Capture = how much of the predicted price move it actually
            reached (graded against each call's own stored target; blank on older rows from before target-grading).
            We don't show a market-regime split (trending/ranging, risk-on/off) — that state isn't stored per prediction,
            so showing it would be a guess.
        </div>`;
}

async function loadInto(host, { force = false, horizonDays = 1 } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    host.innerHTML = '<div class="ar-loading">Crunching the ledger by setup…</div>';
    try {
        const data = await readAccuracyBySetup({ horizonDays });
        host.innerHTML = renderReport(data);
        loaded = true;
    } catch (_) {
        host.innerHTML = '<div class="ar-empty">Failed to build the accuracy report.</div>';
    } finally {
        loading = false;
    }
}

export function initAccuracyReport() {
    if (document.getElementById('accuracy-report-section')) return;
    const after = document.getElementById('equity-curve-section')
        || document.getElementById('options-scan-section')
        || document.getElementById('scanner-section')
        || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="accuracy-report-section" id="accuracy-report-section">
            <details class="accuracy-report-details">
                <summary class="accuracy-report-summary">
                    <span class="accuracy-report-title">🎯 Which Setups Does the Engine Read Best?</span>
                    <span class="accuracy-report-hint">Hit-rate by RSI / momentum / band context — when to trust it</span>
                    <button class="accuracy-report-refresh" id="accuracy-report-refresh" title="Recompute">↻</button>
                </summary>
                <div class="accuracy-report-host" id="accuracy-report-host"></div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);

    const details = document.querySelector('#accuracy-report-section .accuracy-report-details');
    const host = document.getElementById('accuracy-report-host');
    details.addEventListener('toggle', () => { if (details.open) loadInto(host); });
    document.getElementById('accuracy-report-refresh').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        loaded = false; loadInto(host, { force: true });
    });
}

// Programmatic open for Mia's get_accuracy_by_setup tool. Returns the
// structured breakdown so Mia can answer "what setups does the engine
// read well" with the actual numbers.
export async function openAccuracyReport({ horizonDays = 1 } = {}) {
    initAccuracyReport();
    const details = document.querySelector('#accuracy-report-section .accuracy-report-details');
    if (!details) return { ok: false };
    details.open = true;
    const host = document.getElementById('accuracy-report-host');
    loaded = false;
    if (host) await loadInto(host, { force: true, horizonDays });
    document.getElementById('accuracy-report-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const data = await readAccuracyBySetup({ horizonDays });
    return { ok: true, report: data?.available ? data : null };
}
