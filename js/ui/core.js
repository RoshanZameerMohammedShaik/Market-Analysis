import { state } from './state.js';
import { initTheme, cycleTheme } from './theme.js';
import { initSearch, updatePlaceholder } from './search.js';
import { loadChart, updateChartHeader, showChartPlaceholder } from './chart.js';
import { renderSignal } from './signal.js';
import { loadHotPicks, initPennyFilterButtons } from './hotpicks.js';
import { initPLCalculator } from './pl.js';
import { initPLToggle } from './pl-toggle.js';
import { renderAccuracyStrip } from './accuracy.js';
import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe, fetchWithProxy } from '../data.js';
import { computeFullConfidence } from '../confidence.js';
import { loadModel } from '../ai-model.js';
import { loadCalibration, getCalibrationStatus } from '../calibration.js';
import { logPrediction, resolvePending } from '../outcome-tracker.js';
import { isDev } from '../dev-mode.js';
import { initKeyboard } from './keyboard.js';
import { renderGlossary } from './glossary.js';
import { startTipRotation } from './tips.js';
import { initMia, setLatestSignal } from '../mia/mia.js';
import { startDyk } from './dyk.js';
import { initRipple } from './ripple.js';
import { candleLoaderHTML } from './skeleton.js';

let stopTips = null;

export function init() {
    document.documentElement.setAttribute('data-dev', isDev() ? '1' : '0');
    initRipple();
    initTheme();
    initTabs();
    initSearch(onSelectFromSearch);
    updatePlaceholder();
    initPLCalculator();
    initPLToggle();
    initKeyboard({ onRefresh: () => document.getElementById('refresh-hotpicks')?.click() });
    renderGlossary();
    initMia();
    initPennyFilterButtons();
    showChartPlaceholder();
    startDyk();

    startTipsForLoading();
    loadHotPicks(onSelectFromCard).finally(stopTipsForLoading);

    loadModel().then(loaded => loaded && console.log('[Market Analyzer] AI model loaded'));
    loadCalibration().then(() => maybeRenderAccuracyStrip());
    maybeRenderAccuracyStrip();

    document.getElementById('theme-toggle').addEventListener('click', () => {
        cycleTheme(() => { if (state.currentSymbol || state.currentCoinId) loadChart(); });
    });

    initSettingsMenu();

    document.getElementById('refresh-hotpicks').addEventListener('click', e => {
        const btn = e.currentTarget;
        btn.classList.add('spinning');
        startTipsForLoading();
        loadHotPicks(onSelectFromCard).finally(() => {
            btn.classList.remove('spinning');
            stopTipsForLoading();
        });
    });
}

function startTipsForLoading() {
    const tipEl = document.getElementById('loading-tip');
    if (!tipEl) return;
    if (stopTips) stopTips();
    stopTips = startTipRotation(tipEl, 4500);
}
function stopTipsForLoading() {
    if (stopTips) { stopTips(); stopTips = null; }
}

function maybeRenderAccuracyStrip() {
    const container = document.getElementById('accuracy-strip');
    if (!container) return;
    if (!isDev()) { container.innerHTML = ''; return; }
    renderAccuracyStrip();
}

function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.mode = btn.dataset.tab;
            document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePlaceholder();
            clearAnalysis();
            startTipsForLoading();
            loadHotPicks(onSelectFromCard).finally(stopTipsForLoading);
        });
    });
    document.querySelectorAll('[data-timeframe]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.timeframe = btn.dataset.timeframe;
            document.querySelectorAll('[data-timeframe]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (state.currentSymbol || state.currentCoinId) runAnalysis();
            startTipsForLoading();
            loadHotPicks(onSelectFromCard).finally(stopTipsForLoading);
        });
    });
}

function onSelectFromSearch({ mode, symbol, coinId }) {
    if (mode === 'stock') { state.currentSymbol = symbol; state.currentCoinId = null; }
    else { state.currentSymbol = symbol; state.currentCoinId = coinId; }
    document.getElementById('search-input').value = symbol;
    loadChart();
    runAnalysis();
}

function onSelectFromCard({ mode, symbol, coinId }) {
    if (mode === 'stock') { state.currentSymbol = symbol; state.currentCoinId = null; }
    else { state.currentSymbol = symbol; state.currentCoinId = coinId; }
    document.getElementById('search-input').value = symbol;
    loadChart();
    runAnalysis();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function runAnalysis() {
    const signalSection = document.getElementById('signal-section');
    signalSection.innerHTML = `<div class="loading fade-in">
        ${candleLoaderHTML(7)}
        <span class="loading-text">Running full analysis: AI + Technicals + Sentiment + Market...</span>
    </div>`;

    try {
        let multiData = null;
        const symbolId = state.mode === 'stock' ? state.currentSymbol : state.currentCoinId;
        const symbolName = state.currentSymbol;

        if (state.mode === 'stock') {
            multiData = await fetchStockMultiTimeframe(state.currentSymbol);
        } else {
            const coinId = state.currentCoinId;
            try {
                multiData = await fetchCryptoMultiTimeframe(coinId);
            } catch (_) {
                const cached = state.cryptoCache[coinId];
                if (cached?.sparkline?.length >= 20) {
                    const candles = sparklineToCandles(cached.sparkline);
                    multiData = wrapCandles(symbolName, cached.name, cached.price, null, candles);
                }
            }
            if (!multiData) {
                try {
                    const marketRes = await fetchWithProxy(`https://api.coingecko.com/api/v3/coins/${state.currentCoinId}/market_chart?vs_currency=usd&days=30`);
                    const marketData = await marketRes.json();
                    if (marketData.prices?.length > 20) {
                        const candles = marketData.prices.map(([time, price]) => ({
                            time: time / 1000, open: price, high: price * 1.005, low: price * 0.995, close: price, volume: 0,
                        }));
                        const cur = candles[candles.length - 1].close;
                        multiData = wrapCandles(symbolName, symbolName, cur, candles[candles.length - 2]?.close, candles);
                    }
                } catch (_) { /* */ }
            }
            if (!multiData) throw new Error(`Could not fetch data for ${symbolName}.`);
        }

        // Time-travel: truncate candles to the chosen past date and
        // re-derive currentPrice from the close on that date. Engine
        // sees only the bars that would have been available then.
        if (state.timeTravelDate) {
            multiData = truncateMultiData(multiData, state.timeTravelDate);
            if (!multiData) throw new Error(`No bars available before ${state.timeTravelDate}.`);
        }

        updateChartHeader(multiData.daily);
        if (multiData.daily.currentPrice) resolvePending(state.currentSymbol, multiData.daily.currentPrice);

        const result = await computeFullConfidence(multiData, state.mode, symbolId, state.timeframe);
        // Attach the symbol's native currency (from Yahoo's meta.currency)
        // so renderSignal can format prices in their actual quote
        // currency. Without this, INR-native tickers like CORDSCABLE.NS
        // would have their already-INR prices FX-converted as if they
        // were USD, producing nonsense (₹230 → ₹21,876).
        result.currency = multiData?.daily?.currency || 'USD';
        renderSignal(result, result.news, { overall: result.newsOverall, summary: result.newsSummary });
        setLatestSignal(result);

        // Don't log time-travel predictions — they're hypothetical
        // "what would the engine have said back then?" calls, not real
        // forward predictions. Logging them would poison live accuracy
        // metrics.
        if (!state.timeTravelDate) {
            logPrediction({
                mode: state.mode, symbol: state.currentSymbol,
                signal: result.signal, confidence: result.confidence,
                price: multiData.daily.currentPrice, timeframe: state.timeframe,
                breakdown: result.breakdown,
            });
        }
        maybeRenderAccuracyStrip();

        document.getElementById('refresh-analysis')?.addEventListener('click', () => runAnalysis());
    } catch (e) {
        signalSection.innerHTML = `<div class="error-message fade-in">Analysis failed: ${e.message}. Try another symbol.</div>`;
    }
}

function wrapCandles(symbol, name, price, prev, candles) {
    return {
        daily: { symbol, name, currentPrice: price, previousClose: prev, candles },
        weekly: { symbol, name, currentPrice: price, previousClose: null, candles },
        fourHour: { symbol, name, currentPrice: price, previousClose: null, candles },
    };
}

// Time-travel helper. Slices each timeframe's candles at the chosen
// past date and rewrites currentPrice/previousClose so downstream
// indicators behave as if it were that day.
//
// Date semantics: keep all bars whose timestamp is <= midnight UTC
// of the day AFTER the chosen date. That way "show me 2026-04-15"
// includes that full trading day's close.
function truncateMultiData(multiData, dateIso) {
    const cutoffMs = new Date(dateIso + 'T23:59:59Z').getTime() / 1000;
    const slice = (tf) => {
        if (!tf?.candles?.length) return tf;
        const kept = tf.candles.filter(c => {
            const t = c.time != null ? c.time : null;
            // Some pipelines stamp time as ms; auto-detect.
            const tSec = t == null ? null : (t > 1e12 ? t / 1000 : t);
            return tSec == null || tSec <= cutoffMs;
        });
        if (!kept.length) return null;
        const last = kept[kept.length - 1];
        const prev = kept[kept.length - 2];
        return {
            ...tf,
            candles: kept,
            currentPrice: last.close,
            previousClose: prev?.close ?? null,
        };
    };
    const daily = slice(multiData.daily);
    if (!daily) return null;
    return {
        daily,
        weekly: slice(multiData.weekly) || daily,
        fourHour: slice(multiData.fourHour) || daily,
    };
}
function sparklineToCandles(prices) {
    if (!prices || prices.length < 20) return [];
    const periodSize = 4;
    const candles = [];
    for (let i = 0; i < prices.length; i += periodSize) {
        const slice = prices.slice(i, i + periodSize);
        if (slice.length === 0) continue;
        candles.push({
            time: Date.now() / 1000 - (prices.length - i) * 3600,
            open: slice[0], high: Math.max(...slice), low: Math.min(...slice),
            close: slice[slice.length - 1], volume: 0,
        });
    }
    return candles;
}
function clearAnalysis() {
    document.getElementById('signal-section').innerHTML = '';
    document.getElementById('chart-header').classList.add('hidden');
    showChartPlaceholder();
    state.currentSymbol = null;
    state.currentCoinId = null;
    state.currentPrice = null;
    document.getElementById('search-input').value = '';
}

// Settings dropdown — single gear button replaces the row of header
// icons. Click toggles the menu. Click any menu item closes the menu;
// each item's actual behavior is wired by its own module via getElementById
// (about-btn → about.js, currency-toggle → currency-toggle.js, theme-
// toggle → handler above), so we just need to manage open/close here.
function initSettingsMenu() {
    const btn = document.getElementById('settings-toggle');
    const menu = document.getElementById('header-settings-menu');
    if (!btn || !menu) return;

    const setOpen = (open) => {
        menu.classList.toggle('open', open);
        menu.setAttribute('aria-hidden', open ? 'false' : 'true');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(!menu.classList.contains('open'));
    });
    // Close on item click — let the item's own handler run first via
    // bubbling, then close the menu after a microtask so the action's
    // re-render doesn't fight the close animation.
    menu.addEventListener('click', () => {
        setTimeout(() => setOpen(false), 0);
    });
    // Click anywhere outside the menu/button → close.
    document.addEventListener('click', (e) => {
        if (!menu.classList.contains('open')) return;
        if (menu.contains(e.target) || btn.contains(e.target)) return;
        setOpen(false);
    });
    // Escape key closes the menu.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.classList.contains('open')) setOpen(false);
    });
}
