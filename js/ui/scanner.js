// Full ledger scanner — sortable, filterable table over today's
// predictions for the entire global universe.
//
// Why this used to disagree with the detail card:
//   The previous version pulled rows from model/ledger/<year>.jsonl,
//   which is written by a Python cron using a simple RSI/MACD/BB voting
//   heuristic (see backtest.py::generate_prediction). The detail card
//   at the top of the page runs computeFullConfidence — the production
//   JS engine with LSTM, sentiment, market context, calibration, and
//   ~20 enrichments. They are not the same engine, so the same symbol
//   could read "BUY 64%" in this table and "DON'T BUY 53%" in the card.
//
// Fix: this scanner now drives the SAME computeFullConfidence pipeline
// as the detail card, with bulkScan: false. Rows are streamed in as
// they compute, with concurrency clamped so we don't saturate the data
// proxies. Resolution columns (1d/3d/5d hit) are still joined from the
// historical ledger because that's the only source of "did the past
// prediction actually hit?".
//
// Trade-off: a full universe scan takes minutes, not seconds. We stream
// progressively so the user sees results as they land, and any row the
// scanner computes is cached via analysis-cache.js — clicking that
// symbol later in the same session is instant.

import { GLOBAL_POOL, UNIVERSE_CONFIG } from '../markets.js';
import { analyzeAndCache, peek } from '../analysis-cache.js';
import { calculateRSI } from '../analysis.js';

let scanState = {
    started: false,
    running: false,
    aborted: false,
    rows: [],            // computed scanner rows
    historyByKey: {},    // ledger history keyed by symbol → { horizons }
    progress: { done: 0, total: 0, errors: 0 },
};

let sortKey = 'confidence';
let sortDir = 'desc';

// ── Ledger history (for resolution columns only) ─────────────────────

let cachedHistory = null;
async function loadLedgerHistory() {
    if (cachedHistory) return cachedHistory;
    const year = new Date().getUTCFullYear();
    try {
        const res = await fetch(`./model/ledger/${year}.jsonl`);
        if (!res.ok) { cachedHistory = []; return cachedHistory; }
        const text = await res.text();
        const rows = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { rows.push(JSON.parse(t)); } catch (_) {}
        }
        cachedHistory = rows;
        return rows;
    } catch (_) {
        cachedHistory = [];
        return [];
    }
}

// Build a map: symbol → most recent resolved horizons. Used to fill
// the "1d hit" column with historical resolution data so users can
// see which symbols the engine has read correctly in the past.
function buildHistoryIndex(rows) {
    const out = {};
    for (const r of rows) {
        if (!r.symbol) continue;
        const cur = out[r.symbol];
        if (!cur || (r.date || '') > (cur.date || '')) out[r.symbol] = r;
    }
    return out;
}

// ── Universe ─────────────────────────────────────────────────────────

// Static sample of liquid US large-caps to scan alongside the global
// pool. The cron's universe is bigger but we keep this list focused so
// a UI scan doesn't take forever. Users can still search any symbol;
// this is just the seed list for the scanner table.
const US_SEED = [
    'AAPL','MSFT','GOOGL','GOOG','AMZN','META','NVDA','TSLA','AVGO','ORCL',
    'JPM','V','MA','BAC','WFC','GS','MS','C','BLK','AXP',
    'XOM','CVX','COP','SLB','OXY','EOG','MPC','PSX','VLO','HAL',
    'UNH','LLY','JNJ','PFE','ABBV','MRK','TMO','ABT','DHR','BMY',
    'WMT','COST','HD','LOW','TGT','MCD','SBUX','NKE','LULU','TJX',
    'KO','PEP','PG','KMB','CL','MO','PM','MDLZ','GIS','HSY',
    'AMD','INTC','QCOM','MU','ADBE','CRM','ACN','TXN','PANW','CRWD',
    'BA','GE','HON','RTX','LMT','NOC','GD','UPS','FDX','CAT',
    'NFLX','DIS','SHOP','PYPL','UBER','SOFI','HOOD','ABNB','SQ','PLTR',
    'F','GM','RIVN','LCID','NIO','LI','XPEV','BABA','PDD','JD',
];

function buildUniverse() {
    const set = new Set();
    if (UNIVERSE_CONFIG?.useUSScreeners) for (const s of US_SEED) set.add(s);
    for (const s of GLOBAL_POOL) set.add(s);
    return [...set];
}

// ── Scanning ─────────────────────────────────────────────────────────

async function scanOne(symbol, mode = 'stock') {
    // Reuse cached entry if it's already been computed at full fidelity.
    const cached = peek(symbol, 'today', mode);
    if (cached && cached.fresh && cached.bulkScan === false) {
        return entryToRow(symbol, cached);
    }
    const entry = await analyzeAndCache(symbol, 'today', mode, null, { bulkScan: false });
    return entryToRow(symbol, entry);
}

function entryToRow(symbol, entry) {
    const sig = entry?.signal;
    if (!sig) return null;
    const candles = entry?.data?.daily?.candles || [];
    const last = candles[candles.length - 1];
    const closes = candles.map(c => c.close);
    // computeFullConfidence returns the final verdict on .signal — same
    // field the detail card reads from. So picking it up here guarantees
    // the scanner row matches whatever the card shows for that symbol.
    return {
        symbol,
        region: inferRegion(symbol),
        signal: sig.signal || 'NEUTRAL',
        confidence: Math.round(sig.confidence || 0),
        entry: last?.close ?? null,
        indicators: { rsi: calculateRSI(closes) ?? null },
    };
}

function inferRegion(symbol) {
    if (symbol.endsWith('.NS')) return 'NSE';
    if (symbol.endsWith('.HK')) return 'HKEX';
    if (symbol.endsWith('.T'))  return 'TYO';
    if (symbol.endsWith('.L'))  return 'LSE';
    if (symbol.endsWith('.DE')) return 'XETRA';
    if (symbol.endsWith('.AX')) return 'ASX';
    if (symbol.endsWith('-USD')) return 'CRYPTO';
    return 'NYSE';
}

async function startScan() {
    if (scanState.started) return;
    scanState.started = true;
    scanState.running = true;
    scanState.aborted = false;

    const symbols = buildUniverse();
    scanState.progress = { done: 0, total: symbols.length, errors: 0 };

    const history = await loadLedgerHistory();
    scanState.historyByKey = buildHistoryIndex(history);
    refresh();

    // Concurrency 4 — small enough that worker proxies don't get
    // hammered, large enough that a full universe scan completes in
    // a few minutes instead of an hour.
    const CONCURRENCY = 4;
    let cursor = 0;

    async function worker() {
        while (!scanState.aborted) {
            const i = cursor++;
            if (i >= symbols.length) return;
            const sym = symbols[i];
            try {
                const row = await scanOne(sym);
                if (row) scanState.rows.push(row);
            } catch (_) {
                scanState.progress.errors++;
            }
            scanState.progress.done++;
            // Throttle UI refresh — every 4 rows or every ~250ms,
            // whichever comes first, so we don't thrash innerHTML.
            if (scanState.progress.done % 4 === 0) refresh();
        }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
    scanState.running = false;
    refresh();
}

// ── Filtering / sorting / rendering ──────────────────────────────────

function applyFilters(rows) {
    const filterText = (document.getElementById('scanner-filter')?.value || '').trim().toUpperCase();
    const filterSignal = document.getElementById('scanner-signal-filter')?.value || '';
    return rows.filter(r => {
        if (filterSignal && r.signal !== filterSignal) return false;
        if (filterText) {
            const hay = `${r.symbol} ${r.region}`.toUpperCase();
            if (!hay.includes(filterText)) return false;
        }
        return true;
    });
}

function getSortValue(row, key) {
    if (key === 'symbol' || key === 'region' || key === 'signal') return String(row[key] || '');
    if (key === 'confidence') return Number(row.confidence) || 0;
    if (key === 'entry') return Number(row.entry) || 0;
    if (key === 'rsi') return Number(row.indicators?.rsi) || 0;
    if (key === 'hit1d') {
        const slot = scanState.historyByKey[row.symbol]?.horizons?.['1'];
        if (!slot || slot.directionMatch == null) return -1;
        return slot.directionMatch ? 1 : 0;
    }
    return 0;
}

function sortRows(rows) {
    const dir = sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
        const av = getSortValue(a, sortKey);
        const bv = getSortValue(b, sortKey);
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
        return (av - bv) * dir;
    });
}

// Mirror the detail-card translation in js/ui/signal.js: the engine
// internally uses BUY / SELL / NEUTRAL / NO_TRADE (so the ledger and
// calibration tables stay valid), but the UI surfaces decisive labels
// per Roshan's "say things with conviction" rule.
//   BUY      → BUY        (clear bullish edge)
//   SELL     → SELL       (clear bearish edge)
//   NEUTRAL  → DON'T BUY  (no edge, sit out)
//   NO_TRADE → AVOID      (event-risk cap — earnings, gap, etc)
function fmtSignal(signal) {
    if (signal === 'BUY') return '<span class="scanner-sig sig-buy">▲ BUY</span>';
    if (signal === 'SELL') return '<span class="scanner-sig sig-sell">▼ SELL</span>';
    if (signal === 'NO_TRADE') return '<span class="scanner-sig sig-no_trade">⊘ AVOID</span>';
    return '<span class="scanner-sig sig-neutral">◆ DON\'T BUY</span>';
}

function fmtHit1d(symbol) {
    const slot = scanState.historyByKey[symbol]?.horizons?.['1'];
    if (!slot || slot.directionMatch == null) return '<span class="hit-pending">pending</span>';
    return slot.directionMatch
        ? '<span class="hit-yes">✓ hit</span>'
        : '<span class="hit-no">✗ miss</span>';
}

function renderRows() {
    const tbody = document.getElementById('scanner-tbody');
    if (!tbody) return;
    const filtered = applyFilters(scanState.rows);
    const rows = sortRows(filtered);
    if (!rows.length) {
        const msg = scanState.running
            ? 'Scanning the global universe — rows will stream in as they compute…'
            : 'No matching rows. Try clearing filters.';
        tbody.innerHTML = `<tr><td colspan="7" class="scanner-empty">${msg}</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => `
        <tr class="scanner-row" data-symbol="${r.symbol}">
            <td class="scanner-symbol">${r.symbol}</td>
            <td class="scanner-region">${r.region || '-'}</td>
            <td>${fmtSignal(r.signal)}</td>
            <td class="scanner-num"><span class="scanner-conf-bar"><span class="scanner-conf-fill" style="width: ${Math.max(0, Math.min(100, r.confidence))}%"></span></span><span class="scanner-conf-num">${r.confidence}%</span></td>
            <td class="scanner-num">${typeof r.entry === 'number' ? r.entry.toFixed(2) : '-'}</td>
            <td class="scanner-num">${r.indicators?.rsi != null ? r.indicators.rsi.toFixed(1) : '-'}</td>
            <td class="scanner-num">${fmtHit1d(r.symbol)}</td>
        </tr>
    `).join('');
}

function updateMeta() {
    const el = document.getElementById('scanner-meta');
    if (!el) return;
    const { done, total, errors } = scanState.progress;
    const shown = applyFilters(scanState.rows).length;
    if (!total) {
        el.textContent = '';
        return;
    }
    if (scanState.running) {
        el.textContent = `Scanning ${done} / ${total}${errors ? ` (${errors} errors)` : ''} — ${shown} ready`;
    } else {
        el.textContent = `${shown} of ${scanState.rows.length} symbols${errors ? ` · ${errors} errors` : ''}`;
    }
}

function refresh() {
    renderRows();
    updateMeta();
}

function updateSortHeaders() {
    document.querySelectorAll('.scanner-table thead th[data-sort]').forEach(th => {
        const k = th.dataset.sort;
        th.classList.toggle('sorted', k === sortKey);
        th.classList.toggle('sort-asc', k === sortKey && sortDir === 'asc');
        th.classList.toggle('sort-desc', k === sortKey && sortDir === 'desc');
    });
}

export async function initScanner() {
    const section = document.getElementById('scanner-section');
    if (!section) return;
    const details = section.querySelector('.scanner-details');
    if (!details) return;

    // Lazy-start: only kick off the scan when the user actually opens
    // the panel. We also fetch the historical ledger here so the
    // "1d hit" column can be filled in even before the live engine
    // has finished computing.
    details.addEventListener('toggle', () => {
        if (details.open && !scanState.started) startScan();
    });

    document.getElementById('scanner-filter')?.addEventListener('input', refresh);
    document.getElementById('scanner-signal-filter')?.addEventListener('change', refresh);

    document.querySelectorAll('.scanner-table thead th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const k = th.dataset.sort;
            if (k === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            else { sortKey = k; sortDir = (k === 'symbol' || k === 'region' || k === 'signal') ? 'asc' : 'desc'; }
            updateSortHeaders();
            renderRows();
        });
    });
    updateSortHeaders();

    document.getElementById('scanner-tbody')?.addEventListener('click', (e) => {
        const tr = e.target.closest('.scanner-row');
        if (!tr) return;
        const sym = tr.dataset.symbol;
        if (!sym) return;
        const input = document.getElementById('search-input');
        if (input) {
            input.value = sym;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
                document.querySelector(`.search-result-item[data-symbol="${sym}"]`)?.click();
            }, 400);
        }
    });
}
