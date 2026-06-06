// "If you'd followed the engine" — hypothetical equity curve.
//
// The credibility centerpiece: instead of an abstract hit-rate %, this
// shows the money. It compounds the return of every resolved directional
// signal in the live ledger (BUY = +move, SELL = -move) starting from a
// hypothetical $10k, and plots the running balance. Universe-wide by
// default; a symbol box scopes it to one ticker.
//
// Honest framing baked into the UI: this is a simplified equal-weight,
// no-cost, no-slippage simulation of taking EVERY directional call in
// sequence — a directional-edge proof, not a brokerage backtest. The
// caption says so plainly so it never over-promises.

import { readEngineEquityCurve } from '../ledger-reader.js';

let loaded = false;
let loading = false;
const START = 10000;

const W = 600, H = 200, PAD_L = 6, PAD_R = 6, PAD_T = 14, PAD_B = 22;

function buildSvg(points, startBalance) {
    if (!points || points.length < 2) return '';
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const bals = points.map(p => p.balance);
    let lo = Math.min(...bals, startBalance);
    let hi = Math.max(...bals, startBalance);
    if (hi - lo < 1) { hi = lo + 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const range = hi - lo || 1;
    const stepX = plotW / (points.length - 1);
    const x = i => PAD_L + i * stepX;
    const y = v => PAD_T + plotH - ((v - lo) / range) * plotH;

    const linePts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
    // Baseline (starting $) reference.
    const baseY = y(startBalance);
    const ended = points[points.length - 1].balance;
    const up = ended >= startBalance;
    const stroke = up ? '#22c55e' : '#ef4444';
    // Area fill under the curve down to the baseline.
    const areaPts = `${PAD_L},${baseY.toFixed(1)} ${linePts} ${(PAD_L + (points.length - 1) * stepX).toFixed(1)},${baseY.toFixed(1)}`;

    return `<svg class="eq-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" aria-label="Engine equity curve">
        <line x1="${PAD_L}" y1="${baseY.toFixed(1)}" x2="${(W - PAD_R)}" y2="${baseY.toFixed(1)}" class="eq-baseline"/>
        <polygon points="${areaPts}" class="eq-area" style="fill:${stroke}"/>
        <polyline points="${linePts}" class="eq-line" style="stroke:${stroke}"/>
    </svg>`;
}

function renderResult(data) {
    if (!data || !data.available) {
        if (data?.rebuilding) {
            return `<div class="eq-empty">The engine was just improved, so its track record is rebuilding under the new logic. ${data.retiredTrades} earlier trades came from the previous engine and no longer reflect how it calls now, so they're set aside. The dollar proof reappears here as fresh calls resolve.</div>`;
        }
        return `<div class="eq-empty">Not enough resolved signals in the ledger yet to chart an equity curve${data?.trades ? ` (only ${data.trades} so far)` : ''}. Check back as more predictions resolve.</div>`;
    }
    const up = data.finalPct >= 0;
    const sign = up ? '+' : '';
    const endBal = data.finalBalance.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const edgeUp = data.avgTradePct >= 0;
    const fracPct = Math.round((data.fraction || 0.25) * 100);
    return `
        <div class="eq-head">
            <div class="eq-stat">
                <div class="eq-stat-label">$${(data.startBalance/1000)}k following the engine became</div>
                <div class="eq-stat-big ${up ? 'up' : 'down'}">$${endBal}</div>
                <div class="eq-stat-sub ${up ? 'up' : 'down'}">${sign}${data.finalPct}% over ${data.trades} signals · ${data.winRatePct}% hit rate</div>
            </div>
        </div>
        ${buildSvg(data.points, data.startBalance)}
        <div class="eq-edge ${edgeUp ? 'up' : 'down'}">
            Average edge per signal: <b>${edgeUp ? '+' : ''}${data.avgTradePct}%</b>
            <span class="eq-edge-note">(this is the sizing-independent number — positive means a real directional edge)</span>
        </div>
        <div class="eq-caption">
            Hypothetical: takes every resolved ${data.horizonDays}-day BUY/SELL call in sequence
            (BUY earns the move, SELL earns the inverse), risking a fixed ${fracPct}% of the running
            balance per trade — no fees or slippage. Fixed-fractional sizing avoids the volatility
            drag of betting the whole account each time. A directional-edge proof from real outcomes,
            not a brokerage backtest. Not financial advice.${data.retiredTrades ? ` The curve starts at the current engine's first call — ${data.retiredTrades} earlier trades from a prior engine are excluded so this reflects how it calls now.` : ''}
        </div>`;
}

async function loadInto(host, { force = false, symbol = null, horizonDays = 1 } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    host.innerHTML = '<div class="eq-loading">Replaying every engine signal through a hypothetical account…</div>';
    try {
        const data = await readEngineEquityCurve({ symbol, horizonDays, startBalance: START });
        host.innerHTML = renderResult(data);
        loaded = true;
        // Soft "done" chime as the proof-in-dollars lands (self-gated).
        if (data?.available) import('../mia/sound.js').then(m => m.complete()).catch(() => {});
    } catch (_) {
        host.innerHTML = '<div class="eq-empty">Failed to build the equity curve.</div>';
    } finally {
        loading = false;
    }
}

function currentScope() {
    const symIn = document.getElementById('eq-symbol');
    const hSel = document.getElementById('eq-horizon');
    const symbol = (symIn?.value || '').trim().toUpperCase() || null;
    const horizonDays = Number(hSel?.value) || 1;
    return { symbol, horizonDays };
}

export function initEquityCurve() {
    if (document.getElementById('equity-curve-section')) return;
    const after = document.getElementById('options-scan-section')
        || document.getElementById('earnings-cal-section')
        || document.getElementById('sector-heatmap-section')
        || document.getElementById('scanner-section')
        || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="equity-curve-section" id="equity-curve-section">
            <details class="equity-curve-details">
                <summary class="equity-curve-summary">
                    <span class="equity-curve-title">💰 Did Following the Engine Pay Off?</span>
                    <span class="equity-curve-hint">A hypothetical $10k taking every signal — the proof in dollars</span>
                    <button class="equity-curve-refresh" id="equity-curve-refresh" title="Recompute">↻</button>
                </summary>
                <div class="equity-curve-controls">
                    <input type="text" id="eq-symbol" class="eq-symbol-input" placeholder="All symbols (or type a ticker)" autocomplete="off">
                    <select id="eq-horizon" class="eq-horizon-select" aria-label="Horizon">
                        <option value="1" selected>1-day calls</option>
                        <option value="3">3-day calls</option>
                        <option value="5">5-day calls</option>
                        <option value="10">10-day calls</option>
                        <option value="20">20-day calls</option>
                    </select>
                </div>
                <div class="equity-curve-host" id="equity-curve-host"></div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);

    const details = document.querySelector('#equity-curve-section .equity-curve-details');
    const host = document.getElementById('equity-curve-host');
    details.addEventListener('toggle', () => { if (details.open) loadInto(host, currentScope()); });
    document.getElementById('equity-curve-refresh').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        loaded = false;
        loadInto(host, { force: true, ...currentScope() });
    });
    // Re-run on scope change (symbol enter / horizon select).
    const rerun = () => { loaded = false; loadInto(host, { force: true, ...currentScope() }); };
    document.getElementById('eq-symbol').addEventListener('change', rerun);
    document.getElementById('eq-symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') rerun(); });
    document.getElementById('eq-horizon').addEventListener('change', rerun);
}

// Programmatic open for Mia's show_equity_curve tool. Returns the
// computed summary so Mia can state the dollar result in the same turn.
export async function openEquityCurve({ symbol = null, horizonDays = 5 } = {}) {
    initEquityCurve();
    const details = document.querySelector('#equity-curve-section .equity-curve-details');
    if (!details) return { ok: false };
    details.open = true;
    if (symbol) { const i = document.getElementById('eq-symbol'); if (i) i.value = symbol; }
    if (horizonDays) { const h = document.getElementById('eq-horizon'); if (h) h.value = String(horizonDays); }
    const host = document.getElementById('equity-curve-host');
    loaded = false;
    if (host) await loadInto(host, { force: true, symbol, horizonDays });
    document.getElementById('equity-curve-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const data = await readEngineEquityCurve({ symbol, horizonDays, startBalance: START });
    return { ok: true, summary: data?.available ? {
        startBalance: data.startBalance, finalBalance: data.finalBalance, finalPct: data.finalPct,
        trades: data.trades, winRatePct: data.winRatePct, horizonDays: data.horizonDays, symbol: data.symbol,
    } : null };
}
