// The single chokepoint between Mia and the live app.
//
// Why centralise: Mia is allowed to navigate and trigger re-analysis,
// but MUST NOT mutate any number that influences signals (calibration,
// confidence, prediction logs, source weights). Routing every Mia
// action through this module gives us one place to enforce that rule.
//
// Design contract:
//   - read*() functions: return live state and snapshots, never mutate.
//   - control*() functions: navigate / reflow the UI, allowed to call
//     existing app handlers (search picks, tab clicks, theme toggle,
//     hot-picks refresh). They CANNOT touch state.calibration, the
//     prediction log, the model JSON, or any signal number.
//
// If you find yourself adding a setNumber-style export here, stop.

import { state } from '../ui/state.js';
import { searchStocks, searchCrypto } from '../data.js';
import { getCalibrationStatus, getCalibrationCurve, getCalibrationByTier, getCalibrationByVolTier, getCalibrationRecency } from '../calibration.js';
import { getStats, getSourceAccuracy } from '../outcome-tracker.js';
import { setPennyFilter } from '../ui/hotpicks.js';
import { findSpikers, BUCKETS, bucketById } from '../spike-detector.js';
import { scanStockHotPicks, scanCryptoHotPicks } from '../hotpicks.js';
import { clearHistory as clearMiaHistory } from './memory.js';
import { announce, pulseElementById } from './agent-pulse.js';

/**
 * Programmatic equivalent of the user typing a symbol and clicking the
 * first match. Reuses the existing search flow so we don't bypass any
 * validation. Stocks only — crypto picks need a coingecko id which we
 * resolve here from the search result.
 */
export async function controlSelectSymbol({ symbol, mode = 'stock' }) {
    if (!symbol) throw new Error('symbol required');
    const sym = String(symbol).trim();
    if (mode === 'stock') {
        // Switch tab if needed.
        const stockTab = document.querySelector('[data-tab="stock"]');
        if (stockTab && !stockTab.classList.contains('active')) stockTab.click();
        const matches = await searchStocks(sym);
        if (!matches.length) throw new Error(`no stock match for ${sym}`);
        const target = matches.find(m => m.symbol.toUpperCase() === sym.toUpperCase()) || matches[0];
        return triggerSearchPick(target.symbol);
    }
    if (mode === 'crypto') {
        const cryptoTab = document.querySelector('[data-tab="crypto"]');
        if (cryptoTab && !cryptoTab.classList.contains('active')) cryptoTab.click();
        const matches = await searchCrypto(sym);
        if (!matches.length) throw new Error(`no crypto match for ${sym}`);
        const target = matches.find(m => m.symbol.toUpperCase() === sym.toUpperCase()) || matches[0];
        return triggerSearchPick(target.symbol);
    }
    throw new Error(`unknown mode: ${mode}`);
}

function triggerSearchPick(symbol) {
    return new Promise((resolve) => {
        const input = document.getElementById('search-input');
        if (!input) return resolve({ ok: false, reason: 'no-search-input' });
        announce({ text: `Loading ${symbol}…`, target: input });
        input.value = symbol;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Click the first matching dropdown item shortly after.
        setTimeout(() => {
            const item = document.querySelector(`.search-result-item[data-symbol="${symbol}"]`)
                || document.querySelector('.search-result-item');
            if (item) item.click();
            setTimeout(() => pulseElementById('signal-section'), 800);
            resolve({ ok: true, picked: symbol });
        }, 600);
    });
}

export function controlSwitchMode(mode) {
    const btn = document.querySelector(`[data-tab="${mode}"]`);
    if (!btn) throw new Error(`unknown mode tab: ${mode}`);
    announce({ text: `Switching to ${mode}…`, target: btn });
    btn.click();
    return { ok: true, mode };
}

export function controlSwitchTimeframe(timeframe) {
    const btn = document.querySelector(`[data-timeframe="${timeframe}"]`);
    if (!btn) throw new Error(`unknown timeframe: ${timeframe}`);
    announce({ text: `Switching to ${timeframe}…`, target: btn });
    btn.click();
    return { ok: true, timeframe };
}

export function controlCycleTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) throw new Error('theme toggle missing');
    announce({ text: 'Switching theme…', target: btn });
    btn.click();
    return { ok: true, theme: state.theme };
}

export function controlTogglePL() {
    const btn = document.getElementById('pl-toggle');
    if (!btn) throw new Error('pl toggle missing');
    announce({ text: 'Toggling P&L panel…', target: btn });
    btn.click();
    return { ok: true, open: document.body.classList.contains('pl-open') };
}

export function controlRefreshHotPicks() {
    const btn = document.getElementById('refresh-hotpicks');
    if (!btn) throw new Error('hot-picks refresh missing');
    announce({ text: 'Refreshing Hot Picks…', target: btn });
    btn.click();
    return { ok: true };
}

export function controlSetPennyFilter({ tier }) {
    const map = { all: null, none: null, '': null, p10: 'p10', p5: 'p5', p1: 'p1', '<10': 'p10', '<5': 'p5', '<1': 'p1', '10': 'p10', '5': 'p5', '1': 'p1' };
    const norm = map[String(tier ?? '').toLowerCase().trim()];
    if (norm === undefined) throw new Error(`unknown penny tier: ${tier} (use one of: all, p10, p5, p1)`);
    setPennyFilter(norm);
    document.querySelectorAll('[data-penny-filter]').forEach(btn => {
        const f = btn.dataset.pennyFilter || null;
        btn.classList.toggle('active', (f === null && norm === null) || f === norm);
    });
    const labelMap = { p10: 'under $10', p5: 'under $5', p1: 'under $1' };
    const label = labelMap[norm] || 'all prices';
    const target = document.querySelector(`[data-penny-filter="${norm || ''}"]`) || pulseElementById('hotpicks-grid');
    announce({ text: `Filtering Hot Picks (${label})…`, target });
    return { ok: true, pennyTier: norm || 'all' };
}

export function controlOpenSpikers() {
    const btn = document.getElementById('spikers-btn');
    if (!btn) throw new Error('spikers button missing');
    announce({ text: 'Opening Spikers…', target: btn });
    btn.click();
    return { ok: true };
}

export function controlOpenAbout() {
    const btn = document.getElementById('about-btn');
    if (!btn) throw new Error('about button missing');
    announce({ text: 'Opening About…', target: btn });
    btn.click();
    return { ok: true };
}

export function controlToggleCurrency() {
    const btn = document.getElementById('currency-toggle');
    if (!btn) throw new Error('currency toggle missing');
    announce({ text: 'Switching currency…', target: btn });
    btn.click();
    return { ok: true };
}

function ensurePLOpen() {
    if (!document.body.classList.contains('pl-open')) {
        const btn = document.getElementById('pl-toggle');
        if (btn) btn.click();
    }
}

export function controlPLCalculate({ investment, buyPrice, currentPrice }) {
    const inv = Number(investment);
    const buy = Number(buyPrice);
    if (!Number.isFinite(inv) || inv <= 0) throw new Error('investment must be a positive number');
    if (!Number.isFinite(buy) || buy <= 0) throw new Error('buyPrice must be a positive number');

    let cur = Number(currentPrice);
    let usedCurrent = false;
    if (!Number.isFinite(cur) || cur <= 0) {
        if (Number.isFinite(state.currentPrice) && state.currentPrice > 0) {
            cur = Number(state.currentPrice);
            usedCurrent = true;
        } else {
            throw new Error('currentPrice required (or load a symbol first to use the live price)');
        }
    }

    ensurePLOpen();
    const invEl = document.getElementById('pl-investment');
    const buyEl = document.getElementById('pl-buyPrice');
    const curEl = document.getElementById('pl-currentPrice');
    const calcBtn = document.getElementById('pl-calcBtn');
    if (!invEl || !buyEl || !curEl || !calcBtn) throw new Error('P&L calculator inputs not found');
    announce({ text: 'Running P&L calculator…', target: calcBtn });
    invEl.value = inv.toFixed(2);
    buyEl.value = buy.toFixed(2);
    curEl.value = cur.toFixed(2);
    calcBtn.click();
    setTimeout(() => pulseElementById('pl-result'), 200);

    const shares = inv / buy;
    const value = shares * cur;
    const pl = value - inv;
    const pct = ((cur - buy) / buy) * 100;
    return {
        ok: true,
        investment: inv,
        buyPrice: buy,
        currentPrice: cur,
        usedLivePrice: usedCurrent,
        symbol: usedCurrent ? state.currentSymbol : null,
        shares: +shares.toFixed(4),
        currentValue: +value.toFixed(2),
        plDollar: +pl.toFixed(2),
        plPct: +pct.toFixed(2),
    };
}

export function controlScrollTo({ section }) {
    const map = {
        chart: 'tradingview-widget',
        signal: 'signal-section',
        accuracy: 'accuracy-strip',
        hotpicks: 'hotpicks-grid',
        'hot-picks': 'hotpicks-grid',
        search: 'search-input',
    };
    const id = map[String(section || '').toLowerCase().trim()];
    if (!id) throw new Error(`unknown section: ${section} (use: chart, signal, accuracy, hotpicks, search)`);
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} not on page`);
    announce({ text: `Jumping to ${section}…`, target: el });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (id === 'search-input') try { el.focus(); } catch (_) {}
    return { ok: true, section };
}

export function controlRunAnalysis() {
    const btn = document.getElementById('refresh-analysis');
    if (btn) { announce({ text: 'Rerunning analysis…', target: btn }); btn.click(); return { ok: true, via: 'refresh' }; }
    // Fallback: re-trigger search pick if a symbol is loaded.
    if (state.currentSymbol) {
        return triggerSearchPick(state.currentSymbol).then(r => ({ ...r, via: 'search-rerun' }));
    }
    throw new Error('no symbol selected to analyze');
}

/**
 * Read-only snapshot of every load-bearing piece of UI state Mia might
 * want to reason about. Never mutates anything.
 */
export function readUiSnapshot() {
    return {
        mode: state.mode,
        timeframe: state.timeframe,
        theme: state.theme,
        currentSymbol: state.currentSymbol,
        currentCoinId: state.currentCoinId,
        currentPrice: state.currentPrice,
        plOpen: document.body.classList.contains('pl-open'),
        latestSignalSummary: summariseLatestSignal(),
    };
}

function summariseLatestSignal() {
    const sig = window.__miaLatestSignal;
    if (!sig) return null;
    return {
        signal: sig.signal,
        confidence: sig.confidence,
        rawConfidence: sig.rawConfidence,
        trendRegime: sig.trendRegime,
        priceTargets: sig.priceTargets,
        topReasons: sig.reasons?.slice(0, 5),
    };
}

export function readCalibrationSnapshot() {
    return {
        status: getCalibrationStatus(),
        global: getCalibrationCurve(),
        byLiquidityTier: getCalibrationByTier(),
        byVolTier: getCalibrationByVolTier(),
        recencyWeighted: getCalibrationRecency(),
    };
}

export function readAccuracyStats() {
    return getStats();
}

export async function findSpikersDirect({ bucket = '3pct', limit = 10 } = {}) {
    const b = bucketById(bucket);
    if (!b) throw new Error(`unknown bucket: ${bucket}. Use one of: ${BUCKETS.map(x => x.id).join(', ')}`);
    const scan = state.mode === 'crypto' ? scanCryptoHotPicks : scanStockHotPicks;
    const picks = await scan(state.timeframe, 50, () => {});
    const candidates = picks.map(p => ({ symbol: p.symbol, id: p.id, name: p.name, price: p.price, candles: null }));
    const results = await findSpikers(candidates, b, () => {}, { mode: state.mode });
    const lim = Math.max(1, Math.min(20, Number(limit) || 10));
    return {
        bucket: b.id,
        bucketLabel: b.label,
        mode: state.mode,
        count: results.length,
        candidates: results.slice(0, lim).map(r => ({
            symbol: r.symbol, name: r.name, currentPrice: r.price,
            targetPrice: r.targetPrice, projectedPct: r.projectedPct,
            confidence: r.confidence, calibrated: r.calibrated, reason: r.reason,
        })),
    };
}

export function readPredictionLog({ limit = 10 } = {}) {
    let log = [];
    try {
        const raw = localStorage.getItem('ma-prediction-log');
        log = raw ? JSON.parse(raw) : [];
    } catch (_) { log = []; }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const recent = log.slice(-lim).map(p => ({
        symbol: p.symbol, mode: p.mode, signal: p.signal, confidence: p.confidence,
        priceAtPrediction: p.price, timeframe: p.timeframe,
        timestamp: p.timestamp, resolved: !!p.resolved,
        priceAtResolve: p.priceAtResolve ?? null, correct: p.correct ?? null,
    }));
    return { totalLogged: log.length, returned: recent.length, recent };
}

// Lazy-load + cache the current year's ledger so Mia can look up
// recent predictions and outcomes without hammering the network.
let _ledgerCache = null;
let _ledgerCacheTs = 0;
const LEDGER_CACHE_MS = 5 * 60 * 1000;

async function loadLedger() {
    if (_ledgerCache && Date.now() - _ledgerCacheTs < LEDGER_CACHE_MS) {
        return _ledgerCache;
    }
    const year = new Date().getUTCFullYear();
    try {
        const res = await fetch(`./model/ledger/${year}.jsonl`);
        if (!res.ok) {
            _ledgerCache = [];
            _ledgerCacheTs = Date.now();
            return _ledgerCache;
        }
        const text = await res.text();
        const rows = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { rows.push(JSON.parse(t)); } catch (_) {}
        }
        _ledgerCache = rows;
        _ledgerCacheTs = Date.now();
        return _ledgerCache;
    } catch (_) {
        _ledgerCache = [];
        _ledgerCacheTs = Date.now();
        return _ledgerCache;
    }
}

export async function readLedgerHistory({ symbol, limit = 10 } = {}) {
    const rows = await loadLedger();
    if (!rows.length) {
        return { available: false, note: 'Ledger not seeded yet — needs at least one cron run.' };
    }
    let scoped = rows;
    if (symbol) {
        const sym = String(symbol).toUpperCase();
        scoped = rows.filter(r => r.symbol === sym);
    }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const recent = scoped.slice(-lim);
    // Compute simple resolved-hit-rate so Mia can summarize at a glance.
    let resolvedN = 0, hits = 0;
    for (const r of recent) {
        const h1 = r.horizons?.['1'];
        if (h1) { resolvedN++; if (h1.directionMatch) hits++; }
    }
    return {
        available: true,
        symbol: symbol || 'all',
        rowsReturned: recent.length,
        totalForSymbol: scoped.length,
        resolved1d: resolvedN,
        hits1d: hits,
        hitRate1dPct: resolvedN ? Math.round((hits / resolvedN) * 100) : null,
        recent,
    };
}

/**
 * Find ledger rows whose feature vector is closest to a target setup,
 * then summarize how those past setups played out at each horizon.
 *
 * Why this is useful: instead of saying "the model is 52% accurate
 * overall", Mia can answer "the last 14 times we saw this exact pattern
 * (RSI ~28, MACD positive, BB lower band), 9 closed up at +1d, 7 at +5d".
 * Concrete + grounded in real outcomes. Resists hallucination because
 * the answer comes straight from the ledger structured data, not the
 * LLM's prior.
 *
 * Distance metric: normalized euclidean on the 3 stored indicator
 * features (RSI scaled 0-100, MACD histogram standardised, BB %B
 * scaled 0-1). Three features sounds tiny but it's what record_*.py
 * actually persists, and it's already enough to discriminate
 * "oversold-bounce" setups from "overbought-mean-revert" setups.
 *
 * Returns null if the ledger doesn't have enough resolved horizons
 * (need at least 5 neighbors with a resolved 1d outcome to be honest).
 */
export async function findSimilarSetups({ rsi, macd, bb, signal, region, k = 20 } = {}) {
    const rows = await loadLedger();
    if (!rows.length) return { available: false, note: 'Ledger not seeded yet — needs at least one cron run.' };

    // Pull out the live/target features. Caller can pass them explicitly,
    // but most of the time we just read the current on-screen signal.
    const sig = window.__miaLatestSignal;
    const indicators = sig?.indicators || sig?.breakdown?.daily?.indicators || null;
    const target = {
        rsi: Number.isFinite(rsi) ? rsi : indicators?.rsi,
        macdHist: Number.isFinite(macd) ? macd : indicators?.macd?.histogram,
        bbPct: Number.isFinite(bb) ? bb : indicators?.bb?.percentB,
    };
    if (!Number.isFinite(target.rsi)) return { available: false, note: 'No current RSI to match against.' };

    // Normalize feature scales so each contributes ~equally to the distance.
    const normRsi = v => (v - 50) / 50;        // -1..1
    const normMacd = v => Math.max(-2, Math.min(2, (v ?? 0))) / 2;  // squashed
    const normBb = v => ((v ?? 0.5) - 0.5) * 2; // -1..1

    const tNorm = [normRsi(target.rsi), normMacd(target.macdHist), normBb(target.bbPct)];
    const wantSignal = signal ? String(signal).toUpperCase() : null;

    const scored = [];
    for (const r of rows) {
        if (!r.indicators) continue;
        if (region && r.region !== region) continue;
        if (wantSignal && r.signal !== wantSignal) continue;
        const rs = r.indicators.rsi;
        const mh = r.indicators.macd?.histogram ?? r.indicators.macdHist;
        const bp = r.indicators.bb?.percentB ?? r.indicators.bbPct;
        if (!Number.isFinite(rs)) continue;
        const v = [normRsi(rs), normMacd(mh), normBb(bp)];
        let d2 = 0;
        for (let i = 0; i < 3; i++) { const x = v[i] - tNorm[i]; d2 += x * x; }
        scored.push({ row: r, distance: Math.sqrt(d2) });
    }
    if (!scored.length) return { available: false, note: 'No comparable rows in the ledger yet.' };

    scored.sort((a, b) => a.distance - b.distance);
    const lim = Math.max(3, Math.min(50, Number(k) || 20));
    const neighbors = scored.slice(0, lim);

    // Aggregate hit-rate across each horizon for the picked neighbors.
    const HORIZONS = ['1', '3', '5', '10', '20'];
    const horizonStats = {};
    for (const h of HORIZONS) {
        let resolved = 0, hits = 0;
        for (const n of neighbors) {
            const slot = n.row.horizons?.[h];
            if (slot && slot.directionMatch !== null && slot.directionMatch !== undefined) {
                resolved++;
                if (slot.directionMatch) hits++;
            }
        }
        if (resolved > 0) horizonStats[`${h}d`] = { resolved, hits, hitRatePct: Math.round((hits / resolved) * 100) };
    }

    // Quick narrative the LLM can latch onto without re-deriving.
    const sample = neighbors.slice(0, 5).map(n => ({
        symbol: n.row.symbol,
        date: n.row.date,
        signal: n.row.signal,
        confidence: n.row.confidence,
        rsi: n.row.indicators.rsi,
        bb1d: n.row.horizons?.['1']?.directionMatch ?? null,
        distance: +n.distance.toFixed(3),
    }));

    return {
        available: true,
        target,
        neighborsScanned: scored.length,
        neighborsReturned: neighbors.length,
        horizonHitRates: horizonStats,
        closestSamples: sample,
        note: 'Each horizon shows the % of similar past setups that resolved in the predicted direction. Honest small-N: under 30 resolved per horizon, treat the rate as suggestive not authoritative.',
    };
}

export async function readLiveCalibration() {
    try {
        const res = await fetch('./model/live_calibration.json');
        if (!res.ok) return { available: false, note: 'Live calibration not generated yet.' };
        const data = await res.json();
        return {
            available: true,
            generatedAt: data.generatedAt,
            totalRowsConsidered: data.totalRowsConsidered,
            totalResolvedHorizons: data.totalResolvedHorizons,
            byHorizon: data.byHorizon,
            byRegion: data.byRegion,
        };
    } catch (e) {
        return { available: false, note: String(e.message || e) };
    }
}

export function readSourceAccuracy() {
    const data = getSourceAccuracy();
    if (!data) return { available: false, note: 'Not enough resolved samples yet (need 15+ in the last 30).' };
    return {
        available: true,
        bySource: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { n: v.n, hitRatePct: Math.round(v.hitRate * 100) }])),
    };
}

const THEMES = ['dark', 'light', 'aurora'];

export function controlSetTheme({ theme }) {
    const t = String(theme || '').toLowerCase().trim();
    if (!THEMES.includes(t)) throw new Error(`unknown theme: ${theme}. Use one of: ${THEMES.join(', ')}`);
    const btn = document.getElementById('theme-toggle');
    if (!btn) throw new Error('theme toggle missing');
    announce({ text: `Switching to ${t} theme…`, target: btn });
    let cycles = 0;
    while (state.theme !== t && cycles < THEMES.length) {
        btn.click();
        cycles++;
    }
    return { ok: true, theme: state.theme };
}

export function controlFocusSearch({ query = '' } = {}) {
    const input = document.getElementById('search-input');
    if (!input) throw new Error('search input missing');
    announce({ text: query ? `Searching ${query}…` : 'Jumping to search…', target: input });
    if (query) {
        input.value = String(query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { input.focus(); } catch (_) {}
    return { ok: true, query: input.value };
}

export function controlClearMiaChat() {
    announce({ text: 'Clearing chat…' });
    clearMiaHistory();
    const thread = document.getElementById('mia-thread');
    if (thread) thread.innerHTML = '';
    return { ok: true };
}

export async function controlCopyToClipboard({ text }) {
    const s = String(text ?? '');
    if (!s) throw new Error('text required');
    announce({ text: 'Copied to clipboard ✓' });
    try {
        await navigator.clipboard.writeText(s);
        return { ok: true, length: s.length };
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const fallbackOk = document.execCommand('copy');
        ta.remove();
        if (!fallbackOk) throw new Error('clipboard write blocked');
        return { ok: true, length: s.length, fallback: true };
    }
}
