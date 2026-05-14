import { state } from './state.js';
import { initTheme, cycleTheme } from './theme.js';
import { initSearch, updatePlaceholder } from './search.js';
import { loadChart, updateChartHeader, showChartPlaceholder } from './chart.js';
import { renderSignal } from './signal.js';
import { loadHotPicks } from './hotpicks.js';
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
import { initMarketSelector } from './market-selector.js';

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
    showChartPlaceholder();
    startDyk();
    initMarketSelector({ onChange: () => {
        startTipsForLoading();
        loadHotPicks(onSelectFromCard).finally(stopTipsForLoading);
    }});

    startTipsForLoading();
    loadHotPicks(onSelectFromCard).finally(stopTipsForLoading);

    loadModel().then(loaded => loaded && console.log('[Market Analyzer] AI model loaded'));
    loadCalibration().then(() => maybeRenderAccuracyStrip());
    maybeRenderAccuracyStrip();

    document.getElementById('theme-toggle').addEventListener('click', () => {
        cycleTheme(() => { if (state.currentSymbol || state.currentCoinId) loadChart(); });
    });

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
        <div class="loader"></div>
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

        updateChartHeader(multiData.daily);
        if (multiData.daily.currentPrice) resolvePending(state.currentSymbol, multiData.daily.currentPrice);

        const result = await computeFullConfidence(multiData, state.mode, symbolId, state.timeframe);
        renderSignal(result, result.news, { overall: result.newsOverall, summary: result.newsSummary });
        setLatestSignal(result);

        logPrediction({
            mode: state.mode, symbol: state.currentSymbol,
            signal: result.signal, confidence: result.confidence,
            price: multiData.daily.currentPrice, timeframe: state.timeframe,
        });
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
