// Spikers UI — button on hot-picks header (Today only), bucket selector,
// results modal, calls into js/spike-detector.js. Caches results for 5 min.

import { state } from './state.js';
import { findSpikers, BUCKETS, bucketById } from '../spike-detector.js';
import { fmtPriceTag } from './format.js';
import { displayTicker } from './exchanges.js';

let cache = null; // { mode, ts, scoredAll: [...] } across buckets when feasible
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    const existing = document.getElementById('spikers-modal');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'spikers-modal';
    el.className = 'spikers-overlay';
    el.innerHTML = `
        <div class="spikers-card" role="dialog" aria-label="Spikers">
            <div class="spikers-head">
                <div class="spikers-title">🚀 Spikers</div>
                <button class="spikers-close" id="sp-close" aria-label="Close">✕</button>
            </div>
            <div class="spikers-intro">
                Candidates the engine thinks have <strong>above-baseline probability</strong> of moving by the chosen amount <strong>today</strong>.
                Most won't hit — treat this as a watchlist, not a prediction. ATR-feasibility filtered, earnings-imminent skipped.
            </div>
            <div class="spikers-buckets">
                ${BUCKETS.map(b => `<button class="sp-bucket" data-bucket="${b.id}">${b.label}</button>`).join('')}
            </div>
            <div class="spikers-body" id="sp-body">
                <div class="sp-empty">Pick a percentage above to scan.</div>
            </div>
        </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    document.getElementById('sp-close').addEventListener('click', () => el.remove());
    el.querySelectorAll('.sp-bucket').forEach(b => b.addEventListener('click', async () => {
        el.querySelectorAll('.sp-bucket').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const bucket = bucketById(b.dataset.bucket);
        await runScan(bucket, onPickSymbol);
    }));
    document.addEventListener('keydown', escClose);
}

function escClose(e) {
    if (e.key === 'Escape') {
        const el = document.getElementById('spikers-modal');
        if (el) { el.remove(); document.removeEventListener('keydown', escClose); }
    }
}

async function buildCandidates() {
    if (state.mode === 'stock') {
        const { scanStockHotPicks } = await import('../hotpicks.js');
        const picks = await scanStockHotPicks(state.timeframe, 50, () => {});
        // Use picks as the candidate pool (already a wide live screener cast).
        return picks.map(p => ({ symbol: p.symbol, name: p.name, price: p.price, candles: null }));
    } else {
        const { scanCryptoHotPicks } = await import('../hotpicks.js');
        const picks = await scanCryptoHotPicks(state.timeframe, 50, () => {});
        return picks.map(p => ({ symbol: p.symbol, id: p.id, name: p.name, price: p.price, candles: null }));
    }
}

async function runScan(bucket, onPickSymbol) {
    const body = document.getElementById('sp-body');
    if (!body) return;
    body.innerHTML = `<div class="sp-loading"><div class="loader"></div><div class="sp-progress" id="sp-progress">Initializing…</div></div>`;
    const onProgress = msg => { const el = document.getElementById('sp-progress'); if (el) el.textContent = msg; };

    try {
        // Cached candidate pool (the expensive part). We re-score per bucket
        // since ATR feasibility differs by bucket.
        if (!cache || cache.mode !== state.mode || (Date.now() - cache.ts) > CACHE_TTL_MS) {
            onProgress('Building candidate pool from live screeners…');
            const candidates = await buildCandidates();
            cache = { mode: state.mode, ts: Date.now(), candidates };
        }
        const candidates = cache.candidates;
        const results = await findSpikers(candidates, bucket, onProgress, { mode: state.mode });

        if (results.length === 0) {
            body.innerHTML = `<div class="sp-empty">No candidates pass ATR-feasibility for ${bucket.label} today. That's a feature, not a bug — try a smaller bucket.</div>`;
            return;
        }
        body.innerHTML = `
            <div class="sp-results">
                ${results.map(r => `
                    <div class="sp-row" data-symbol="${r.symbol}">
                        <div class="sp-row-main">
                            <div class="sp-row-sym">${displayTicker(r.symbol)}</div>
                            <div class="sp-row-name">${r.name || ''}</div>
                            <div class="sp-row-reason">${r.reason}</div>
                        </div>
                        <div class="sp-row-numbers">
                            <div class="sp-row-target"><span class="sp-row-arrow">▲</span> ${fmtPriceTag(r.targetPrice)} <span class="sp-row-pct">(+${r.projectedPct}%)</span></div>
                            <div class="sp-row-current">from ${fmtPriceTag(r.price)}</div>
                            <div class="sp-row-conf">${r.confidence}% conf${r.calibrated ? ' ✓' : ''}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="sp-footer">
                <div class="sp-footer-meta">${results.length} candidates · bucket ${bucket.label} · ${cache.candidates.length} pool</div>
                <button class="sp-rescan" id="sp-rescan">↻ Rescan pool</button>
            </div>`;

        body.querySelectorAll('.sp-row').forEach(row => row.addEventListener('click', () => {
            const sym = row.dataset.symbol;
            const overlay = document.getElementById('spikers-modal');
            if (overlay) overlay.remove();
            if (onPickSymbol) onPickSymbol(sym);
        }));
        document.getElementById('sp-rescan')?.addEventListener('click', async () => {
            cache = null;
            await runScan(bucket, onPickSymbol);
        });
    } catch (e) {
        body.innerHTML = `<div class="sp-error">Scan failed: ${e.message}</div>`;
    }
}
