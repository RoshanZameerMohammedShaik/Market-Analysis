import { state } from './state.js';
import { fmtPrice, fmtPriceTag } from './format.js';
import { attachWatchButton } from './watchlist.js';
import { attachTimeTravel } from './time-travel.js';

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
            <div class="chart-ph-icon chart-ph-ecg">
                <svg class="chart-ph-ecg-svg" viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path class="chart-ph-ecg-trace" d="M0 30 L40 30 Q50 30 55 24 T65 30 L80 8 L100 52 L120 8 L140 30 Q150 30 155 24 T165 30 L200 30" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path class="chart-ph-ecg-blip" d="M0 30 L40 30 Q50 30 55 24 T65 30 L80 8 L100 52 L120 8 L140 30 Q150 30 155 24 T165 30 L200 30" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="chart-ph-title">Select a stock or crypto to start</div>
            <div class="chart-ph-sub">Search above, click a hot pick below, or press <kbd>/</kbd> to focus search.</div>
        </div>`;
}

export function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');
    if (symbolEl) symbolEl.textContent = `${data.symbol} — ${data.name || ''}`;
    attachTimeTravel();
    attachWatchButton(data.symbol);
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
