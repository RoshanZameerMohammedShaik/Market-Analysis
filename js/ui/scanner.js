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

import { GLOBAL_POOL, UNIVERSE_CONFIG, PENNY_POOL, CRYPTO_POOL } from '../markets.js';
import { analyzeAndCache, peek } from '../analysis-cache.js';
import { calculateRSI } from '../analysis.js';
import { fmtPrice } from './format.js';
import { state } from './state.js';

let scanState = {
    started: false,
    running: false,
    aborted: false,
    aborting: false,         // set when a mode-switch wants the running scan to stop
    mode: null,              // 'stock' | 'crypto' — set by startScan(), used to gate restart
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

// Per-symbol accuracy in the format Roshan asked for:
//   hits / misses / total / days_since_first_prediction
//
// Definitions:
//   total      = every committed (BUY/SELL) prediction-row for this
//                symbol, across every prediction-date the cron ever
//                made one. NEUTRAL/NO_TRADE rows excluded — they
//                make no directional claim. Increments by +1 per
//                new prediction the engine commits to.
//   hits       = of those, how many had AT LEAST ONE resolved horizon
//                hit the predicted direction. +1 per right call.
//   misses     = had AT LEAST ONE resolved horizon AND none hit. +1
//                per wrong call.
//   pending    = total - (hits + misses). Predictions whose horizons
//                haven't matured yet. Implicit; can be derived.
//   daysSpan   = calendar days from the symbol's first prediction-date
//                to today. Increments by +1 every day, regardless of
//                whether a new prediction was made today.
//
// Invariant: hits + misses ≤ total. When a new prediction lands,
// total bumps by 1 (not hits or misses — they only move once that
// row's first horizon resolves). When a horizon resolves, exactly
// one of {hits, misses} bumps. Roshan's spec: "if right it will be
// 12+1 otherwise if it's wrong then it will be 8+1 not for 12".
// Read the user's window inputs and translate to a cutoff ISO date.
// Returns null when "all time" is selected or when the input is
// blank / invalid — meaning the aggregator runs against the full
// history. Days/months/years are calendar-relative (subtracts from
// today), not trading-day-relative — months use ~30.44 days, years
// use 365 to keep arithmetic simple and stable.
function computeAccuracyCutoff() {
    const nEl = document.getElementById('scanner-window-n');
    const uEl = document.getElementById('scanner-window-unit');
    if (!uEl || uEl.value === 'all') return null;
    const n = Number(nEl?.value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const days = uEl.value === 'days' ? n
              : uEl.value === 'months' ? n * 30.44
              : uEl.value === 'years' ? n * 365
              : 0;
    if (days <= 0) return null;
    const cutoff = new Date(Date.now() - days * 86400000);
    return cutoff.toISOString().slice(0, 10);
}

// `window` (when provided) is the inclusive cutoff date in
// 'YYYY-MM-DD' form. Predictions made BEFORE this date are dropped
// from the aggregation. The cell's daysSpan is also clamped to the
// window so the user sees "X/Y/Z/Nd" where Nd ≤ the window length.
// Pass null to use all-time.
function buildAccuracyIndex(rows, windowCutoffISO = null) {
    const out = {};
    const todayMs = Date.now();
    for (const r of rows) {
        if (!r.symbol || r.signal == null) continue;
        if (r.signal !== 'BUY' && r.signal !== 'SELL') continue;
        // Time-window filter — drop predictions older than the cutoff.
        // Comparison is lex-safe because dates are 'YYYY-MM-DD'.
        if (windowCutoffISO && (!r.date || r.date < windowCutoffISO)) continue;

        const slot = (out[r.symbol] ||= {
            hits: 0,
            misses: 0,
            total: 0,
            firstDate: null,
        });
        slot.total++;

        // Track the earliest prediction date so daysSpan can grow
        // forever even if the symbol stops being predicted.
        if (r.date) {
            if (!slot.firstDate || r.date < slot.firstDate) {
                slot.firstDate = r.date;
            }
        }

        // Decide whether this ROW is resolved enough to score.
        // Rule: if ANY horizon has directionMatch set, the row is
        // graded — hit if any horizon hit, miss if none hit. This
        // matches Roshan's "12 right + 8 wrong = 20 graded" mental
        // model (one row → one verdict, not one row → 5 verdicts).
        const horizons = r.horizons || {};
        let anyResolved = false;
        let anyHit = false;
        for (const k of Object.keys(horizons)) {
            const h = horizons[k];
            if (!h || h.directionMatch == null) continue;
            anyResolved = true;
            if (h.directionMatch) { anyHit = true; break; }
        }
        if (!anyResolved) continue;
        if (anyHit) slot.hits++;
        else slot.misses++;
    }
    // Compute daysSpan now that we have firstDate per symbol.
    for (const sym of Object.keys(out)) {
        const slot = out[sym];
        if (!slot.firstDate) { slot.daysSpan = 0; continue; }
        const first = new Date(slot.firstDate + 'T00:00:00Z').getTime();
        slot.daysSpan = Math.max(1, Math.round((todayMs - first) / 86400000));
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

// Branch the universe by the active app mode. In 'stock' mode we
// scan the US seed + global pool + curated penny list. In 'crypto'
// mode we walk the curated CRYPTO_POOL (~250) plus any coins
// CoinGecko's /search/trending surfaces today (top 7-15) so meme/L2
// pumps that aren't on the curated list still get analyzed and
// recorded in the ledger.
async function buildUniverse(mode = 'stock') {
    const set = new Set();
    if (mode === 'crypto') {
        for (const s of CRYPTO_POOL) set.add(s);
        // Dynamic trending union — failure non-fatal, just go with
        // the static list if CoinGecko 503s or the proxy is down.
        try {
            const dynamic = await fetchCoinGeckoTrending();
            for (const s of dynamic) set.add(s);
        } catch (_) { /* non-fatal */ }
    } else {
        if (UNIVERSE_CONFIG?.useUSScreeners) for (const s of US_SEED) set.add(s);
        for (const s of GLOBAL_POOL) set.add(s);
        // Include the penny universe so the Full Ledger covers them too.
        // Same pool that hotpicks.js scans + the cron records — single
        // source of truth via js/penny-universe.js.
        for (const s of PENNY_POOL) set.add(s);
    }
    return [...set];
}

// Dynamic crypto trending — pulls CoinGecko's /search/trending and
// returns BASE-USD symbols. Hits the same Yahoo proxy worker which
// also handles CoinGecko URLs (it forwards anything not matched by a
// specific endpoint). Falls back to direct CoinGecko fetch if the
// proxy 502s. CoinGecko's free tier is generous (50 req/min); we
// only call this on scan start, not per-symbol.
async function fetchCoinGeckoTrending() {
    const url = 'https://api.coingecko.com/api/v3/search/trending';
    let data;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        data = await res.json();
    } catch (_) {
        return [];
    }
    if (!data?.coins) return [];
    return data.coins
        .map(c => c?.item?.symbol)
        .filter(Boolean)
        .map(s => `${String(s).toUpperCase()}-USD`);
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
    const mode = state.mode === 'crypto' ? 'crypto' : 'stock';
    scanState.started = true;
    scanState.running = true;
    scanState.aborted = false;
    scanState.aborting = false;
    scanState.mode = mode;
    scanState.rows = [];           // ensure fresh start (was kept across reopens)

    const symbols = await buildUniverse(mode);
    scanState.progress = { done: 0, total: symbols.length, errors: 0 };

    const history = await loadLedgerHistory();
    scanState.historyByKey = buildHistoryIndex(history);
    scanState.allLedgerRows = history;            // kept for window re-aggregation
    scanState.accuracyBySymbol = buildAccuracyIndex(history, computeAccuracyCutoff());
    refresh();

    const CONCURRENCY = 4;
    let cursor = 0;

    async function worker() {
        while (!scanState.aborted && !scanState.aborting) {
            const i = cursor++;
            if (i >= symbols.length) return;
            const sym = symbols[i];
            try {
                // Pass the scan's locked mode so each per-symbol
                // computeFullConfidence runs with the correct asset
                // class. Earlier scanOne defaulted to 'stock' which
                // is why crypto symbols were getting analyzed as
                // stocks before the engine even saw them.
                const row = await scanOne(sym, mode);
                if (row) scanState.rows.push(row);
            } catch (_) {
                scanState.progress.errors++;
            }
            scanState.progress.done++;
            // Streaming refresh: surgical patch only. Keeps the open
            // drawer's DOM (animations + scroll) intact while new
            // rows land in the background.
            if (scanState.progress.done % 4 === 0) refresh('patch');
        }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
    scanState.running = false;
    // Final tail patch — picks up whatever didn't hit the % 4 cadence.
    refresh('patch');
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
        const graded = a.hits + a.misses;
        if (graded === 0) return -1;          // all pending → also last on desc
        return a.hits / graded;
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
        return '<div class="acc-cell"><span class="acc-empty">no predictions yet</span></div>';
    }
    // Format: hits / misses / total / days
    // Each number is dynamic and grows independently. Success Rate
    // is computed against (hits + misses) — the GRADED set — not
    // total, because pending predictions shouldn't drag the rate
    // down (they haven't been judged yet).
    const graded = a.hits + a.misses;
    const pct = graded > 0 ? (a.hits / graded) * 100 : 0;
    const color = accuracyColor(pct);
    const pending = a.total - graded;
    const tip = `${a.hits} hits · ${a.misses} misses · ${a.total} total predictions · ${a.daysSpan}d since first prediction · ${pending} still pending`;
    // Each number's color reflects engine PERFORMANCE, not just the
    // semantic label. Roshan's spec: if hits < misses, you can't paint
    // hits green — that misrepresents a losing symbol. So we tint
    // hits/misses by which side is winning, and total/days stay
    // neutral (they're not verdicts).
    //
    //   hits   → green if hits >  misses (engine winning on this name)
    //            amber if hits == misses (coin-flip)
    //            red   if hits <  misses (engine losing — green hits would lie)
    //   misses → red   if misses >  hits (engine losing — bad sign)
    //            amber if misses == hits
    //            grey  if misses <  hits (low miss-count is fine — don't shout)
    //   total  → muted accent (neutral count of activity)
    //   days   → muted grey  (purely temporal context)
    //
    // This way a cell like "5/12/17/30d" reads at a glance: green
    // hits would have lied, so hits goes red; misses dominate, red.
    // A cell like "12/8/20/30d" reads: hits dominate → hits green,
    // misses small → grey. The separators + Success Rate bar still
    // carry the gradient color so the overall verdict is unmistakable.
    let hitsClass, missesClass;
    if (a.hits > a.misses) { hitsClass = 'good'; missesClass = 'mute'; }
    else if (a.hits < a.misses) { hitsClass = 'bad'; missesClass = 'bad'; }
    else { hitsClass = 'mid'; missesClass = 'mid'; }   // tie

    return `
        <div class="acc-cell" title="${tip}">
            <div class="acc-frac">
                <span class="acc-hits acc-tone-${hitsClass}">${a.hits}</span><span class="acc-sep">/</span><span class="acc-misses acc-tone-${missesClass}">${a.misses}</span><span class="acc-sep">/</span><span class="acc-total">${a.total}</span><span class="acc-sep">/</span><span class="acc-days">${a.daysSpan}d</span>
            </div>
            <div class="acc-pct" style="color:${color}">${pct.toFixed(0)}% Success Rate${pending ? ` · ${pending} pending` : ''}</div>
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

// Build the inner HTML for a single data <tr> (no drawer attached).
// Pulled out so streaming refreshes can patch only the rows that
// changed without rewriting the whole tbody.
function rowInnerHTML(r) {
    return `<td class="scanner-symbol"><a href="#" class="scanner-symbol-link" data-action="load-chart" data-symbol="${r.symbol}">${r.symbol}</a></td>
            <td class="scanner-region">${r.region || '-'}</td>
            <td>${fmtSignal(r.signal)}</td>
            <td class="scanner-num"><span class="scanner-conf-bar"><span class="scanner-conf-fill" style="width: ${Math.max(0, Math.min(100, r.confidence))}%"></span></span><span class="scanner-conf-num">${r.confidence}%</span></td>
            <td class="scanner-num">${typeof r.entry === 'number' ? r.entry.toFixed(2) : '-'}</td>
            <td class="scanner-num">${r.indicators?.rsi != null ? r.indicators.rsi.toFixed(1) : '-'}</td>
            <td class="scanner-acc">${fmtAccuracy(r.symbol)}</td>`;
}

// Earlier we did `tbody.innerHTML = rows.map(...).join('')` on every
// 4-row streaming refresh, which destroyed and rebuilt the expanded
// drawer's DOM each time — that's the flicker Roshan flagged when
// streaming kept happening behind an open drawer. New strategy:
//   - Empty/sort/filter changes still do a full rebuild (rare — only
//     when the user types a filter or clicks a sort header).
//   - Streaming-only refreshes (called as new rows finish analysis)
//     do a SURGICAL patch: existing rows update in place, new rows
//     get appended, and the expanded drawer is never touched.
// `mode` is 'full' for a full rebuild or 'patch' for the surgical
// stream update. Default is full so existing callers don't break.
function renderRows(mode = 'full') {
    const tbody = document.getElementById('scanner-tbody');
    if (!tbody) return;
    const filtered = applyFilters(scanState.rows);
    const rows = sortRows(filtered);
    if (!rows.length) {
        if (scanState.running) {
            // Animated skeleton loader while the ledger computes — a header
            // line + several shimmer rows (7 cells each, matching the table)
            // so the user sees a live "building" state instead of plain text.
            const cells = (i) => Array.from({ length: 7 }, (_, c) =>
                `<td><span class="sk-cell" style="width:${[58, 40, 46, 50, 44, 36, 62][c]}%; animation-delay:${(i * 0.08 + c * 0.04).toFixed(2)}s"></span></td>`).join('');
            const skelRows = Array.from({ length: 8 }, (_, i) => `<tr class="scanner-skel-row">${cells(i)}</tr>`).join('');
            tbody.innerHTML =
                `<tr class="scanner-loading-row"><td colspan="7">
                    <span class="scanner-loading-dots"><i></i><i></i><i></i></span>
                    <span class="scanner-loading-text">Scanning the global universe — rows stream in as they compute…</span>
                 </td></tr>` + skelRows;
        } else {
            tbody.innerHTML = `<tr><td colspan="7" class="scanner-empty">No matching rows. Try clearing filters.</td></tr>`;
        }
        return;
    }

    if (mode === 'patch') {
        // Surgical update: walk existing rows, update changed cells,
        // append any new symbols at the bottom. Drawer DOM is left
        // alone so animations/scroll don't reset.
        const existing = new Map();
        for (const tr of tbody.querySelectorAll('tr.scanner-row')) {
            existing.set(tr.dataset.symbol, tr);
        }
        for (const r of rows) {
            const tr = existing.get(r.symbol);
            const newHTML = rowInnerHTML(r);
            if (tr) {
                if (tr.innerHTML !== newHTML) tr.innerHTML = newHTML;
                existing.delete(r.symbol);
            } else {
                // Append at the end so we don't disrupt the order
                // of rows the user is looking at. (Sort changes go
                // through the 'full' path which IS a rebuild.)
                const newTr = document.createElement('tr');
                newTr.className = 'scanner-row';
                newTr.dataset.symbol = r.symbol;
                newTr.innerHTML = newHTML;
                tbody.appendChild(newTr);
            }
        }
        // Clean up rows that should no longer be visible (e.g. the
        // user changed the signal filter while a stream was running).
        for (const stale of existing.values()) {
            if (stale.dataset.symbol === expandedSymbol) {
                expandedSymbol = null;   // also remove the orphan drawer below
            }
            stale.remove();
        }
        // If the expanded drawer's row was removed, drop the drawer.
        const orphanDrawer = tbody.querySelector('tr.scanner-drawer-row');
        if (orphanDrawer && !tbody.querySelector('tr.scanner-row.expanded')) {
            orphanDrawer.remove();
        }
        return;
    }

    // mode === 'full': rebuild the whole tbody. Used for sort changes,
    // filter changes, expand/collapse toggles, and the initial paint.
    tbody.innerHTML = rows.map(r => {
        const isExpanded = expandedSymbol === r.symbol;
        const drawerRow = isExpanded
            ? `<tr class="scanner-drawer-row"><td colspan="7">${renderDrawer(r)}</td></tr>`
            : '';
        return `
            <tr class="scanner-row ${isExpanded ? 'expanded' : ''}" data-symbol="${r.symbol}">
                ${rowInnerHTML(r)}
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

// `mode` defaults to 'full' for safety, but the streaming worker
// passes 'patch' so an open drawer keeps its DOM intact across the
// 4-row refresh cadence.
function refresh(mode = 'full') {
    renderRows(mode);
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

    // Mode tabs (Stock Analysis / Crypto Analysis) trigger a full
    // scanner reset + restart. Without this the scanner shows
    // whichever pool it started with, so users on the Crypto tab
    // see stocks. We listen on the tab-button group rather than
    // subscribing to a state event to avoid coupling. Same approach
    // for the Today/Tomorrow timeframe tabs — different timeframe
    // means the engine produces different verdicts.
    function resetAndRestartScan() {
        const wantedMode = state.mode === 'crypto' ? 'crypto' : 'stock';
        // If a scan is in flight, signal the workers to bail out at
        // their next loop iteration. The Promise.all in startScan
        // resolves when all workers exit; since started stays true
        // until after Promise.all resolves, we'd race a new scan
        // against the old one. Wait for the abort to actually drain
        // before restarting.
        if (scanState.running) {
            scanState.aborting = true;
        }
        // Only relevant if details is open — otherwise the scan was
        // never started and a future open will pick up the new mode
        // automatically since startScan reads state.mode at call time.
        if (!details.open) return;
        // If mode actually changed (or rerun was requested), tear
        // down state and re-run.
        if (scanState.mode === wantedMode && scanState.rows.length) return;
        // Drain any in-flight scan first — give it 80ms to settle,
        // then reset + start fresh.
        const restart = () => {
            scanState.started = false;
            scanState.running = false;
            scanState.aborting = false;
            scanState.rows = [];
            scanState.progress = { done: 0, total: 0, errors: 0 };
            startScan();
        };
        if (scanState.running) setTimeout(restart, 120);
        else restart();
    }
    document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(resetAndRestartScan, 0));
    });
    document.querySelectorAll('[data-timeframe]').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(resetAndRestartScan, 0));
    });

    document.getElementById('scanner-filter')?.addEventListener('input', refresh);
    document.getElementById('scanner-signal-filter')?.addEventListener('change', refresh);

    // Accuracy-window inputs: re-aggregate the per-symbol stats from
    // the cached ledger rows (no engine rescan needed) and refresh
    // the table. Disable the number input when "all time" is chosen
    // since the value is meaningless there.
    function reaggregateAccuracy() {
        if (scanState.allLedgerRows) {
            scanState.accuracyBySymbol = buildAccuracyIndex(scanState.allLedgerRows, computeAccuracyCutoff());
        }
        refresh();
    }
    const winN = document.getElementById('scanner-window-n');
    const winU = document.getElementById('scanner-window-unit');
    function syncWinInputState() {
        if (!winN || !winU) return;
        const isAll = winU.value === 'all';
        winN.disabled = isAll;
        if (isAll) winN.value = '';
    }
    winN?.addEventListener('input', reaggregateAccuracy);
    winU?.addEventListener('change', () => { syncWinInputState(); reaggregateAccuracy(); });
    syncWinInputState();

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
