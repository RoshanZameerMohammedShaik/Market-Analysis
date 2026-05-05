// UI Rendering Module
import { searchStocks, searchCrypto, fetchStockData, fetchCryptoData, fetchStockMultiTimeframe, fetchCryptoMultiTimeframe, fetchWithProxy } from './data.js';
import { generatePrediction, generateMultiTimeframePrediction } from './analysis.js';
import { scanStockHotPicks, scanCryptoHotPicks } from './hotpicks.js';
import { fetchStockNews, fetchCryptoNews, aggregateNewsSentiment } from './news.js';

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
    mode: 'stock',      // 'stock' or 'crypto'
    timeframe: 'today', // 'today' or 'tomorrow'
    theme: localStorage.getItem('ma-theme') || 'dark',
    currentSymbol: null,
    currentCoinId: null,
    cryptoCache: {},    // Cache sparkline/market data from hot picks scan
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

    // Map to TradingView symbol format
    let symbol;
    if (state.mode === 'stock') {
        symbol = state.currentSymbol;
    } else {
        // TradingView crypto format: BTCUSD, ETHUSD, etc.
        // Use common exchange prefixes for better chart availability
        const sym = state.currentSymbol.toUpperCase();
        const tvCryptoMap = {
            'BTC': 'BINANCE:BTCUSDT', 'ETH': 'BINANCE:ETHUSDT', 'SOL': 'BINANCE:SOLUSDT',
            'XRP': 'BINANCE:XRPUSDT', 'DOGE': 'BINANCE:DOGEUSDT', 'ADA': 'BINANCE:ADAUSDT',
            'DOT': 'BINANCE:DOTUSDT', 'AVAX': 'BINANCE:AVAXUSDT', 'LINK': 'BINANCE:LINKUSDT',
            'MATIC': 'BINANCE:MATICUSDT', 'LTC': 'BINANCE:LTCUSDT', 'UNI': 'BINANCE:UNIUSDT',
            'ATOM': 'BINANCE:ATOMUSDT', 'NEAR': 'BINANCE:NEARUSDT', 'SUI': 'BINANCE:SUIUSDT',
            'BNB': 'BINANCE:BNBUSDT', 'SHIB': 'BINANCE:SHIBUSDT', 'PEPE': 'BINANCE:PEPEUSDT',
            'ARB': 'BINANCE:ARBUSDT', 'OP': 'BINANCE:OPUSDT', 'APT': 'BINANCE:APTUSDT',
            'INJ': 'BINANCE:INJUSDT', 'HBAR': 'BINANCE:HBARUSDT', 'BCH': 'BINANCE:BCHUSDT',
            'XMR': 'BINANCE:XMRUSDT', 'HYPE': 'BINANCE:HYPEUSDT', 'TIA': 'BINANCE:TIAUSDT',
        };
        symbol = tvCryptoMap[sym] || `BINANCE:${sym}USDT`;
    }

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
        let prediction, newsData, sentiment;

        if (state.mode === 'stock') {
            const [multiData, news] = await Promise.all([
                fetchStockMultiTimeframe(state.currentSymbol),
                fetchStockNews(state.currentSymbol).catch(() => []),
            ]);
            prediction = generateMultiTimeframePrediction(multiData, state.timeframe);
            newsData = news;
            sentiment = aggregateNewsSentiment(news);
            updateChartHeader(multiData.daily);
        } else {
            // Crypto: try cached sparkline first, then OHLC, then market endpoint
            let multiData = null;
            const coinId = state.currentCoinId;
            const coinName = state.currentSymbol;

            // Try fetching OHLC data
            try {
                multiData = await fetchCryptoMultiTimeframe(coinId);
            } catch (ohlcError) {
                // OHLC failed — try using cached sparkline from hot picks
                const cached = state.cryptoCache[coinId];
                if (cached && cached.sparkline && cached.sparkline.length >= 20) {
                    const candles = sparklineToCandlesUI(cached.sparkline);
                    multiData = {
                        daily: { symbol: coinName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                        weekly: { symbol: coinName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                        fourHour: { symbol: coinName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                    };
                }
            }

            if (!multiData) {
                // Final fallback: try the single market data endpoint
                try {
                    const marketRes = await fetchWithProxy(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=30`);
                    const marketData = await marketRes.json();
                    if (marketData.prices && marketData.prices.length > 20) {
                        const candles = marketData.prices.map(([time, price]) => ({
                            time: time / 1000, open: price, high: price * 1.005, low: price * 0.995, close: price, volume: 0,
                        }));
                        const currentPrice = candles[candles.length - 1].close;
                        multiData = {
                            daily: { symbol: coinName, name: coinName, currentPrice, previousClose: candles[candles.length - 2]?.close, candles },
                            weekly: { symbol: coinName, name: coinName, currentPrice, previousClose: null, candles },
                            fourHour: { symbol: coinName, name: coinName, currentPrice, previousClose: null, candles },
                        };
                    }
                } catch (e) { /* give up */ }
            }

            if (!multiData) {
                throw new Error(`Could not fetch data for ${coinName}. This coin may not have enough trading history.`);
            }

            const news = await fetchCryptoNews(coinName).catch(() => []);
            prediction = generateMultiTimeframePrediction(multiData, state.timeframe);
            newsData = news;
            sentiment = aggregateNewsSentiment(news);
            updateChartHeader(multiData.daily);
        }

        // Adjust prediction confidence based on news sentiment
        prediction = adjustWithSentiment(prediction, sentiment);

        renderSignal(prediction, newsData, sentiment);
    } catch (e) {
        signalSection.innerHTML = `<div class="error-message fade-in">Analysis failed: ${e.message}. Try another symbol.</div>`;
    }
}

function adjustWithSentiment(prediction, sentiment) {
    if (!sentiment || sentiment.overall === 'neutral') return prediction;

    let adjustment = 0;
    const sentimentAligns = (
        (prediction.signal === 'BUY' && sentiment.overall === 'positive') ||
        (prediction.signal === 'SELL' && sentiment.overall === 'negative')
    );
    const sentimentConflicts = (
        (prediction.signal === 'BUY' && sentiment.overall === 'negative') ||
        (prediction.signal === 'SELL' && sentiment.overall === 'positive')
    );

    if (sentimentAligns) {
        adjustment = Math.round(Math.abs(sentiment.score) * 5); // +1 to +5
    } else if (sentimentConflicts) {
        adjustment = -Math.round(Math.abs(sentiment.score) * 5); // -1 to -5
    }

    const newConfidence = Math.max(35, Math.min(88, prediction.confidence + adjustment));
    return { ...prediction, confidence: newConfidence, sentimentAdjustment: adjustment };
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

function renderSignal(prediction, newsData = [], sentiment = null) {
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

    // Human-readable insight summary
    const insightSummary = generateHumanInsight(prediction, sentiment);

    // News sentiment section
    let newsHTML = '';
    if (newsData.length > 0) {
        const sentimentIcon = sentiment.overall === 'positive' ? '🟢' : sentiment.overall === 'negative' ? '🔴' : '🟡';
        newsHTML = `
            <div class="news-section">
                <div class="news-header">
                    <span class="news-title">📰 Market News & Sentiment</span>
                    <span class="news-sentiment-badge ${sentiment.overall}">${sentimentIcon} ${sentiment.overall.toUpperCase()}</span>
                </div>
                <div class="news-summary">${sentiment.summary}</div>
                <div class="news-list">
                    ${newsData.slice(0, 5).map(item => {
                        const sentIcon = item.sentiment.label === 'positive' ? '🟢' : item.sentiment.label === 'negative' ? '🔴' : '⚪';
                        const timeAgo = getTimeAgo(item.date);
                        return `<div class="news-item">
                            <span class="news-item-sentiment">${sentIcon}</span>
                            <div class="news-item-content">
                                <div class="news-item-title">${item.title}</div>
                                <div class="news-item-meta">${item.source} • ${timeAgo}</div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // Technical details (collapsible)
    const technicalHTML = `
        <details class="technical-details">
            <summary>Technical Indicators Detail</summary>
            <ul class="signal-reasons">
                ${reasons.map(r => `<li>${humanizeReason(r)}</li>`).join('')}
            </ul>
        </details>
    `;

    section.innerHTML = `
        <div class="signal-box ${signalClass} fade-in">
            <div class="signal-header">
                <span class="signal-arrow ${arrowClass}">${arrow}</span>
                <span class="signal-label ${signalClass}">${signal}</span>
                <span class="signal-confidence">Confidence: ${confidence}%</span>
                <button class="refresh-btn small" id="refresh-analysis" title="Re-run analysis with latest data">↻ Refresh Analysis</button>
            </div>
            <div class="confidence-bar">
                <div class="confidence-fill ${confidenceClass}" style="width: ${confidence}%"></div>
            </div>
            <div class="insight-summary">${insightSummary}</div>
            ${priceTargetHTML}
            ${newsHTML}
            ${technicalHTML}
            <div class="signal-meta" style="margin-top: 12px;">
                Timeframe: ${state.timeframe === 'today' ? 'Today' : 'Tomorrow'} |
                Analysis: Technical + News Sentiment + Multi-Timeframe
            </div>
        </div>
    `;

    // Attach refresh handler
    document.getElementById('refresh-analysis')?.addEventListener('click', () => {
        runAnalysis();
    });
}

// ─── HUMAN-READABLE INSIGHTS ─────────────────────────────────────────────────

function generateHumanInsight(prediction, sentiment) {
    const { signal, confidence, priceTargets } = prediction;
    const tfWord = state.timeframe === 'today' ? 'today' : 'tomorrow';
    let insight = '';

    if (signal === 'BUY') {
        if (confidence >= 70) {
            insight = `<strong>Strong bullish signal.</strong> Multiple technical indicators align upward. `;
        } else if (confidence >= 55) {
            insight = `<strong>Moderate buy signal.</strong> More indicators point up than down. `;
        } else {
            insight = `<strong>Weak buy signal.</strong> Slight bullish edge but low conviction. `;
        }

        if (priceTargets) {
            insight += `Price could reach <span class="highlight-green">$${priceTargets.predictedHigh}</span> ${tfWord} (+${priceTargets.highPercent}%). `;
            insight += `Downside risk to $${priceTargets.predictedLow} (${priceTargets.lowPercent}%).`;
        }
    } else if (signal === 'SELL') {
        if (confidence >= 70) {
            insight = `<strong>Strong bearish signal.</strong> Multiple indicators point to decline. `;
        } else if (confidence >= 55) {
            insight = `<strong>Moderate sell signal.</strong> Bearish pressure building. `;
        } else {
            insight = `<strong>Weak sell signal.</strong> Slight bearish edge but uncertain. `;
        }

        if (priceTargets) {
            insight += `Price may drop to <span class="highlight-red">$${priceTargets.predictedLow}</span> ${tfWord} (${priceTargets.lowPercent}%). `;
            insight += `Upside capped around $${priceTargets.predictedHigh} (+${priceTargets.highPercent}%).`;
        }
    } else {
        insight = `<strong>No clear direction.</strong> Indicators are conflicting — the market is undecided. `;
        insight += `Consider waiting for a clearer setup before entering a position.`;
    }

    // Add sentiment context
    if (sentiment && sentiment.overall !== 'neutral') {
        if (sentiment.overall === 'positive' && signal === 'BUY') {
            insight += ` <span class="highlight-green">News sentiment confirms bullish bias.</span>`;
        } else if (sentiment.overall === 'negative' && signal === 'SELL') {
            insight += ` <span class="highlight-red">Negative news reinforces bearish outlook.</span>`;
        } else if (sentiment.overall === 'negative' && signal === 'BUY') {
            insight += ` <span class="highlight-yellow">Caution: news sentiment is negative despite bullish technicals.</span>`;
        } else if (sentiment.overall === 'positive' && signal === 'SELL') {
            insight += ` <span class="highlight-yellow">Note: positive news may limit downside despite bearish technicals.</span>`;
        }
    }

    return insight;
}

function humanizeReason(reason) {
    // Convert technical jargon to human-readable
    return reason
        .replace(/\[Daily\]\s*/g, '<span class="badge-tf daily">Daily</span> ')
        .replace(/\[Weekly\]\s*/g, '<span class="badge-tf weekly">Weekly</span> ')
        .replace(/\[4H\]\s*/g, '<span class="badge-tf fourh">4H</span> ')
        .replace(/RSI oversold at ([\d.]+)/g, 'Oversold (RSI: $1) — price is cheap, bounce expected')
        .replace(/RSI overbought at ([\d.]+)/g, 'Overbought (RSI: $1) — price stretched too high')
        .replace(/MACD bullish crossover/g, 'Momentum just flipped bullish (MACD cross)')
        .replace(/MACD bearish crossunder/g, 'Momentum just flipped bearish (MACD cross)')
        .replace(/MACD positive momentum/g, 'Momentum is building upward')
        .replace(/MACD negative momentum/g, 'Momentum is fading / turning down')
        .replace(/Golden cross — 9 MA crossed above 21 MA/g, 'Short-term trend crossed above longer trend (bullish)')
        .replace(/Death cross — 9 MA crossed below 21 MA/g, 'Short-term trend crossed below longer trend (bearish)')
        .replace(/Short MA above long MA — bullish trend/g, 'Trending upward on daily timeframe')
        .replace(/Short MA below long MA — bearish trend/g, 'Trending downward on daily timeframe')
        .replace(/Price below lower Bollinger Band/g, 'Price is unusually low vs. its range')
        .replace(/Price above upper Bollinger Band/g, 'Price is unusually high vs. its range')
        .replace(/Volume spike \(([\d.]+)x avg\) confirms upward move/g, 'High volume ($1x normal) backing the move up')
        .replace(/Volume spike \(([\d.]+)x avg\) confirms selling pressure/g, 'Heavy selling volume ($1x normal)')
        .replace(/Strong upward momentum \(([^)]+)\)/g, 'Strong upward push ($1)')
        .replace(/Strong downward momentum \(([^)]+)\)/g, 'Strong downward push ($1)')
        .replace(/All timeframes align (BUY|SELL) — high confluence/g, 'All timeframes agree: $1 — strong setup')
        .replace(/Timeframe conflict detected — reduced confidence/g, 'Short-term vs long-term disagree — proceed with caution');
}

function getTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// ─── HOT PICKS ───────────────────────────────────────────────────────────────

let hotPicksRequestId = 0; // Cancellation token for race conditions

export async function loadHotPicks() {
    const requestId = ++hotPicksRequestId; // Increment to invalidate previous requests
    const grid = document.getElementById('hotpicks-grid');
    const title = document.getElementById('hotpicks-title');
    const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
    const modeLabel = state.mode === 'stock' ? 'Stocks' : 'Crypto';
    if (title) title.textContent = `🔥 Hot Picks — Top ${modeLabel} for ${tfLabel}`;

    grid.innerHTML = `<div class="loading" style="grid-column: 1/-1;">
        <div class="loader"></div>
        <span class="loading-text">Fetching live market movers and running predictions...</span>
    </div>`;

    try {
        let picks;
        const currentMode = state.mode; // Capture mode at call time
        if (currentMode === 'stock') {
            picks = await scanStockHotPicks(state.timeframe);
        } else {
            picks = await scanCryptoHotPicks(state.timeframe);
        }

        // If user switched tabs while we were loading, discard these results
        if (requestId !== hotPicksRequestId) return;

        // Cache crypto data for click-through analysis
        if (currentMode === 'crypto') {
            picks.forEach(pick => {
                if (pick.id && pick._sparkline) {
                    state.cryptoCache[pick.id] = {
                        name: pick.name,
                        price: pick.price,
                        sparkline: pick._sparkline,
                    };
                }
            });
        }

        if (picks.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
                <div class="empty-state-icon">📊</div>
                <p>No strong BUY signals found right now. Market may be uncertain.</p>
            </div>`;
            return;
        }

        grid.innerHTML = picks.map(pick => {
            const isBuy = pick.signal === 'BUY';
            const arrow = isBuy ? '▲' : '◆';
            const signalClass = isBuy ? 'buy' : 'neutral';
            const signalLabel = isBuy ? 'BUY' : 'HOLD';
            return `
            <div class="hot-pick-card ${signalClass} fade-in" data-symbol="${pick.symbol}" data-id="${pick.id || pick.symbol}">
                <div class="hot-pick-symbol">${pick.symbol}</div>
                <div class="hot-pick-name">${pick.name}</div>
                <div class="hot-pick-signal-badge ${signalClass}">${signalLabel}</div>
                <div class="hot-pick-confidence ${signalClass}">
                    <span class="hot-pick-arrow">${arrow}</span> ${pick.confidence}%
                </div>
                <div class="hot-pick-price">$${pick.price ? pick.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'}</div>
            </div>`;
        }).join('');

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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sparklineToCandlesUI(prices) {
    if (!prices || prices.length < 20) return [];
    const periodSize = 4;
    const candles = [];
    for (let i = 0; i < prices.length; i += periodSize) {
        const slice = prices.slice(i, i + periodSize);
        if (slice.length === 0) continue;
        candles.push({
            time: Date.now() / 1000 - (prices.length - i) * 3600,
            open: slice[0],
            high: Math.max(...slice),
            low: Math.min(...slice),
            close: slice[slice.length - 1],
            volume: 0,
        });
    }
    return candles;
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

    // Hot picks refresh button
    document.getElementById('refresh-hotpicks').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.classList.add('spinning');
        loadHotPicks().finally(() => {
            btn.classList.remove('spinning');
        });
    });
}
