// Spikers: the stocks most likely to make a big move in the next session, by MEASURED odds.
//
// Rebuilt 2026-10-14 (Roshan: "card's call everywhere"). It ranked a live screen by the engine's
// direction call and showed an up target with a coin-flip confidence, "DOCN ▲ $127.48 (+15%) ·
// 49% conf ✓", none of it measured. Now each row is the published chance of a move at least twice
// the stock's normal day, either way (js/big-moves.js), with the record behind that number.
// Direction is not predicted: nothing measured predicts it.

import { state } from './state.js';
import { loadBigMoves, bucketFor } from '../big-moves.js';
import { displayTicker } from './exchanges.js';
import { escapeHtml } from './escape.js';

const LIMIT = 25;
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

export function initSpikers({ onPickSymbol }) {
    syncVisibility();
    document.querySelectorAll('[data-timeframe]').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(syncVisibility, 0));
    });
    document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(syncVisibility, 0));
    });
    const btn = document.getElementById('spikers-btn');
    if (btn) btn.addEventListener('click', () => openModal(onPickSymbol));
}

function syncVisibility() {
    const btn = document.getElementById('spikers-btn');
    if (!btn) return;
    btn.style.display = state.timeframe === 'today' ? '' : 'none';
}

function openModal(onPickSymbol) {
    document.getElementById('spikers-modal')?.remove();
    const el = document.createElement('div');
    el.id = 'spikers-modal';
    el.className = 'spikers-overlay';
    el.innerHTML = `
        <div class="spikers-card" role="dialog" aria-label="Spikers">
            <div class="spikers-head">
                <div class="spikers-title">🚀 Spikers</div>
                <button class="spikers-close" id="sp-close" aria-label="Close">✕</button>
            </div>
            <div class="spikers-intro" id="sp-intro">Loading the published odds…</div>
            <div class="spikers-buckets">
                <button class="sp-bucket active" data-filter="all">All</button>
                <button class="sp-bucket" data-filter="no-earnings">No earnings due</button>
                <button class="sp-bucket" data-filter="earnings">Earnings due</button>
            </div>
            <div class="spikers-body" id="sp-body"><div class="sp-loading"><div class="loader"></div></div></div>
        </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    document.getElementById('sp-close').addEventListener('click', () => el.remove());
    document.addEventListener('keydown', escClose);
    let data = null;
    const show = (filter) => {
        if (data) render(data, filter, onPickSymbol);
    };
    el.querySelectorAll('.sp-bucket').forEach(b => b.addEventListener('click', () => {
        el.querySelectorAll('.sp-bucket').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        show(b.dataset.filter);
    }));
    loadBigMoves().then((d) => {
        data = d;
        intro(d);
        show('all');
    }).catch(() => {
        const body = document.getElementById('sp-body');
        if (body) body.innerHTML = '<div class="sp-error">The big-move odds could not be loaded.</div>';
    });
}

function escClose(e) {
    if (e.key === 'Escape') {
        const el = document.getElementById('spikers-modal');
        if (el) { el.remove(); document.removeEventListener('keydown', escClose); }
    }
}

function intro(d) {
    const box = document.getElementById('sp-intro');
    if (!box) return;
    if (!d || !d.rows.length) {
        box.textContent = 'No big-move odds are published right now. They come out with the nightly run.';
        return;
    }
    const wf = d.backtest;
    const crypto = state.mode === 'crypto' ? ' Measured for liquid US stocks only, so no crypto is listed.' : '';
    const record = wf ? ` On ${wf.forecasts.toLocaleString()} forecasts the model never trained on, a move like that happened
        ${pct(wf.baseRate, 1)} of the time on an ordinary day, ${pct(wf.top10pctRate)} for the tenth of stocks it rated highest, and
        ${pct(wf.earningsNextRate)} when earnings were due (ranking quality: AUC ${wf.auc.toFixed(2)}, where 0.5 is a coin flip).` : '';
    const live = d.live?.n
        ? ` Live since ${day(d.liveSince)}: ${d.live.n.toLocaleString()} graded, ${pct(d.live.spiked / d.live.n)} made the move against ${pct(d.live.predicted / d.live.n)} expected.`
        : (d.pending ? ` Live grading started ${day(d.liveSince)}: ${d.pending.toLocaleString()} forecasts are waiting for their session to close.` : '');
    box.innerHTML = `The chance each stock moves <strong>at least twice its normal day</strong>, up or down, on
        <strong>${escapeHtml(day(d.session))}</strong> (published after the ${escapeHtml(day(d.madeAfter))} close).
        It says how big, not which way: no measured signal says which way.${record}${live}${crypto}`;
}

function render(d, filter, onPickSymbol) {
    const body = document.getElementById('sp-body');
    if (!body) return;
    if (!d || !d.rows.length) { body.innerHTML = '<div class="sp-empty">Nothing published yet.</div>'; return; }
    const rows = d.rows.filter(r => filter === 'earnings' ? r.earnings : filter === 'no-earnings' ? (r.earningsKnown && !r.earnings) : true).slice(0, LIMIT);
    if (!rows.length) { body.innerHTML = '<div class="sp-empty">No stocks in this group tonight.</div>'; return; }
    const top = rows[0].p || 1;
    body.innerHTML = `
        <div class="sp-results">
            ${rows.map(r => {
                const b = bucketFor(d.buckets, r.p);
                const held = b ? `On years the model never trained on, forecasts at these odds (${pct(b.lo)} to ${pct(Math.min(1, b.hi))}) were followed by the move ${pct(b.actual, 1)} of the time, ${b.n.toLocaleString()} of them.` : '';
                return `
                <div class="sp-row" data-symbol="${escapeHtml(r.symbol)}" title="${escapeHtml(held)}">
                    <div class="sp-row-main">
                        <div class="sp-row-sym">${escapeHtml(displayTicker(r.symbol))}${r.earnings ? '<span class="sp-earn">earnings due</span>' : ''}</div>
                        <div class="sp-row-reason">a move of ±${(r.move * 100).toFixed(1)}% or more${b ? ` · at these odds ${pct(b.actual)} did, on unseen years` : ''}</div>
                        <div class="sp-odds-bar"><span style="width:${Math.max(2, (r.p / top) * 100).toFixed(1)}%"></span></div>
                    </div>
                    <div class="sp-row-numbers">
                        <div class="sp-row-target">${pct(r.p)}</div>
                        <div class="sp-row-current">chance</div>
                    </div>
                </div>`;
            }).join('')}
        </div>
        <div class="sp-footer">
            <div class="sp-footer-meta">${rows.length} of ${d.rows.length} stocks · odds for ${escapeHtml(day(d.session))} · tap one to open its card</div>
        </div>`;
    body.querySelectorAll('.sp-row').forEach(row => row.addEventListener('click', () => {
        document.getElementById('spikers-modal')?.remove();
        if (onPickSymbol) onPickSymbol(row.dataset.symbol);
    }));
}
