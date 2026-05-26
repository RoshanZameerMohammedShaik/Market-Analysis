// Full ledger scanner — sortable, filterable table over the daily-cron
// generated predictions for the entire global universe (~620 symbols).
//
// Why this is cheap: the ledger is already a static JSONL file at
// model/ledger/<year>.jsonl, written by the GitHub Actions cron at
// market open. Loading it is one fetch + a parse, no Yahoo proxy hits,
// no rate limits, no per-row computation. Scales to any universe size.
//
// What the user gets: a power-user view that ranks every symbol the
// cron scored today by confidence, with quick filters by signal /
// region / text search. Cron writes ~620 rows/day; we fetch the whole
// year (a few thousand rows worst-case) and slice today's date in JS.

let cachedRows = null;
let cachedTs = 0;
const CACHE_MS = 5 * 60 * 1000;

let activeRows = [];          // today's rows after date filter
let displayedRows = [];        // after text/signal filter, ready to render
let sortKey = 'confidence';
let sortDir = 'desc';

async function loadLedger() {
    if (cachedRows && Date.now() - cachedTs < CACHE_MS) return cachedRows;
    const year = new Date().getUTCFullYear();
    try {
        const res = await fetch(`./model/ledger/${year}.jsonl`);
        if (!res.ok) { cachedRows = []; cachedTs = Date.now(); return cachedRows; }
        const text = await res.text();
        const rows = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { rows.push(JSON.parse(t)); } catch (_) {}
        }
        cachedRows = rows;
        cachedTs = Date.now();
        return rows;
    } catch (_) {
        cachedRows = [];
        cachedTs = Date.now();
        return [];
    }
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function sliceToday(rows) {
    const today = todayIso();
    const todayRows = rows.filter(r => r.date === today);
    if (todayRows.length) return todayRows;
    // If today's cron hasn't fired yet (early UTC), show the most recent
    // date the ledger has any rows for. Better than empty table.
    const dates = [...new Set(rows.map(r => r.date))].sort().reverse();
    if (!dates.length) return [];
    return rows.filter(r => r.date === dates[0]);
}

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
        const slot = row.horizons?.['1'];
        if (!slot || slot.directionMatch === null || slot.directionMatch === undefined) return -1; // unresolved sorts last
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

function fmtSignal(signal) {
    if (signal === 'NO_TRADE') return '<span class="scanner-sig sig-no_trade">⊘ NO TRADE</span>';
    if (signal === 'BUY') return '<span class="scanner-sig sig-buy">▲ BUY</span>';
    if (signal === 'SELL') return '<span class="scanner-sig sig-sell">▼ SELL</span>';
    return '<span class="scanner-sig sig-neutral">◆ NEUTRAL</span>';
}

function fmtHit1d(row) {
    const slot = row.horizons?.['1'];
    if (!slot || slot.directionMatch === null || slot.directionMatch === undefined) return '<span class="hit-pending">pending</span>';
    return slot.directionMatch
        ? '<span class="hit-yes">✓ hit</span>'
        : '<span class="hit-no">✗ miss</span>';
}

function renderRows() {
    const tbody = document.getElementById('scanner-tbody');
    if (!tbody) return;
    const rows = sortRows(displayedRows);
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="scanner-empty">No matching rows. Try clearing filters or check that today\'s ledger row has been written.</td></tr>';
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
            <td class="scanner-num">${fmtHit1d(r)}</td>
        </tr>
    `).join('');
}

function updateMeta() {
    const el = document.getElementById('scanner-meta');
    if (!el) return;
    const total = activeRows.length;
    const shown = displayedRows.length;
    if (total === 0) {
        el.textContent = 'No data — ledger empty (cron may not have fired yet).';
    } else if (shown === total) {
        el.textContent = `${total} symbols`;
    } else {
        el.textContent = `${shown} of ${total} symbols`;
    }
}

function refresh() {
    displayedRows = applyFilters(activeRows);
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

    // Lazy-load the ledger only when the user actually opens the panel.
    // Saves bandwidth on first paint for users who never expand it.
    let loaded = false;
    const ensureLoaded = async () => {
        if (loaded) return;
        loaded = true;
        const rows = await loadLedger();
        activeRows = sliceToday(rows);
        refresh();
    };

    details.addEventListener('toggle', () => {
        if (details.open) ensureLoaded();
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

    // Click a row to load that symbol in the analyzer.
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
