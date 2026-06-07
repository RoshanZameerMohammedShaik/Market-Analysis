// Earnings calendar — "what reports this week (and how the engine reads
// it going in)".
//
// For a universe of liquid US large-caps (the sector-mapped set), we:
//   1. pull each name's next earnings date (getEarningsProximity, 1h cache),
//   2. keep those landing within the lookback window (default 14 days),
//   3. run a fast engine read on each so the user sees the pre-earnings
//      signal + confidence next to the date,
//   4. sort by soonest first.
//
// Clicking a row loads that symbol into the chart. Mounts as a
// collapsible section; lazy-loads on first open.
//
// Honesty note: the engine CAPS confidence going into earnings
// (earningsCap in earnings.js — binary event risk). So a pre-earnings
// read is intentionally cautious; the calendar surfaces that rather
// than implying the engine is highly sure ahead of a coin-flip event.

import { getEarningsProximity } from '../earnings.js';
import { getSectorMappedSymbols } from '../sectors.js';
import { analyzeAndCache } from '../analysis-cache.js';
import { displayTicker } from './exchanges.js';

let loaded = false;
let loading = false;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_ROWS = 30;          // cap engine reads so the scan stays quick
const PROX_CONCURRENCY = 6;   // parallel earnings-date lookups

function sigLabel(sig) {
    return sig === 'NO_TRADE' ? 'AVOID'
        : sig === 'NEUTRAL' ? "DON'T BUY"
        : sig || '—';
}
function sigClass(sig) { return (sig || 'neutral').toLowerCase(); }

function whenLabel(days) {
    if (days <= 0) return 'today';
    if (days === 1) return '1 day';
    return `${days} days`;
}
function whenClass(days) {
    if (days <= 1) return 'imminent';
    if (days <= 5) return 'soon';
    return '';
}

// Run a bounded-concurrency map so we don't fire 90 Yahoo calls at once.
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

async function gather(windowDays) {
    const symbols = getSectorMappedSymbols();
    // 1. Earnings proximity for the whole universe (cached, bounded concurrency).
    const prox = await mapLimit(symbols, PROX_CONCURRENCY, async (sym) => {
        const p = await getEarningsProximity(sym);
        return { sym, daysUntil: p?.daysUntil ?? null };
    });
    // If EVERY proximity lookup came back null, the earnings feed is
    // unavailable (Yahoo's quoteSummary endpoint is crumb-walled on the free
    // proxy) — distinct from "no earnings in window". Signal that so the UI
    // shows an honest "feed unavailable" message instead of "no earnings".
    const anyData = prox.some(x => x && x.daysUntil != null);
    if (!anyData) return { feedUnavailable: true, rows: [] };
    // 2. Keep upcoming-within-window, sort soonest first, cap.
    const upcoming = prox
        .filter(x => x && x.daysUntil != null && x.daysUntil >= 0 && x.daysUntil <= windowDays)
        .sort((a, b) => a.daysUntil - b.daysUntil)
        .slice(0, MAX_ROWS);
    if (!upcoming.length) return [];
    // 3. Engine read for each (bulkScan: fast, approximate — fine for a
    //    list view; the click-through gives the full-fidelity card).
    const withSignal = await mapLimit(upcoming, 4, async (row) => {
        try {
            const entry = await analyzeAndCache(row.sym, 'today', 'stock', null, { bulkScan: true });
            return { ...row, signal: entry.signal.signal, confidence: entry.signal.confidence };
        } catch (_) {
            return { ...row, signal: null, confidence: null };
        }
    });
    return withSignal;
}

function renderRows(rows) {
    // gather() may return {feedUnavailable:true} when the earnings feed is down.
    if (rows && rows.feedUnavailable) {
        return '<div class="earnings-cal-empty">Earnings dates are temporarily unavailable — the free data feed for the earnings calendar isn’t responding right now. The engine’s BUY/SELL calls still work; check back later for the earnings overlay.</div>';
    }
    if (!rows || !rows.length) {
        return '<div class="earnings-cal-empty">No earnings in the selected window across the large-cap universe.</div>';
    }
    return `<div class="earnings-cal-list">${rows.map(r => `
        <div class="earnings-cal-row" data-symbol="${r.sym}">
            <span class="earnings-cal-when ${whenClass(r.daysUntil)}">${whenLabel(r.daysUntil)}</span>
            <span><span class="earnings-cal-sym">${displayTicker(r.sym)}</span></span>
            ${r.signal ? `<span class="earnings-cal-sig ${sigClass(r.signal)}">${sigLabel(r.signal)}</span>` : '<span class="earnings-cal-sig neutral">—</span>'}
            <span class="earnings-cal-conf">${r.confidence != null ? r.confidence + '%' : ''}</span>
        </div>`).join('')}</div>`;
}

async function loadInto(host, { force = false } = {}) {
    if (loading) return;
    if (loaded && !force) return;
    loading = true;
    host.innerHTML = '<div class="earnings-cal-loading">Scanning the large-cap universe for upcoming earnings…</div>';
    try {
        const rows = await gather(DEFAULT_WINDOW_DAYS);
        host.innerHTML = renderRows(rows);
        bindRowClicks(host);
        loaded = true;
    } catch (_) {
        host.innerHTML = '<div class="earnings-cal-empty">Failed to load the earnings calendar.</div>';
    } finally {
        loading = false;
    }
}

function bindRowClicks(host) {
    host.querySelectorAll('.earnings-cal-row').forEach(row => {
        if (row.dataset.bound) return;
        row.dataset.bound = '1';
        row.addEventListener('click', () => loadSymbolIntoChart(row.dataset.symbol));
    });
}

// Reuse the same search-input → result-click path the watchlist uses to
// load a symbol into the chart, so we don't duplicate the routing logic.
function loadSymbolIntoChart(sym) {
    const input = document.getElementById('search-input');
    if (!input) return;
    input.value = sym;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => {
        document.querySelector(`.search-result-item[data-symbol="${sym}"]`)?.click();
    }, 400);
}

export function initEarningsCalendar() {
    if (document.getElementById('earnings-cal-section')) return;
    const after = document.getElementById('sector-heatmap-section')
        || document.getElementById('scanner-section')
        || document.querySelector('.hotpicks-section');
    if (!after) return;
    const html = `
        <section class="earnings-cal-section" id="earnings-cal-section">
            <details class="earnings-cal-details">
                <summary class="earnings-cal-summary">
                    <span class="earnings-cal-title">📅 Upcoming Earnings</span>
                    <span class="earnings-cal-hint">Large-cap earnings in the next 2 weeks, with the engine's pre-earnings read</span>
                    <button class="earnings-cal-refresh" id="earnings-cal-refresh" title="Refresh earnings calendar">↻</button>
                </summary>
                <div class="earnings-cal-host" id="earnings-cal-host"></div>
            </details>
        </section>`;
    after.insertAdjacentHTML('afterend', html);

    const details = document.querySelector('#earnings-cal-section .earnings-cal-details');
    const host = document.getElementById('earnings-cal-host');
    details.addEventListener('toggle', () => { if (details.open) loadInto(host); });
    document.getElementById('earnings-cal-refresh').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        loadInto(host, { force: true });
    });
}

// Programmatic open for Mia's open_earnings_calendar tool.
export function openEarningsCalendar() {
    initEarningsCalendar();
    const details = document.querySelector('#earnings-cal-section .earnings-cal-details');
    if (!details) return false;
    details.open = true;
    const host = document.getElementById('earnings-cal-host');
    if (host) loadInto(host);
    document.getElementById('earnings-cal-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
}

// Data accessor for Mia to answer "who reports this week?" without
// opening the panel. Returns the gathered rows (cached after first call).
let _miaCache = null;
export async function getUpcomingEarningsForMia(windowDays = DEFAULT_WINDOW_DAYS) {
    try {
        if (_miaCache && _miaCache.windowDays === windowDays) return _miaCache.rows;
        const result = await gather(windowDays);
        const rows = Array.isArray(result) ? result : (result?.rows || []);
        _miaCache = { windowDays, rows };
        return rows;
    } catch (_) { return []; }
}
