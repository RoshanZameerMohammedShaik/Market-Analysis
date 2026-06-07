// Unusual options activity scanner.
//
// Sweeps the liquid US large-cap universe, pulls each name's options
// chain (Yahoo, 5-min cache via options-iv.js), and surfaces symbols
// whose positioning is anomalous — crowded puts/calls (PCR extremes)
// or a stretched IV skew (downside fear / upside euphoria). Ranked by
// how unusual the positioning is.
//
// Stock-only by design: the free options data path (Yahoo) has no crypto
// options, and most small-caps have illiquid chains that produce noise.
// unusualOptionsScore() enforces a minimum total-volume floor so a
// single large order on a thin chain doesn't trip a false flag.
//
// Clicking a row loads that symbol into the chart for the full read.

import { fetchOptionsPositioning, unusualOptionsScore } from '../options-iv.js';
import { getSectorMappedSymbols } from '../sectors.js';
import { displayTicker } from './exchanges.js';

let loaded = false;
let loading = false;
const MAX_ROWS = 25;
const CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
    const out = [];
    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            try { out[idx] = await fn(items[idx], idx); }
            catch (_) { out[idx] = null; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function gather() {
    const symbols = getSectorMappedSymbols();
    let anyData = false;
    const scored = await mapLimit(symbols, CONCURRENCY, async (sym) => {
        const opts = await fetchOptionsPositioning(sym);
        if (!opts) return null;
        anyData = true;   // at least one options chain came back
        const u = unusualOptionsScore(opts);
        if (!u) return null;
        return { sym, ...u };
    });
    // Every chain fetch failed → the options feed (Yahoo /v7/options) is
    // crumb-walled on the free proxy. Distinguish from "nothing unusual".
    if (!anyData) return { feedUnavailable: true, rows: [] };
    return scored
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_ROWS);
}

function renderRows(rows) {
    if (rows && rows.feedUnavailable) {
        return '<div class="options-scan-empty">Options data is temporarily unavailable — the free options feed isn’t responding right now. The engine’s signals still work; this overlay returns when the feed is back.</div>';
    }
    if (!rows || !rows.length) {
        return '<div class="options-scan-empty">No unusual options activity across the large-cap universe right now.</div>';
    }
    return `<div class="options-scan-list">${rows.map(r => {
        const flags = r.flags.map(f => `<span class="options-scan-flag ${f.bias}">${f.label}</span>`).join('');
        return `
        <div class="options-scan-row" data-symbol="${r.sym}">
            <span class="options-scan-sym">${displayTicker(r.sym)}</span>
            <span class="options-scan-flags">${flags}</span>
            <span class="options-scan-score" title="Unusual-activity score (higher = more anomalous)">${r.score}</span>
        </div>`;
    }).join('')}</div>`;
}

async function loadInto(host, { force = false } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    host.innerHTML = '<div class="options-scan-loading">Scanning options chains for unusual positioning…</div>';
    try {
        const rows = await gather();
        host.innerHTML = renderRows(rows);
        bindRowClicks(host);
        loaded = true;
    } catch (_) {
        host.innerHTML = '<div class="options-scan-empty">Failed to load options activity.</div>';
    } finally {
        loading = false;
    }
}

function bindRowClicks(host) {
    host.querySelectorAll('.options-scan-row').forEach(row => {
        if (row.dataset.bound) return;
        row.dataset.bound = '1';
        row.addEventListener('click', () => loadSymbolIntoChart(row.dataset.symbol));
    });
}

function loadSymbolIntoChart(sym) {
    const input = document.getElementById('search-input');
    if (!input) return;
    input.value = sym;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => {
        document.querySelector(`.search-result-item[data-symbol="${sym}"]`)?.click();
    }, 400);
}

export function initOptionsScanner() {
    if (document.getElementById('options-scan-section')) return;
    const after = document.getElementById('earnings-cal-section')
        || document.getElementById('sector-heatmap-section')
        || document.getElementById('scanner-section')
        || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="options-scan-section" id="options-scan-section">
            <details class="options-scan-details">
                <summary class="options-scan-summary">
                    <span class="options-scan-title">⚡ Unusual Options Activity</span>
                    <span class="options-scan-hint">Crowded puts/calls &amp; stretched IV skew across large-caps</span>
                    <button class="options-scan-refresh" id="options-scan-refresh" title="Refresh options scan">↻</button>
                </summary>
                <div class="options-scan-host" id="options-scan-host"></div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);

    const details = document.querySelector('#options-scan-section .options-scan-details');
    const host = document.getElementById('options-scan-host');
    details.addEventListener('toggle', () => { if (details.open) loadInto(host); });
    document.getElementById('options-scan-refresh').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        loadInto(host, { force: true });
    });
}

// Programmatic open for Mia's open_options_scanner tool.
export function openOptionsScanner() {
    initOptionsScanner();
    const details = document.querySelector('#options-scan-section .options-scan-details');
    if (!details) return false;
    details.open = true;
    const host = document.getElementById('options-scan-host');
    if (host) loadInto(host);
    document.getElementById('options-scan-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
}

let _miaCache = null;
export async function getUnusualOptionsForMia() {
    try {
        if (_miaCache) return _miaCache;
        const result = await gather();
        _miaCache = Array.isArray(result) ? result : (result?.rows || []);
        return _miaCache;
    } catch (_) { return []; }
}
