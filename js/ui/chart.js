import { state } from './state.js';
import { fmtPrice, fmtPriceTag } from './format.js';
import { attachWatchButton } from './watchlist.js';
import { attachTradeButtons } from './trade-buttons.js';
import { attachTimeTravel } from './time-travel.js';
import { fetchStockData, fetchCryptoData } from '../data.js';
import { fullLabelForSymbol, fullLabelForCode, displayTicker } from './exchanges.js';
import { readSymbolSignalMarkers } from '../ledger-reader.js';
import { mountParticles } from './particles.js';

// Teardown handle for the hero particle field (mounted in showChartPlaceholder,
// torn down when a real chart replaces the placeholder).
let _heroParticlesStop = null;
function stopHeroParticles() { if (_heroParticlesStop) { try { _heroParticlesStop(); } catch (_) {} _heroParticlesStop = null; } }

// "Engine Signals" mode: when ON, EVERY symbol (incl. US) renders on our
// own lightweight-charts chart so we can draw the engine's past BUY/SELL
// calls as markers on the price — colored by whether each one hit. When
// OFF, US tickers keep the richer TradingView embed (which gives us no
// marker API). Persisted so the user's choice sticks across reloads.
const ENGINE_SIGNALS_KEY = 'ma-engine-signals-on';
function engineSignalsOn() {
    try { return localStorage.getItem(ENGINE_SIGNALS_KEY) === '1'; } catch (_) { return false; }
}
function setEngineSignalsOn(on) {
    try { localStorage.setItem(ENGINE_SIGNALS_KEY, on ? '1' : '0'); } catch (_) {}
}

// Live lightweight-charts instance + its ResizeObserver, held so we can
// dispose them before each re-render. Without this, every loadChart()
// (symbol change, theme cycle, signals toggle) orphaned a chart instance
// + an observing ResizeObserver → steady memory/observer leak.
let _localChart = null;
let _localChartRO = null;
function teardownLocalChart() {
    if (_localChartRO) { try { _localChartRO.disconnect(); } catch (_) {} _localChartRO = null; }
    if (_localChart) { try { _localChart.remove(); } catch (_) {} _localChart = null; }
}

const TV_CRYPTO_MAP = {
    BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT', SOL: 'BINANCE:SOLUSDT',
    XRP: 'BINANCE:XRPUSDT', DOGE: 'BINANCE:DOGEUSDT', ADA: 'BINANCE:ADAUSDT',
    DOT: 'BINANCE:DOTUSDT', AVAX: 'BINANCE:AVAXUSDT', LINK: 'BINANCE:LINKUSDT',
    MATIC: 'BINANCE:MATICUSDT', LTC: 'BINANCE:LTCUSDT', UNI: 'BINANCE:UNIUSDT',
    ATOM: 'BINANCE:ATOMUSDT', NEAR: 'BINANCE:NEARUSDT', SUI: 'BINANCE:SUIUSDT',
    BNB: 'BINANCE:BNBUSDT', SHIB: 'BINANCE:SHIBUSDT', PEPE: 'BINANCE:PEPEUSDT',
    ARB: 'BINANCE:ARBUSDT', OP: 'BINANCE:OPUSDT', APT: 'BINANCE:APTUSDT',
    INJ: 'BINANCE:INJUSDT', HBAR: 'BINANCE:HBARUSDT', BCH: 'BINANCE:BCHUSDT',
    XMR: 'BINANCE:XMRUSDT', HYPE: 'BINANCE:HYPEUSDT', TIA: 'BINANCE:TIAUSDT',
};

// TradingView wants exchange-prefixed symbols ("NSE:CORDSCABLE",
// "BSE:CORDSCABLE", "LSE:AZN") whereas the rest of the app uses
// Yahoo-style suffixes ("CORDSCABLE.NS", "AZN.L"). Translate so the
// TV widget actually loads the chart for international tickers.
// US tickers have no suffix and load as-is on TV.
function toTradingViewSymbol(yahooSymbol) {
    const s = String(yahooSymbol || '').toUpperCase();
    const m = s.match(/^([^.]+)\.([A-Z]{1,3})$/);
    if (!m) return s; // no suffix → US, pass through
    const [, ticker, suffix] = m;
    const map = {
        NS: 'NSE',    // National Stock Exchange of India
        BO: 'BSE',    // Bombay Stock Exchange
        L:  'LSE',    // London Stock Exchange
        DE: 'XETR',   // Deutsche Börse Xetra
        HK: 'HKEX',   // Hong Kong
        T:  'TSE',    // Tokyo
        AX: 'ASX',    // Australia
        TO: 'TSX',    // Toronto
        SS: 'SSE',    // Shanghai
        SZ: 'SZSE',   // Shenzhen
    };
    const ex = map[suffix];
    return ex ? `${ex}:${ticker}` : s;
}

// Free TradingView embed paywalls most non-US exchanges (NSE, BSE,
// HKEX, TSE, ASX, TSX, LSE small caps, SSE, SZSE…) — symbol resolves
// but the user sees an "only available on TradingView" upgrade prompt
// instead of the chart. Rather than maintain a piecemeal allowlist
// that breaks on the next user-reported gap, the rule is simple:
// any Yahoo-suffixed ticker (i.e. non-US) goes through our local
// candlestick chart powered by lightweight-charts + the same OHLC
// data the analysis engine pulls. US tickers keep the full TV
// widget for its richer feature set.
function isNonUsTicker(yahooSymbol) {
    return /\.[A-Z]{1,3}$/.test(String(yahooSymbol || ''));
}

export function loadChart() {
    if (!state.currentSymbol && !state.currentCoinId) return;
    // A real chart is about to replace the placeholder — stop the hero
    // particle field so its canvas + rAF loop are released.
    stopHeroParticles();
    const container = document.getElementById('tradingview-widget');
    const chartHeader = document.getElementById('chart-header');

    let symbol;
    let paywalled = false;
    if (state.mode === 'stock') {
        paywalled = isNonUsTicker(state.currentSymbol);
        symbol = toTradingViewSymbol(state.currentSymbol);
    } else {
        const sym = state.currentSymbol.toUpperCase();
        symbol = TV_CRYPTO_MAP[sym] || `BINANCE:${sym}USDT`;
    }

    teardownLocalChart();   // dispose any prior lightweight-charts instance + observer
    container.innerHTML = '';
    chartHeader.classList.remove('hidden');

    // Engine-signals mode: route through our own lightweight-charts chart so we
    // can draw the engine's past calls as markers. Now enabled for CRYPTO too
    // (the in-app chart renders crypto candles fine). Markers come from the
    // ledger, which is currently stock-only — for crypto the chart renders
    // cleanly with no markers yet (honest: we don't fabricate crypto history).
    const signalsMode = engineSignalsOn();

    // Paywalled-exchange path OR engine-signals mode: render our own chart.
    if (paywalled || signalsMode) {
        renderLocalChart(state.currentSymbol, container, { withMarkers: signalsMode, mode: state.mode, coinId: state.currentCoinId });
        return;
    }

    const themeMap = { dark: 'dark', light: 'light', colourful: 'dark' };
    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container';
    widgetDiv.innerHTML = '<div id="tv-chart"></div>';
    container.appendChild(widgetDiv);

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({
        autosize: true, symbol, interval: 'D',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        theme: themeMap[state.theme],
        style: '3', locale: 'en',
        hide_top_toolbar: false, hide_legend: false,
        save_image: false, calendar: false, hide_volume: false,
        support_host: 'https://www.tradingview.com',
    });
    widgetDiv.appendChild(script);
}

// Lazy-load TradingView's lightweight-charts library from the CDN on
// first use of the local-chart path. Cached on window so subsequent
// charts don't re-download (~70KB gzipped).
function loadLightweightCharts() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (window.__lwcLoadPromise) return window.__lwcLoadPromise;
    window.__lwcLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
        s.async = true;
        s.onload = () => resolve(window.LightweightCharts);
        s.onerror = () => reject(new Error('Failed to load lightweight-charts'));
        document.head.appendChild(s);
    });
    return window.__lwcLoadPromise;
}

async function renderLocalChart(symbol, container, opts = {}) {
    const { withMarkers = false, mode = 'stock', coinId = null } = opts;
    container.innerHTML = `<div class="chart-placeholder">
        <div class="chart-ph-title">Loading ${symbol}…</div>
    </div>`;
    try {
        let LWC, data;
        if (mode === 'crypto' && coinId) {
            // Crypto: fetch OHLC from CoinGecko by coinId (not the ticker).
            [LWC, data] = await Promise.all([
                loadLightweightCharts(),
                fetchCryptoData(coinId),
            ]);
        } else {
            // Non-US tickers arrive already exchange-tagged (suffixProbe off
            // is correct + faster). US tickers in engine-signals mode have no
            // suffix, so let the probe run for them so a bare ticker still
            // resolves. Branch on the suffix.
            const tagged = isNonUsTicker(symbol);
            [LWC, data] = await Promise.all([
                loadLightweightCharts(),
                fetchStockData(symbol, '6mo', '1d', { suffixProbe: !tagged }),
            ]);
        }
        if (!data?.candles?.length) {
            container.innerHTML = `<div class="error-message">No chart data for ${symbol}.</div>`;
            return;
        }
        const isLight = state.theme === 'light';
        // Pull background straight from CSS variables so the chart
        // stays in lockstep with the active theme. Dark mode is true
        // black (#000); light is white. Aurora (the third option) gets
        // its purple from --bg-primary too.
        const css = getComputedStyle(document.documentElement);
        const themeBg = (css.getPropertyValue('--bg-primary') || '').trim() || (isLight ? '#ffffff' : '#000000');
        const themeColors = isLight
            ? { bg: themeBg, text: '#1f2937', grid: '#e5e7eb', border: '#d1d5db' }
            : { bg: themeBg, text: '#e5e7eb', grid: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)' };

        container.innerHTML = '<div id="tv-local-chart" style="width:100%;height:100%;"></div>';
        const host = container.querySelector('#tv-local-chart');
        _localChart = LWC.createChart(host, {
            layout: { background: { color: themeColors.bg }, textColor: themeColors.text },
            grid: { vertLines: { color: themeColors.grid }, horzLines: { color: themeColors.grid } },
            timeScale: { timeVisible: false, secondsVisible: false, borderColor: themeColors.border },
            rightPriceScale: { borderColor: themeColors.border },
            crosshair: { mode: 1 },
            autoSize: true,
        });
        const chart = _localChart;   // local alias; teardownLocalChart disposes it on next render
        const candleSeries = chart.addCandlestickSeries({
            upColor: '#22c55e', downColor: '#ef4444',
            borderUpColor: '#22c55e', borderDownColor: '#ef4444',
            wickUpColor: '#22c55e', wickDownColor: '#ef4444',
        });
        const volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            scaleMargins: { top: 0.82, bottom: 0 },
        });
        candleSeries.setData(data.candles.map(c => ({
            time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
        })));
        volumeSeries.setData(data.candles.map(c => ({
            time: c.time, value: c.volume || 0,
            color: c.close >= c.open ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)',
        })));

        // 20-period moving-average overlay — gives the trend an instant read
        // (price above the MA = up-trend, below = down-trend) without the user
        // doing the eyeballing. Thin accent line, drawn under the candles.
        try {
            const MA = 20;
            const closes = data.candles.map(c => c.close);
            const maData = [];
            let sum = 0;
            for (let i = 0; i < closes.length; i++) {
                sum += closes[i];
                if (i >= MA) sum -= closes[i - MA];
                if (i >= MA - 1) maData.push({ time: data.candles[i].time, value: sum / MA });
            }
            if (maData.length > 1) {
                const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#4a9eff').trim();
                const maSeries = chart.addLineSeries({
                    color: accent, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false,
                    crosshairMarkerVisible: false,
                });
                maSeries.setData(maData);
            }
        } catch (_) { /* MA is decorative; candles already drawn */ }

        // Engine-signal markers: draw every past BUY/SELL the engine
        // logged on this symbol, positioned at its bar, arrow direction =
        // the call, color = whether it HIT (green) or MISSED (red) at the
        // 1-day horizon (grey = not yet resolved). This is the engine's
        // track record rendered directly on the price the user is looking
        // at — the most honest "was it right?" view in the app.
        if (withMarkers) {
            try {
                const firstBar = data.candles[0]?.time ?? 0;
                const { available, markers } = await readSymbolSignalMarkers({ symbol: data.symbol || symbol });
                if (available && markers.length) {
                    const lwcMarkers = markers
                        // Only mark calls that fall within the visible window.
                        .filter(m => m.time >= firstBar)
                        .map(m => {
                            const isBuy = m.signal === 'BUY';
                            const hit = m.outcome === 'hit';
                            const miss = m.outcome === 'miss';
                            // Color by OUTCOME first (the whole point), falling
                            // back to a neutral grey while unresolved.
                            const color = hit ? '#22c55e' : miss ? '#ef4444' : '#94a3b8';
                            const tail = m.outcome ? (hit ? ' ✓' : ' ✗') : '';
                            return {
                                time: m.time,
                                position: isBuy ? 'belowBar' : 'aboveBar',
                                shape: isBuy ? 'arrowUp' : 'arrowDown',
                                color,
                                text: `${m.signal} ${m.confidence}%${tail}`,
                            };
                        });
                    if (lwcMarkers.length) candleSeries.setMarkers(lwcMarkers);
                    // Anchor the absolute legend to the chart container.
                    container.style.position = 'relative';
                    renderMarkerLegend(container, markers);
                }
            } catch (_) { /* markers are best-effort; chart still renders */ }
        }

        chart.timeScale().fitContent();
        // Auto-resize when the panel layout changes (e.g. Mia / Portfolio
        // panels open and shift the main column width).
        _localChartRO = new ResizeObserver(() => chart.applyOptions({ autoSize: true }));
        _localChartRO.observe(host);
    } catch (e) {
        container.innerHTML = `<div class="error-message">Couldn't load chart: ${e.message}</div>`;
    }
}

// Small overlay legend on the chart: counts hits/misses among the drawn
// markers so the user gets the track-record summary at a glance.
function renderMarkerLegend(container, markers) {
    const resolved = markers.filter(m => m.outcome);
    if (!resolved.length) return;
    const hits = resolved.filter(m => m.outcome === 'hit').length;
    const total = resolved.length;
    const pct = Math.round((hits / total) * 100);
    const tier = pct >= 60 ? 'high' : pct >= 50 ? 'mid' : 'low';
    const el = document.createElement('div');
    el.className = `chart-signals-legend tier-${tier}`;
    el.innerHTML = `
        <span class="csl-dot hit"></span>
        <span class="csl-txt"><b>${hits}/${total}</b> engine calls hit (${pct}%)</span>
        <span class="csl-sub">▲ BUY · ▼ SELL · green = hit · red = miss</span>`;
    container.appendChild(el);
}

// "Engine Signals" toggle in the chart header. Stock-only (the ledger
// is stock-only); for crypto we show it disabled with a hint. Attached
// dynamically alongside the watch / time-travel buttons so index.html
// layout stays untouched. Idempotent per render.
export function attachEngineSignalsToggle() {
    const headerEl = document.getElementById('chart-header');
    if (!headerEl) return;
    let btn = document.getElementById('engine-signals-toggle');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'engine-signals-toggle';
        btn.className = 'engine-signals-toggle';
        btn.addEventListener('click', () => {
            // Available for stocks AND crypto now (the in-app chart renders both).
            const next = !engineSignalsOn();
            setEngineSignalsOn(next);
            paintEngineSignalsToggle(btn);
            loadChart();   // re-render in the new mode
        });
        headerEl.appendChild(btn);
    }
    paintEngineSignalsToggle(btn);
}

function paintEngineSignalsToggle(btn) {
    const on = engineSignalsOn();
    const crypto = state.mode !== 'stock';
    btn.classList.toggle('active', on);
    btn.classList.remove('disabled');
    // The chart works for both; markers are ledger-backed (stock-only today),
    // so on crypto we tell the user the chart shows but historical calls are
    // stock-only for now — honest, not a hard disable.
    btn.title = on
        ? (crypto
            ? 'Engine chart ON for this coin. Past-call markers are stock-only for now.'
            : 'Engine signals ON — showing past calls on the chart. Click to hide.')
        : 'Show the engine chart' + (crypto ? ' for this coin' : ' with past BUY/SELL calls');
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 17l5-5 4 4 8-9"/><path d="M21 7v5h-5"/>
        </svg>
        <span class="est-label">Signals${on ? ' ✓' : ''}</span>`;
}

export function showChartPlaceholder() {
    const container = document.getElementById('tradingview-widget');
    if (!container) return;
    // Roshan: text-only empty state, centered. The candle animation
    // wasn't pulling its weight here — it competed with the title
    // instead of supporting it. Just the title + subtitle now,
    // anchored vertically and horizontally by .chart-placeholder's
    // existing flex layout.
    container.innerHTML = `
        <div class="chart-placeholder">
            <div class="chart-ph-glow"></div>
            <div class="chart-ph-title shimmer">Select a stock or crypto to start</div>
            <div class="chart-ph-sub">Search above, click a hot pick below, or press <kbd>/</kbd> to focus search.</div>
        </div>`;
    // Ambient particle field behind the hero empty-state (particle-love-style:
    // drifting points linked by thin lines, easing away from the cursor).
    // Self-tears-down when a real chart replaces the placeholder. No-op under
    // reduced-motion; pauses when off-screen / tab hidden.
    stopHeroParticles();
    const ph = container.querySelector('.chart-placeholder');
    if (ph) _heroParticlesStop = mountParticles(ph);
}

export function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');
    if (symbolEl) {
        // Display ticker WITHOUT Yahoo's '.NS'/'.HK'/'.T' suffix —
        // those are Yahoo's internal disambiguation tags, not part of
        // the real exchange ticker. The exchange label after the dot
        // already tells the user which listing they're looking at, so
        // showing both is redundant.
        const ticker = displayTicker(data.symbol);
        // Resolve the exchange + country label. Prefer Yahoo's
        // meta.exchangeName code (more specific — e.g. NMS = NASDAQ vs.
        // NYQ = NYSE for US tickers); fall back to the suffix mapping
        // for anything Yahoo didn't tag (rare).
        const exLabel = fullLabelForCode(data.exchange) || fullLabelForSymbol(data.symbol);
        const namePart = data.name ? ` — ${data.name}` : '';
        const exPart = exLabel ? ` · ${exLabel}` : '';
        symbolEl.textContent = `${ticker}${namePart}${exPart}`;
    }
    attachTimeTravel();
    attachWatchButton(data.symbol);
    attachTradeButtons(data.symbol);
    attachEngineSignalsToggle();
    if (data.currentPrice) {
        state.currentPrice = data.currentPrice;
        if (priceEl) {
            const change = data.previousClose
                ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                : 0;
            const looksReal = Number.isFinite(change) && Math.abs(change) <= 50;
            // data.currency comes from Yahoo's meta.currency — INR for
            // .NS/.BO, GBP for .L, HKD for .HK, JPY for .T, etc. Pass
            // it as srcCurrency so the formatter doesn't FX-convert a
            // ₹230 price as if it were $230.
            const priceMarkup = fmtPriceTag(data.currentPrice, { srcCurrency: data.currency || 'USD' });
            if (looksReal) {
                const changeClass = change >= 0 ? 'up' : 'down';
                const arrow = change >= 0 ? '▲' : '▼';
                priceEl.innerHTML = `${priceMarkup} <span class="chart-change ${changeClass}">${arrow} ${Math.abs(change).toFixed(2)}%</span>`;
            } else {
                priceEl.innerHTML = priceMarkup;
            }
        }
    }
}
