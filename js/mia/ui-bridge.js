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
import { getStats } from '../outcome-tracker.js';
import { setPennyFilter } from '../ui/hotpicks.js';

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
