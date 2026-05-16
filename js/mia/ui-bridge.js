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
        input.value = symbol;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Click the first matching dropdown item shortly after.
        setTimeout(() => {
            const item = document.querySelector(`.search-result-item[data-symbol="${symbol}"]`)
                || document.querySelector('.search-result-item');
            if (item) item.click();
            resolve({ ok: true, picked: symbol });
        }, 600);
    });
}

export function controlSwitchMode(mode) {
    const btn = document.querySelector(`[data-tab="${mode}"]`);
    if (!btn) throw new Error(`unknown mode tab: ${mode}`);
    btn.click();
    return { ok: true, mode };
}

export function controlSwitchTimeframe(timeframe) {
    const btn = document.querySelector(`[data-timeframe="${timeframe}"]`);
    if (!btn) throw new Error(`unknown timeframe: ${timeframe}`);
    btn.click();
    return { ok: true, timeframe };
}

export function controlCycleTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) throw new Error('theme toggle missing');
    btn.click();
    return { ok: true, theme: state.theme };
}

export function controlTogglePL() {
    const btn = document.getElementById('pl-toggle');
    if (!btn) throw new Error('pl toggle missing');
    btn.click();
    return { ok: true, open: document.body.classList.contains('pl-open') };
}

export function controlRefreshHotPicks() {
    const btn = document.getElementById('refresh-hotpicks');
    if (!btn) throw new Error('hot-picks refresh missing');
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
    return { ok: true, pennyTier: norm || 'all' };
}

export function controlOpenSpikers() {
    const btn = document.getElementById('spikers-btn');
    if (!btn) throw new Error('spikers button missing');
    btn.click();
    return { ok: true };
}

export function controlOpenAbout() {
    const btn = document.getElementById('about-btn');
    if (!btn) throw new Error('about button missing');
    btn.click();
    return { ok: true };
}

export function controlToggleCurrency() {
    const btn = document.getElementById('currency-toggle');
    if (!btn) throw new Error('currency toggle missing');
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
    invEl.value = inv.toFixed(2);
    buyEl.value = buy.toFixed(2);
    curEl.value = cur.toFixed(2);
    calcBtn.click();

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
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (id === 'search-input') try { el.focus(); } catch (_) {}
    return { ok: true, section };
}

export function controlRunAnalysis() {
    const btn = document.getElementById('refresh-analysis');
    if (btn) { btn.click(); return { ok: true, via: 'refresh' }; }
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
    let cycles = 0;
    while (state.theme !== t && cycles < THEMES.length) {
        const btn = document.getElementById('theme-toggle');
        if (!btn) throw new Error('theme toggle missing');
        btn.click();
        cycles++;
    }
    return { ok: true, theme: state.theme };
}

export function controlFocusSearch({ query = '' } = {}) {
    const input = document.getElementById('search-input');
    if (!input) throw new Error('search input missing');
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (query) {
        input.value = String(query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { input.focus(); } catch (_) {}
    return { ok: true, query: input.value };
}

export function controlClearMiaChat() {
    clearMiaHistory();
    const thread = document.getElementById('mia-thread');
    if (thread) thread.innerHTML = '';
    return { ok: true };
}

export async function controlCopyToClipboard({ text }) {
    const s = String(text ?? '');
    if (!s) throw new Error('text required');
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
