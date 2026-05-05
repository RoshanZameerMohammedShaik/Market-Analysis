// UI Rendering Module
import { searchStocks, searchCrypto, fetchStockData, fetchCryptoData, fetchStockMultiTimeframe, fetchCryptoMultiTimeframe } from './data.js';
import { generatePrediction, generateMultiTimeframePrediction } from './analysis.js';
import { scanStockHotPicks, scanCryptoHotPicks } from './hotpicks.js';

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
    mode: 'stock',      // 'stock' or 'crypto'
    timeframe: 'today', // 'today' or 'tomorrow'
    theme: localStorage.getItem('ma-theme') || 'dark',
    currentSymbol: null,
    currentCoinId: null,
};

// ─── THEME MANAGEMENT ────────────────────────────────────────────────────────

const themes = ['dark', 'light', 'colourful'];
const themeIcons = { dark: '🌙', light: '☀️', colourful: '🎨' };

export function initTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}

export function cycleTheme() {
    const idx = themes.indexOf(state.theme);
    state.theme = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('ma-theme', state.theme);
    updateThemeButton();
    // Update TradingView chart theme if loaded
    if (state.currentSymbol || state.currentCoinId) {
        loadChart();
    }
}

function updateThemeButton() {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = themeIcons[state.theme];
}

// ─── TAB MANAGEMENT ──────────────────────────────────────────────────────────

export function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            state.mode = tab;
            document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePlaceholder();
            clearAnalysis();
            loadHotPicks();
        });
    });

    document.querySelectorAll('[data-timeframe]').forEach(btn => {
        btn.addEventListener('click', () => {
            const tf = btn.dataset.timeframe;
            state.timeframe = tf;
            document.querySelectorAll('[data-timeframe]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (state.currentSymbol || state.currentCoinId) {
                runAnalysis();
            }
            loadHotPicks();
        });
    });
}

function updatePlaceholder() {
    const input = document.getElementById('search-input');
    if (state.mode === 'stock') {
        input.placeholder = 'Search stocks by name or symbol (e.g., AAPL, Tesla)...';
    } else {
        input.placeholder = 'Search crypto by name (e.g., Bitcoin, Solana)...';
    }
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────

let searchTimeout = null;

export function initSearch() {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = input.value.trim();
        if (query.length < 2) {
            results.classList.remove('visible');
            return;
        }
        searchTimeout = setTimeout(() => performSearch(query), 300);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim().length >= 2) {
            results.classList.add('visible');
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            results.classList.remove('visible');
        }
    });
}

async function performSearch(query) {
    const results = document.getElementById('search-results');
    results.innerHTML = '<div class="loading"><div class="loader"></div></div>';
    results.classList.add('visible');

    try {
        let items;
        if (state.mode === 'stock') {
            items = await searchStocks(query);
        } else {
            items = await searchCrypto(query);
        }

        if (items.length === 0) {
            results.innerHTML = '<div class="empty-state">No results found</div>';
            return;
        }

        results.innerHTML = items.map(item => {
            if (state.mode === 'stock') {
                return `<div class="search-result-item" data-symbol="${item.symbol}">
                    <div>
                        <span class="result-symbol">${item.symbol}</span>
                        <span class="result-name">${item.name}</span>
                    </div>
                    <span class="result-name">${item.exchange || ''}</span>
                </div>`;
            } else {
                return `<div class="search-result-item" data-coinid="${item.id}" data-symbol="${item.symbol}">
                    <div>
                        <span class="result-symbol">${item.symbol}</span>
                        <span class="result-name">${item.name}</span>
                    </div>
                </div>`;
            }
        }).join('');

        results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => selectResult(el));
        });
    } catch (e) {
        results.innerHTML = `<div class="error-message">Search failed: ${e.message}</div>`;
    }
}

function selectResult(el) {
    const results = document.getElementById('search-results');
    const input = document.getElementById('search-input');
    results.classList.remove('visible');

    if (state.mode === 'stock') {
        state.currentSymbol = el.dataset.symbol;
        state.currentCoinId = null;
        input.value = state.currentSymbol;
    } else {
        state.currentCoinId = el.dataset.coinid;
        state.currentSymbol = el.dataset.symbol;
        input.value = state.currentSymbol;
    }

    loadChart();
    runAnalysis();
}

// ─── CHART ───────────────────────────────────────────────────────────────────

function loadChart() {
    const container = document.getElementById('tradingview-widget');
    const chartHeader = document.getElementById('chart-header');

    if (!state.currentSymbol && !state.currentCoinId) return;

    const symbol = state.mode === 'stock'
        ? state.currentSymbol
        : `${state.currentSymbol}USD`;

    const themeMap = { dark: 'dark', light: 'light', colourful: 'dark' };

    container.innerHTML = '';
    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container';
    widgetDiv.innerHTML = `<div id="tv-chart"></div>`;
    container.appendChild(widgetDiv);

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({
        autosize: true,
        symbol: symbol,
        interval: 'D',
        timezone: 'Etc/UTC',
        theme: themeMap[state.theme],
        style: '3', // Line/area chart (ECG style)
        locale: 'en',
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        calendar: false,
        hide_volume: false,
        support_host: 'https://www.tradingview.com',
    });
    widgetDiv.appendChild(script);

    chartHeader.classList.remove('hidden');
}

// ─── ANALYSIS ────────────────────────────────────────────────────────────────

async function runAnalysis() {
    const signalSection = document.getElementById('signal-section');
    signalSection.innerHTML = `<div class="loading fade-in">
        <div class="loader"></div>
        <span class="loading-text">Analyzing ${state.currentSymbol || state.currentCoinId}...</span>
    </div>`;

    try {
        let prediction;

        if (state.mode === 'stock') {
            const multiData = await fetchStockMultiTimeframe(state.currentSymbol);
            prediction = generateMultiTimeframePrediction(multiData, state.timeframe);
            updateChartHeader(multiData.daily);
        } else {
            const multiData = await fetchCryptoMultiTimeframe(state.currentCoinId);
            prediction = generateMultiTimeframePrediction(multiData, state.timeframe);
            updateChartHeader(multiData.daily);
        }

        renderSignal(prediction);
    } catch (e) {
        signalSection.innerHTML = `<div class="error-message fade-in">Analysis failed: ${e.message}. Try another symbol.</div>`;
    }
}

function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');

    if (symbolEl) symbolEl.textContent = `${data.symbol} — ${data.name || ''}`;
    if (priceEl && data.currentPrice) {
        const change = data.previousClose
            ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
            : 0;
        const changeClass = change >= 0 ? 'up' : 'down';
        const arrow = change >= 0 ? '▲' : '▼';
        priceEl.innerHTML = `$${data.currentPrice.toFixed(2)}
            <span class="chart-change ${changeClass}">${arrow} ${Math.abs(change).toFixed(2)}%</span>`;
    }
}

function renderSignal(prediction) {
    const section = document.getElementById('signal-section');
    const { signal, confidence, reasons, priceTargets } = prediction;

    const signalClass = signal.toLowerCase();
    const arrow = signal === 'BUY' ? '▲' : signal === 'SELL' ? '▼' : '◆';
    const arrowClass = signal === 'BUY' ? 'up' : signal === 'SELL' ? 'down' : 'neutral';
    const confidenceClass = confidence >= 65 ? 'high' : confidence >= 50 ? 'medium' : 'low';

    // Price targets HTML
    let priceTargetHTML = '';
    if (priceTargets) {
        const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
        priceTargetHTML = `
            <div class="price-targets fade-in">
                <div class="price-targets-title">Predicted Price Range — ${tfLabel}</div>
                <div class="price-targets-grid">
                    <div class="price-target-card high">
                        <div class="price-target-label">Predicted High</div>
                        <div class="price-target-value high">$${priceTargets.predictedHigh.toLocaleString()}</div>
                        <div class="price-target-pct up">▲ +${priceTargets.highPercent}%</div>
                    </div>
                    <div class="price-target-card current">
                        <div class="price-target-label">Current Price</div>
                        <div class="price-target-value">$${priceTargets.currentPrice.toLocaleString()}</div>
                        <div class="price-target-pct">ATR: $${priceTargets.atr}</div>
                    </div>
                    <div class="price-target-card low">
                        <div class="price-target-label">Predicted Low</div>
                        <div class="price-target-value low">$${priceTargets.predictedLow.toLocaleString()}</div>
                        <div class="price-target-pct down">▼ ${priceTargets.lowPercent}%</div>
                    </div>
                </div>
                <div class="price-targets-meta">
                    Support: $${priceTargets.support} | Resistance: $${priceTargets.resistance} | Expected Move: ±$${priceTargets.expectedMove}
                </div>
            </div>
        `;
    }

    section.innerHTML = `
        <div class="signal-box ${signalClass} fade-in">
            <div class="signal-header">
                <span class="signal-arrow ${arrowClass}">${arrow}</span>
                <span class="signal-label ${signalClass}">${signal}</span>
                <span class="signal-confidence">Confidence: ${confidence}%</span>
            </div>
            <div class="confidence-bar">
                <div class="confidence-fill ${confidenceClass}" style="width: ${confidence}%"></div>
            </div>
            ${priceTargetHTML}
            <ul class="signal-reasons">
                ${reasons.map(r => `<li>${r}</li>`).join('')}
            </ul>
            <div style="margin-top: 12px; font-size: 0.75rem; color: var(--text-muted);">
                Timeframe: ${state.timeframe === 'today' ? 'Today' : 'Tomorrow'} |
                Multi-timeframe confluence analysis (Daily + Weekly + 4H)
            </div>
        </div>
    `;
}

// ─── HOT PICKS ───────────────────────────────────────────────────────────────

export async function loadHotPicks() {
    const grid = document.getElementById('hotpicks-grid');
    grid.innerHTML = `<div class="loading" style="grid-column: 1/-1;">
        <div class="loader"></div>
        <span class="loading-text">Scanning for hot picks...</span>
    </div>`;

    try {
        let picks;
        if (state.mode === 'stock') {
            picks = await scanStockHotPicks(state.timeframe);
        } else {
            picks = await scanCryptoHotPicks(state.timeframe);
        }

        if (picks.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No strong BUY signals found right now. Market may be uncertain.</p>
            </div>`;
            return;
        }

        grid.innerHTML = picks.map(pick => `
            <div class="hot-pick-card fade-in" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}">
                <div class="hot-pick-symbol">${pick.symbol}</div>
                <div class="hot-pick-name">${pick.name}</div>
                <div class="hot-pick-confidence">
                    <span class="hot-pick-arrow">▲</span> ${pick.confidence}%
                </div>
                <div class="hot-pick-price">$${pick.price ? pick.price.toFixed(2) : '—'}</div>
            </div>
        `).join('');

        // Click to analyze
        grid.querySelectorAll('.hot-pick-card').forEach(card => {
            card.addEventListener('click', () => {
                const symbol = card.dataset.symbol;
                const id = card.dataset.id;
                document.getElementById('search-input').value = symbol;

                if (state.mode === 'stock') {
                    state.currentSymbol = symbol;
                    state.currentCoinId = null;
                } else {
                    state.currentSymbol = symbol;
                    state.currentCoinId = id;
                }

                loadChart();
                runAnalysis();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    } catch (e) {
        grid.innerHTML = `<div class="error-message" style="grid-column: 1/-1;">Failed to load hot picks: ${e.message}</div>`;
    }
}

// ─── CLEAR STATE ─────────────────────────────────────────────────────────────

function clearAnalysis() {
    document.getElementById('signal-section').innerHTML = '';
    document.getElementById('chart-header').classList.add('hidden');
    document.getElementById('tradingview-widget').innerHTML = '';
    state.currentSymbol = null;
    state.currentCoinId = null;
    document.getElementById('search-input').value = '';
}

// ─── INIT ────────────────────────────────────────────────────────────────────

export function init() {
    initTheme();
    initTabs();
    initSearch();
    updatePlaceholder();
    loadHotPicks();

    document.getElementById('theme-toggle').addEventListener('click', cycleTheme);
}
