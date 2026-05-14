import { state } from './state.js';
import { fmtPrice, fmtPriceTag } from './format.js';

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

export function loadChart() {
    if (!state.currentSymbol && !state.currentCoinId) return;
    const container = document.getElementById('tradingview-widget');
    const chartHeader = document.getElementById('chart-header');

    let symbol;
    if (state.mode === 'stock') symbol = state.currentSymbol;
    else {
        const sym = state.currentSymbol.toUpperCase();
        symbol = TV_CRYPTO_MAP[sym] || `BINANCE:${sym}USDT`;
    }

    const themeMap = { dark: 'dark', light: 'light', colourful: 'dark' };
    container.innerHTML = '';
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
    chartHeader.classList.remove('hidden');
}

export function showChartPlaceholder() {
    const container = document.getElementById('tradingview-widget');
    if (!container) return;
    container.innerHTML = `
        <div class="chart-placeholder">
            <div class="chart-ph-glow"></div>
            <div class="chart-ph-icon">📊</div>
            <div class="chart-ph-title">Select a stock or crypto to start</div>
            <div class="chart-ph-sub">Search above, click a hot pick below, or press <kbd>/</kbd> to focus search.</div>
        </div>`;
}

export function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');
    if (symbolEl) symbolEl.textContent = `${data.symbol} — ${data.name || ''}`;
    if (data.currentPrice) {
        state.currentPrice = data.currentPrice;
        if (priceEl) {
            const change = data.previousClose
                ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                : 0;
            const looksReal = Number.isFinite(change) && Math.abs(change) <= 50;
            const priceMarkup = fmtPriceTag(data.currentPrice);
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
