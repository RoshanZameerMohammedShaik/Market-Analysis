import { state } from './state.js';
import { fmtPrice, fmtPriceTag } from './format.js';
import { attachWatchButton } from './watchlist.js';
import { attachTradeButtons } from './trade-buttons.js';
import { attachTimeTravel } from './time-travel.js';
import { candleLoaderHTML } from './skeleton.js';
import { fetchStockData } from '../data.js';
import { fullLabelForSymbol, fullLabelForCode } from './exchanges.js';

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

    container.innerHTML = '';
    chartHeader.classList.remove('hidden');

    // Paywalled-exchange path: render our own chart from Yahoo data.
    if (paywalled) {
        renderLocalChart(state.currentSymbol, container);
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

async function renderLocalChart(symbol, container) {
    container.innerHTML = `<div class="chart-placeholder">
        <div class="chart-ph-icon chart-ph-candles">${candleLoaderHTML(4)}</div>
        <div class="chart-ph-title">Loading ${symbol}…</div>
    </div>`;
    try {
        const [LWC, data] = await Promise.all([
            loadLightweightCharts(),
            fetchStockData(symbol, '6mo', '1d'),
        ]);
        if (!data?.candles?.length) {
            container.innerHTML = `<div class="error-message">No chart data for ${symbol}.</div>`;
            return;
        }
        const isLight = state.theme === 'light';
        const themeColors = isLight
            ? { bg: '#ffffff', text: '#1f2937', grid: '#e5e7eb', border: '#d1d5db' }
            : { bg: '#0b1020', text: '#e5e7eb', grid: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.1)' };

        container.innerHTML = '<div id="tv-local-chart" style="width:100%;height:100%;"></div>';
        const host = container.querySelector('#tv-local-chart');
        const chart = LWC.createChart(host, {
            layout: { background: { color: themeColors.bg }, textColor: themeColors.text },
            grid: { vertLines: { color: themeColors.grid }, horzLines: { color: themeColors.grid } },
            timeScale: { timeVisible: false, secondsVisible: false, borderColor: themeColors.border },
            rightPriceScale: { borderColor: themeColors.border },
            crosshair: { mode: 1 },
            autoSize: true,
        });
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
        chart.timeScale().fitContent();
        // Auto-resize when the panel layout changes (e.g. Mia / Portfolio
        // panels open and shift the main column width).
        const ro = new ResizeObserver(() => chart.applyOptions({ autoSize: true }));
        ro.observe(host);
    } catch (e) {
        container.innerHTML = `<div class="error-message">Couldn't load chart: ${e.message}</div>`;
    }
}

export function showChartPlaceholder() {
    const container = document.getElementById('tradingview-widget');
    if (!container) return;
    // Replace the M-shaped ECG mark with the same red/green candle
    // animation we use in the analysis loader. Roshan asked to bring
    // the original "MARKET ANALYZER" candle row back as the empty-chart
    // hero. Reusing candleLoaderHTML() keeps a single source of truth
    // for the candlestick markup; CSS gives the chart-ph variant its
    // own size scale (it's the focal element here, not a tucked-in
    // skeleton inside a panel).
    container.innerHTML = `
        <div class="chart-placeholder">
            <div class="chart-ph-glow"></div>
            <div class="chart-ph-icon chart-ph-candles">
                ${candleLoaderHTML(4)}
            </div>
            <div class="chart-ph-title">Select a stock or crypto to start</div>
            <div class="chart-ph-sub">Search above, click a hot pick below, or press <kbd>/</kbd> to focus search.</div>
        </div>`;
}

export function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');
    if (symbolEl) {
        // Resolve the exchange + country label. Prefer Yahoo's
        // meta.exchangeName code (more specific — e.g. NMS = NASDAQ vs.
        // NYQ = NYSE for US tickers); fall back to the suffix mapping
        // for anything Yahoo didn't tag (rare).
        const exLabel = fullLabelForCode(data.exchange) || fullLabelForSymbol(data.symbol);
        const namePart = data.name ? ` — ${data.name}` : '';
        const exPart = exLabel ? ` · ${exLabel}` : '';
        symbolEl.textContent = `${data.symbol}${namePart}${exPart}`;
    }
    attachTimeTravel();
    attachWatchButton(data.symbol);
    attachTradeButtons(data.symbol);
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
