// Full Ledger — sortable, filterable table over today's predictions
// for the entire global universe. Drives the SAME computeFullConfidence
// pipeline as the detail card at the top of the page (with bulkScan:
// false) so a row's verdict matches the detail card byte-for-byte.
//
// Three click behaviours:
//   - clicking the symbol cell  → loads it into the main top chart +
//                                 detail card (full analysis upstairs).
//   - clicking elsewhere on the row → expands an inline drawer below
//                                 the row showing the same analysis
//                                 fields (signal, confidence, sources,
//                                 top reasons, price targets).
//   - clicking the row again or its expanded drawer's × → collapses.
//
// Prediction Accuracy column: per-symbol hit rate aggregated across
// every resolved horizon in the live ledger (1d/3d/5d/10d/20d). The
// underlying assumption per the user's spec is that every resolved
// horizon is one prediction; "12/20" means 12 of the last 20 resolved
// horizons for THAT symbol hit the predicted direction. Colour bar
// gradients smoothly across the percentage range — red < 45, amber
// 45-70, green > 70 — interpolated, not stepped.

import { GLOBAL_POOL, UNIVERSE_CONFIG, PENNY_POOL } from '../markets.js';
import { analyzeAndCache, peek } from '../analysis-cache.js';
import { calculateRSI } from '../analysis.js';
import { fmtPrice } from './format.js';

let scanState = {
    started: false,
    running: false,
    aborted: false,
    rows: [],
    historyByKey: {},
    accuracyBySymbol: {},
    progress: { done: 0, total: 0, errors: 0 },
};

let sortKey = 'confidence';
let sortDir = 'desc';
let expandedSymbol = null;       // currently inline-expanded symbol, or null

// ── Ledger history + accuracy aggregation ────────────────────────────

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

function buildHistoryIndex(rows) {
    const out = {};
    for (const r of rows) {
        if (!r.symbol) continue;
        const cur = out[r.symbol];
        if (!cur || (r.date || '') > (cur.date || '')) out[r.symbol] = r;
    }
    return out;
}

// Per-symbol accuracy: count every resolved horizon row where
// directionMatch is set (true or false), and how many were true.
// "12/20 = 12 hits out of 20 resolved predictions for this symbol."
function buildAccuracyIndex(rows) {
    const out = {};
    for (const r of rows) {
        if (!r.symbol || !r.horizons) continue;
        // Only count predictions that committed to a direction. NEUTRAL
        // and NO_TRADE setups don't make a directional claim, so
        // counting them as "hits" or "misses" would be noise.
        if (r.signal !== 'BUY' && r.signal !== 'SELL') continue;
        const slot = (out[r.symbol] ||= { hits: 0, total: 0 });
        for (const k of Object.keys(r.horizons)) {
            const h = r.horizons[k];
            if (!h || h.directionMatch == null) continue;
            slot.total++;
            if (h.directionMatch) slot.hits++;
        }
    }
    return out;
}

// ── Universe ─────────────────────────────────────────────────────────

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
    // Include the penny universe so the Full Ledger covers them too.
    // Same pool that hotpicks.js scans + the cron records — single
    // source of truth via js/penny-universe.js.
    for (const s of PENNY_POOL) set.add(s);
    return [...set];
}

// ── Scanning ─────────────────────────────────────────────────────────

async function scanOne(symbol, mode = 'stock') {
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
    return {
        symbol,
        region: inferRegion(symbol),
        signal: sig.signal || 'NEUTRAL',
        confidence: Math.round(sig.confidence || 0),
        entry: last?.close ?? null,
        indicators: { rsi: calculateRSI(closes) ?? null },
        // Hold a reference to the engine result so the inline drawer
        // can re-render without re-running the pipeline.
        _signal: sig,
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
    scanState.accuracyBySymbol = buildAccuracyIndex(history);
    refresh();

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
            if (scanState.progress.done % 4 === 0) refresh();
        }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
    scanState.running = false;
    refresh();
}

// ── Filter / sort ────────────────────────────────────────────────────

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
    if (key === 'accuracy') {
        const a = scanState.accuracyBySymbol[row.symbol];
        if (!a || !a.total) return -1;       // no data sorts last on desc
        return a.hits / a.total;
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

// ── Render ───────────────────────────────────────────────────────────

function fmtSignal(signal) {
    if (signal === 'BUY') return '<span class="scanner-sig sig-buy">▲ BUY</span>';
    if (signal === 'SELL') return '<span class="scanner-sig sig-sell">▼ SELL</span>';
    if (signal === 'NO_TRADE') return '<span class="scanner-sig sig-no_trade">⊘ AVOID</span>';
    return '<span class="scanner-sig sig-neutral">◆ DON\'T BUY</span>';
}

// Smooth red→amber→green gradient based on hit-rate percentage.
// Per Roshan's spec: above 70 = green, 45–60 = amber, below 45 = red,
// gradiented (not stepped) across the in-between values.
//   < 45    : pure red
//   45 → 60 : red → amber blend
//   60 → 70 : amber → green blend
//   > 70    : pure green
// Returns an HSL string so the colour shifts smoothly with the value.
function accuracyColor(pct) {
    if (!Number.isFinite(pct)) return 'var(--text-muted)';
    let hue;
    if (pct < 45) hue = 0;                       // red
    else if (pct < 60) hue = ((pct - 45) / 15) * 45;        // 0 → 45 (red → amber)
    else if (pct < 70) hue = 45 + ((pct - 60) / 10) * 75;   // 45 → 120 (amber → green)
    else hue = 120;                              // green
    return `hsl(${hue}, 75%, 48%)`;
}

function fmtAccuracy(symbol) {
    const a = scanState.accuracyBySymbol[symbol];
    if (!a || !a.total) {
        return '<div class="acc-cell"><span class="acc-empty">no resolved predictions yet</span></div>';
    }
    const pct = (a.hits / a.total) * 100;
    const color = accuracyColor(pct);
    return `
        <div class="acc-cell">
            <div class="acc-frac">${a.hits}/${a.total}</div>
            <div class="acc-pct" style="color:${color}">${pct.toFixed(0)}% Success Rate</div>
            <div class="acc-bar"><div class="acc-bar-fill" style="width:${pct.toFixed(1)}%; background:${color}"></div></div>
        </div>`;
}

// Inline drawer rendered beneath the clicked row. Reuses the engine's
// .breakdown / .reasons / .priceTargets so the user sees the same
// analysis they'd see in the detail card upstairs, without leaving the
// table.
function renderDrawer(row) {
    const sig = row._signal;
    if (!sig) return '<div class="scanner-drawer-empty">Analysis unavailable for this row.</div>';
    const breakdown = sig.breakdown || {};
    const reasons = (sig.reasons || []).slice(0, 8);
    const tgt = sig.priceTargets;
    const co = { srcCurrency: 'USD' };  // ledger entries currency-aware via formatter

    const sourceRows = ['ai', 'technical', 'sentiment', 'market']
        .filter(k => breakdown[k])
        .map(k => {
            const b = breakdown[k];
            const score = Math.round(b.score || 0);
            const weight = Math.round(b.weight || 0);
            const label = k === 'ai' ? 'AI Model' : k.charAt(0).toUpperCase() + k.slice(1);
            return `
                <div class="drawer-source">
                    <span class="drawer-source-label">${label} <span class="drawer-source-weight">(${weight}%)</span></span>
                    <span class="drawer-source-bar"><span class="drawer-source-fill" style="width:${score}%"></span></span>
                    <span class="drawer-source-score">${score}</span>
                </div>`;
        }).join('');

    const reasonsHTML = reasons.length
        ? `<ul class="drawer-reasons">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`
        : '<p class="drawer-empty-reasons">No driver explanations from the engine for this run.</p>';

    const targetsHTML = tgt ? `
        <div class="drawer-targets">
            <div class="drawer-target"><span class="drawer-target-label">Possible High</span> <span class="drawer-target-value high">${fmtPrice(tgt.predictedHigh, co)} ▲ +${tgt.highPercent}%</span></div>
            <div class="drawer-target"><span class="drawer-target-label">Current</span> <span class="drawer-target-value">${fmtPrice(tgt.currentPrice, co)}</span></div>
            <div class="drawer-target"><span class="drawer-target-label">Possible Low</span> <span class="drawer-target-value low">${fmtPrice(tgt.predictedLow, co)} ▼ ${tgt.lowPercent}%</span></div>
        </div>` : '';

    return `
        <div class="scanner-drawer">
            <div class="drawer-head">
                <div class="drawer-verdict ${row.signal.toLowerCase()}">
                    <span class="drawer-verdict-arrow">${row.signal === 'BUY' ? '▲' : row.signal === 'SELL' ? '▼' : row.signal === 'NO_TRADE' ? '⊘' : '◆'}</span>
                    <span class="drawer-verdict-label">${row.signal === 'NO_TRADE' ? 'AVOID' : row.signal === 'NEUTRAL' ? "DON'T BUY" : row.signal}</span>
                    <span class="drawer-verdict-conf">${row.confidence}% confidence</span>
                </div>
                <button class="drawer-close" type="button" aria-label="Collapse" data-action="collapse">×</button>
            </div>
            <div class="drawer-section-title">Confidence Sources</div>
            <div class="drawer-sources">${sourceRows || '<div class="drawer-empty-reasons">No source breakdown.</div>'}</div>
            ${targetsHTML}
            <div class="drawer-section-title">Why this signal — top drivers</div>
            ${reasonsHTML}
            <div class="drawer-foot">
                <button class="drawer-load-chart" type="button" data-action="load-chart" data-symbol="${row.symbol}">Open in chart above ↑</button>
            </div>
        </div>`;
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
    tbody.innerHTML = rows.map(r => {
        const isExpanded = expandedSymbol === r.symbol;
        const drawerRow = isExpanded
            ? `<tr class="scanner-drawer-row"><td colspan="7">${renderDrawer(r)}</td></tr>`
            : '';
        return `
            <tr class="scanner-row ${isExpanded ? 'expanded' : ''}" data-symbol="${r.symbol}">
                <td class="scanner-symbol"><a href="#" class="scanner-symbol-link" data-action="load-chart" data-symbol="${r.symbol}">${r.symbol}</a></td>
                <td class="scanner-region">${r.region || '-'}</td>
                <td>${fmtSignal(r.signal)}</td>
                <td class="scanner-num"><span class="scanner-conf-bar"><span class="scanner-conf-fill" style="width: ${Math.max(0, Math.min(100, r.confidence))}%"></span></span><span class="scanner-conf-num">${r.confidence}%</span></td>
                <td class="scanner-num">${typeof r.entry === 'number' ? r.entry.toFixed(2) : '-'}</td>
                <td class="scanner-num">${r.indicators?.rsi != null ? r.indicators.rsi.toFixed(1) : '-'}</td>
                <td class="scanner-acc">${fmtAccuracy(r.symbol)}</td>
            </tr>
            ${drawerRow}`;
    }).join('');
}

function updateMeta() {
    const el = document.getElementById('scanner-meta');
    if (!el) return;
    const { done, total, errors } = scanState.progress;
    const shown = applyFilters(scanState.rows).length;
    if (!total) { el.textContent = ''; return; }
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

// ── Click handling ───────────────────────────────────────────────────

function loadInMainChart(sym) {
    const input = document.getElementById('search-input');
    if (input) {
        input.value = sym;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
            document.querySelector(`.search-result-item[data-symbol="${sym}"]`)?.click();
        }, 400);
    }
    // Scroll up so the user actually sees the chart they just loaded.
    document.querySelector('.chart-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleExpand(sym) {
    expandedSymbol = (expandedSymbol === sym) ? null : sym;
    renderRows();
}

export async function initScanner() {
    const section = document.getElementById('scanner-section');
    if (!section) return;
    const details = section.querySelector('.scanner-details');
    if (!details) return;

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
        const action = e.target.closest('[data-action]')?.dataset.action;
        const sym = e.target.closest('[data-symbol]')?.dataset.symbol
                  || e.target.closest('.scanner-row')?.dataset.symbol;
        if (!sym) return;

        // Symbol-name click OR the drawer's "Open in chart above" button:
        // load this symbol into the main chart + detail card upstairs.
        if (action === 'load-chart') {
            e.preventDefault();
            loadInMainChart(sym);
            return;
        }
        // Drawer × button: collapse the drawer.
        if (action === 'collapse') {
            e.preventDefault();
            expandedSymbol = null;
            renderRows();
            return;
        }
        // Anywhere else on the row: toggle inline drawer.
        toggleExpand(sym);
    });
}
