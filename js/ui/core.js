import { state } from './state.js';
import { initTheme, cycleTheme } from './theme.js';
import { initSearch, updatePlaceholder } from './search.js';
import { loadChart, updateChartHeader, showChartPlaceholder } from './chart.js';
import { renderSignal } from './signal.js';
import { loadHotPicks, initPennyFilterButtons } from './hotpicks.js';
import { clearHotPicksCache } from '../hotpicks.js';
import { initPLCalculator } from './pl.js';
import { initPLToggle } from './pl-toggle.js';
import { renderAccuracyStrip } from './accuracy.js';
import { fetchStockMultiTimeframe, fetchCryptoMultiTimeframe, fetchWithProxy } from '../data.js';
import { computeFullConfidence } from '../confidence.js';
import { peek as peekCache, refresh as refreshCache, prewarmWatchlist } from '../analysis-cache.js';
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
import { initTilt3d } from './tilt-3d.js';
import { candleLoaderHTML } from './skeleton.js';
import { flashShimmer } from './flash-shimmer.js';

let stopTips = null;

// Eased scroll on an arbitrary container. The browser's native
// scrollIntoView({ behavior: 'smooth' }) uses a hardcoded short
// duration; we want the P&L-shortcut pull to be visibly slow so the
// motion reads as a deliberate animation, not a teleport. easeOutCubic
// matches the panel-slide easing already used elsewhere in the app.
function slowScrollTo(scroller, target, durationMs = 1200) {
    const containerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offsetWithin = targetRect.top - containerRect.top + scroller.scrollTop;
    const destination = offsetWithin - (scroller.clientHeight - target.clientHeight) / 2;
    const start = scroller.scrollTop;
    const distance = destination - start;
    if (Math.abs(distance) < 2) return;
    const startTs = performance.now();
    function tick(now) {
        const t = Math.min(1, (now - startTs) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        scroller.scrollTop = start + distance * eased;
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

export function init() {
    document.documentElement.setAttribute('data-dev', isDev() ? '1' : '0');
    initRipple();
    initTilt3d();   // cursor-tilt 3D depth; no-ops under reduced-motion / touch / narrow
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
        // Clear the 5-min cache so the click actually refetches —
        // otherwise hitting Refresh within 5 min returns the same
        // cards. Roshan caught this when adding pennies wasn't
        // surfacing until the cache TTL expired.
        clearHotPicksCache();
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
    const symbolId = state.mode === 'stock' ? state.currentSymbol : state.currentCoinId;
    const symbolName = state.currentSymbol;
    const tf = state.timeframe;
    const mode = state.mode;

    // Stale-while-revalidate: if we have a cached entry for this
    // symbol+timeframe, render it INSTANTLY (chart + signal) so the
    // user gets feedback at click time. Then check freshness — if
    // older than 2 min, kick off a background re-analysis and
    // re-render when it lands. Time-travel mode bypasses cache (it's
    // a deterministic past-date replay, not a "current" view).
    const cached = !state.timeTravelDate ? peekCache(symbolName, tf, mode) : null;
    if (cached) {
        try {
            const cd = cached.data;
            updateChartHeader(cd.daily);
            const result = { ...cached.signal, currency: cd?.daily?.currency || 'USD' };
            renderSignal(result, result.news, { overall: result.newsOverall, summary: result.newsSummary });
            setLatestSignal(result);
        } catch (_) { /* fall through to fresh fetch */ }
        if (cached.fresh) {
            // Cache is <2min old — that's our freshness floor. Done.
            document.getElementById('refresh-analysis')?.addEventListener('click', () => runAnalysis(true));
            return;
        }
        // Stale: fall through to a fresh analysis below. The cards
        // already on screen stay visible; we'll refresh them when
        // the new pipeline finishes.
    } else {
        signalSection.innerHTML = `<div class="loading fade-in">
            ${candleLoaderHTML(7)}
            <span class="loading-text">Running full analysis: AI + Technicals + Sentiment + Market...</span>
        </div>`;
    }

    try {
        let multiData = null;

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

        // Store fresh result in the analysis cache for stale-while-
        // revalidate. Skip on time-travel runs — those are deterministic
        // past-date replays and shouldn't pollute the live cache.
        if (!state.timeTravelDate) {
            try {
                const { _storeFresh } = await import('../analysis-cache.js');
                _storeFresh?.(symbolName, state.timeframe, state.mode, multiData, result);
            } catch (_) {}
        }

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
    // Item click: pulse the activated row briefly so the user gets
    // visual confirmation before the menu closes. Then close on the
    // next tick so the action's re-render doesn't fight the close
    // animation.
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.header-menu-item');
        if (item) {
            item.classList.remove('header-menu-fired');
            // Force a reflow so re-adding the class restarts the
            // animation even on rapid double-clicks.
            void item.offsetWidth;
            item.classList.add('header-menu-fired');
            setTimeout(() => item.classList.remove('header-menu-fired'), 500);
        }
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

    // P&L Calculator shortcut — opens the Portfolio panel, expands
    // the collapsed P&L calculator <details> section, then scrolls
    // to it on a slow easeOutCubic curve so the user can SEE the
    // panel travel down to the calculator (Roshan asked for the pull
    // to be slow enough to read as an animation).
    document.getElementById('pl-shortcut')?.addEventListener('click', async () => {
        const m = await import('./portfolio-panel.js');
        // shimmerTitle: false so the panel-title doesn't shimmer at
        // the same time as the P&L Calculator label below — the user
        // is being navigated to the calculator, not the panel header.
        m.openPortfolioPanel({ shimmerTitle: false });
        requestAnimationFrame(() => {
            const section = document.getElementById('portfolio-pl-section');
            if (section && !section.open) section.open = true;
            const inv = document.getElementById('pp-calc-investment');
            const scroller = document.querySelector('.portfolio-panel-scroll');
            const shimmerTarget = document.querySelector('.portfolio-pl-summary-text');
            // Park the label in the dim pre-shimmer state IMMEDIATELY
            // so it doesn't sit in default-bright-white during the
            // ~1.5s scroll and then "blink" to dim when the shimmer
            // class is added. .pre-shimmer just sets the dim background
            // without animating; .flash-shimmer (added after the scroll)
            // runs the sweep and ends bright.
            if (shimmerTarget) shimmerTarget.classList.add('pre-shimmer');
            const armShimmer = () => {
                if (!shimmerTarget) return;
                shimmerTarget.classList.remove('pre-shimmer');
                flashShimmer(shimmerTarget);
            };
            if (inv && scroller) {
                slowScrollTo(scroller, inv, 1400);
                setTimeout(() => {
                    inv.focus({ preventScroll: true });
                    armShimmer();
                }, 1500);
            } else if (inv) {
                inv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => {
                    inv.focus();
                    armShimmer();
                }, 280);
            } else {
                armShimmer();
            }
        });
    });
}
