// UI Rendering Module
import { searchStocks, searchCrypto, fetchStockMultiTimeframe, fetchCryptoMultiTimeframe, fetchWithProxy } from './data.js';
import { scanStockHotPicks, scanCryptoHotPicks } from './hotpicks.js';
import { computeFullConfidence } from './confidence.js';
import { loadModel } from './ai-model.js';

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = {
    mode: 'stock',      // 'stock' or 'crypto'
    timeframe: 'today', // 'today' or 'tomorrow'
    theme: localStorage.getItem('ma-theme') || 'dark',
    currentSymbol: null,
    currentCoinId: null,
    currentPrice: null, // For P&L calculator auto-fill
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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
        <span class="loading-text">Running full analysis: AI + Technicals + Sentiment + Market...</span>
    </div>`;

    try {
        let multiData = null;
        const symbolId = state.mode === 'stock' ? state.currentSymbol : state.currentCoinId;
        const symbolName = state.currentSymbol;

        if (state.mode === 'stock') {
            multiData = await fetchStockMultiTimeframe(state.currentSymbol);
        } else {
            // Crypto: try OHLC -> cached sparkline -> market_chart fallback
            const coinId = state.currentCoinId;
            try {
                multiData = await fetchCryptoMultiTimeframe(coinId);
            } catch (ohlcError) {
                const cached = state.cryptoCache[coinId];
                if (cached && cached.sparkline && cached.sparkline.length >= 20) {
                    const candles = sparklineToCandlesUI(cached.sparkline);
                    multiData = {
                        daily: { symbol: symbolName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                        weekly: { symbol: symbolName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                        fourHour: { symbol: symbolName, name: cached.name, currentPrice: cached.price, previousClose: null, candles },
                    };
                }
            }

            if (!multiData) {
                try {
                    const marketRes = await fetchWithProxy(
                        `https://api.coingecko.com/api/v3/coins/${state.currentCoinId}/market_chart?vs_currency=usd&days=30`
                    );
                    const marketData = await marketRes.json();
                    if (marketData.prices && marketData.prices.length > 20) {
                        const candles = marketData.prices.map(([time, price]) => ({
                            time: time / 1000, open: price, high: price * 1.005, low: price * 0.995, close: price, volume: 0,
                        }));
                        const currentPrice = candles[candles.length - 1].close;
                        multiData = {
                            daily: { symbol: symbolName, name: symbolName, currentPrice, previousClose: candles[candles.length - 2]?.close, candles },
                            weekly: { symbol: symbolName, name: symbolName, currentPrice, previousClose: null, candles },
                            fourHour: { symbol: symbolName, name: symbolName, currentPrice, previousClose: null, candles },
                        };
                    }
                } catch (e) { /* give up */ }
            }

            if (!multiData) {
                throw new Error(`Could not fetch data for ${symbolName}.`);
            }
        }

        updateChartHeader(multiData.daily);

        // Run the FULL 4-source confidence engine
        const result = await computeFullConfidence(multiData, state.mode, symbolId, state.timeframe);

        renderSignal(result, result.news, { overall: result.newsOverall, summary: result.newsSummary });
    } catch (e) {
        signalSection.innerHTML = `<div class="error-message fade-in">Analysis failed: ${e.message}. Try another symbol.</div>`;
    }
}


function updateChartHeader(data) {
    const symbolEl = document.getElementById('chart-symbol');
    const priceEl = document.getElementById('chart-price');

    if (symbolEl) symbolEl.textContent = `${data.symbol} — ${data.name || ''}`;
    if (data.currentPrice) {
        state.currentPrice = data.currentPrice; // Store for P&L calculator auto-fill
        if (priceEl) {
            const change = data.previousClose
                ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                : 0;
            const changeClass = change >= 0 ? 'up' : 'down';
            const arrow = change >= 0 ? '▲' : '▼';
            priceEl.innerHTML = `$${data.currentPrice.toFixed(2)}
                <span class="chart-change ${changeClass}">${arrow} ${Math.abs(change).toFixed(2)}%</span>`;
        }
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
                        const sentIcon = item.sentiment ? (item.sentiment.label === 'positive' ? '🟢' : item.sentiment.label === 'negative' ? '🔴' : '⚪') : '⚪';
                        const sentLabel = item.sentiment ? item.sentiment.label : 'neutral';
                        const timeAgo = getTimeAgo(item.date);
                        const impact = generateNewsImpact(item.title, sentLabel, state.currentSymbol);
                        return `<details class="accordion-item news-accordion">
                            <summary class="accordion-header">
                                <span class="news-item-sentiment">${sentIcon}</span>
                                <div class="accordion-header-content">
                                    <div class="news-item-title">${item.title}</div>
                                    <div class="news-item-meta">${item.source} • ${timeAgo}</div>
                                </div>
                                <span class="accordion-chevron">▸</span>
                            </summary>
                            <div class="accordion-body">
                                <div class="accordion-impact ${sentLabel}">${impact}</div>
                            </div>
                        </details>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // Technical details — each indicator as an accordion
    const technicalHTML = `
        <div class="technical-section">
            <div class="section-subtitle">Technical Indicators</div>
            <div class="accordion-list">
                ${reasons.map(r => {
                    const humanized = humanizeReason(r);
                    const explanation = generateTechnicalExplanation(r, signal, state.currentSymbol);
                    const indicatorClass = r.includes('bull') || r.includes('BUY') || r.includes('oversold') || r.includes('positive') || r.includes('upward') ? 'positive' : r.includes('bear') || r.includes('SELL') || r.includes('overbought') || r.includes('negative') || r.includes('downward') ? 'negative' : 'neutral';
                    return `<details class="accordion-item tech-accordion">
                        <summary class="accordion-header">
                            <span class="accordion-dot ${indicatorClass}"></span>
                            <div class="accordion-header-content">
                                <div class="accordion-title">${humanized}</div>
                            </div>
                            <span class="accordion-chevron">▸</span>
                        </summary>
                        <div class="accordion-body">
                            <div class="accordion-explanation">${explanation}</div>
                        </div>
                    </details>`;
                }).join('')}
            </div>
        </div>
    `;

    // Source breakdown (4 bars showing each component's contribution)
    let breakdownHTML = '';
    if (prediction.breakdown) {
        const bd = prediction.breakdown;
        breakdownHTML = `
            <div class="source-breakdown">
                <div class="breakdown-title">Confidence Sources</div>
                <div class="breakdown-bars">
                    ${bd.ai.available ? `<div class="breakdown-item">
                        <span class="breakdown-label">AI Model (${bd.ai.weight}%)</span>
                        <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${bd.ai.score}%; background: var(--accent);"></div></div>
                        <span class="breakdown-score">${bd.ai.score}</span>
                    </div>` : ''}
                    <div class="breakdown-item">
                        <span class="breakdown-label">Technicals (${bd.technical.weight}%)</span>
                        <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${bd.technical.score}%; background: var(--green);"></div></div>
                        <span class="breakdown-score">${bd.technical.score}</span>
                    </div>
                    <div class="breakdown-item">
                        <span class="breakdown-label">Sentiment (${bd.sentiment.weight}%)</span>
                        <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${bd.sentiment.score}%; background: var(--yellow);"></div></div>
                        <span class="breakdown-score">${bd.sentiment.score}</span>
                    </div>
                    <div class="breakdown-item">
                        <span class="breakdown-label">Market (${bd.market.weight}%)</span>
                        <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${bd.market.score}%; background: #a371f7;"></div></div>
                        <span class="breakdown-score">${bd.market.score}</span>
                    </div>
                </div>
            </div>
        `;
    }

    const methodLabel = prediction.method || 'Technical + News + Multi-Timeframe';

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
            ${breakdownHTML}
            <div class="insight-summary">${insightSummary}</div>
            ${priceTargetHTML}
            ${newsHTML}
            ${technicalHTML}
            <div class="signal-meta" style="margin-top: 12px;">
                Timeframe: ${state.timeframe === 'today' ? 'Today' : 'Tomorrow'} |
                ${methodLabel}
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

function generateNewsImpact(title, sentimentLabel, symbol) {
    const sym = symbol || 'this asset';
    const lower = title.toLowerCase();

    // Contextual impact based on headline content
    if (lower.includes('earnings') || lower.includes('revenue') || lower.includes('profit')) {
        if (sentimentLabel === 'positive') return `Positive earnings/revenue news suggests strong fundamentals for ${sym}. This could drive buying pressure and push the price higher in the short term.`;
        if (sentimentLabel === 'negative') return `Negative earnings data signals weakness in ${sym}'s fundamentals. Expect potential selling pressure as investors reassess valuations.`;
        return `Earnings-related news for ${sym}. Monitor the actual numbers vs analyst expectations for directional clarity.`;
    }
    if (lower.includes('upgrade') || lower.includes('price target')) {
        return `Analyst action on ${sym}. Upgrades and raised price targets typically trigger institutional buying. This is a bullish catalyst.`;
    }
    if (lower.includes('downgrade') || lower.includes('cut')) {
        return `Analyst downgrade or target cut for ${sym}. This signals reduced institutional confidence and may trigger selling pressure.`;
    }
    if (lower.includes('fda') || lower.includes('approval') || lower.includes('patent')) {
        return `Regulatory/IP news for ${sym}. Approvals and patent grants are strong catalysts that can drive significant price moves.`;
    }
    if (lower.includes('lawsuit') || lower.includes('investigation') || lower.includes('sec') || lower.includes('fraud')) {
        return `Legal/regulatory risk for ${sym}. Investigations and lawsuits create uncertainty and typically pressure stock prices downward until resolution.`;
    }
    if (lower.includes('partnership') || lower.includes('deal') || lower.includes('contract') || lower.includes('launch')) {
        return `Business development news for ${sym}. New partnerships and product launches signal growth potential and can attract buyers.`;
    }
    if (lower.includes('layoff') || lower.includes('restructur')) {
        return `Restructuring news for ${sym}. Layoffs may boost short-term margins but signal underlying business challenges. Mixed impact.`;
    }
    if (lower.includes('inflation') || lower.includes('rate') || lower.includes('fed')) {
        return `Macro/Fed news affecting ${sym}. Interest rate decisions and inflation data impact all equities — higher rates typically pressure growth stocks.`;
    }
    if (lower.includes('war') || lower.includes('geopolit') || lower.includes('sanction') || lower.includes('tariff')) {
        return `Geopolitical event impacting ${sym}. These create market uncertainty and typically increase volatility across sectors.`;
    }

    // Generic based on sentiment
    if (sentimentLabel === 'positive') return `Positive coverage for ${sym}. Bullish news flow tends to attract buying interest and supports upward price movement.`;
    if (sentimentLabel === 'negative') return `Negative coverage for ${sym}. Bearish news creates selling pressure and may weigh on price in the near term.`;
    return `Neutral news mention for ${sym}. No strong directional bias from this headline alone — monitor for follow-up developments.`;
}

function generateTechnicalExplanation(reason, overallSignal, symbol) {
    const sym = symbol || 'this asset';
    const lower = reason.toLowerCase();

    if (lower.includes('rsi') && lower.includes('oversold')) {
        return `The RSI (Relative Strength Index) has dropped below 30, indicating ${sym} is oversold. Historically, this means sellers are exhausted and a bounce is likely. This is one of the strongest mean-reversion signals — price has fallen too far too fast and tends to recover.`;
    }
    if (lower.includes('rsi') && lower.includes('overbought')) {
        return `The RSI is above 70, signaling ${sym} is overbought. The stock has risen too fast relative to its normal range. While momentum can continue, the probability of a pullback or consolidation increases significantly at these levels.`;
    }
    if (lower.includes('macd') && (lower.includes('crossover') || lower.includes('bullish'))) {
        return `The MACD line has crossed above the signal line for ${sym}. This is a classic momentum shift — it means short-term momentum is now outpacing longer-term momentum, suggesting the start of an upward move.`;
    }
    if (lower.includes('macd') && (lower.includes('crossunder') || lower.includes('bearish'))) {
        return `The MACD line has crossed below the signal line. Momentum for ${sym} is shifting downward — short-term selling pressure is overtaking buying interest. This often precedes further decline.`;
    }
    if (lower.includes('macd') && lower.includes('positive momentum')) {
        return `MACD histogram is positive and expanding for ${sym}. This confirms the current uptrend has momentum behind it — buyers are in control and the trend is likely to continue.`;
    }
    if (lower.includes('macd') && lower.includes('negative momentum')) {
        return `MACD histogram is negative for ${sym}. Selling momentum is building — each bounce is weaker than the last, suggesting bears are in control of the short-term trend.`;
    }
    if (lower.includes('bollinger') && lower.includes('lower')) {
        return `${sym}'s price has touched or broken below the lower Bollinger Band. This means price is 2 standard deviations below its 20-day average — statistically unusual. Mean reversion (bounce back toward the middle band) is the most probable outcome.`;
    }
    if (lower.includes('bollinger') && lower.includes('upper')) {
        return `Price is at or above the upper Bollinger Band for ${sym}. The stock is 2 standard deviations above its average — extended territory. While breakouts can continue, the probability of reverting back toward the mean is elevated.`;
    }
    if (lower.includes('golden cross') || (lower.includes('ma') && lower.includes('crossed above'))) {
        return `Short-term moving average crossed above the longer-term average for ${sym}. This "golden cross" signals that recent price action is now stronger than the prevailing trend — a bullish structural shift.`;
    }
    if (lower.includes('death cross') || (lower.includes('ma') && lower.includes('crossed below'))) {
        return `Short-term moving average crossed below the longer-term for ${sym}. This "death cross" indicates the short-term trend has turned negative — a bearish structural shift that often leads to further downside.`;
    }
    if (lower.includes('trending upward') || lower.includes('bullish trend')) {
        return `${sym} is in a confirmed uptrend — the short-term MA is above the long-term MA. In trending markets, pullbacks to the moving average are typically buying opportunities rather than trend reversals.`;
    }
    if (lower.includes('trending downward') || lower.includes('bearish trend')) {
        return `${sym} is in a confirmed downtrend. Bounces within a downtrend tend to be short-lived. Trading against the trend carries higher risk — wait for a structural shift before going long.`;
    }
    if (lower.includes('volume') && lower.includes('spike')) {
        return `Volume is significantly above average for ${sym}. High volume validates the current price move — if price is rising on high volume, buyers are committed. If falling on high volume, institutions are selling.`;
    }
    if (lower.includes('momentum') && lower.includes('upward')) {
        return `Strong positive momentum over the last 5 days for ${sym}. The price has been consistently climbing — momentum tends to persist in the short term before exhaustion.`;
    }
    if (lower.includes('momentum') && lower.includes('downward')) {
        return `Strong negative momentum for ${sym} over the last 5 days. Persistent selling is hard to reverse quickly — expect continued pressure unless a catalyst changes the narrative.`;
    }
    if (lower.includes('all timeframes align')) {
        return `Daily, weekly, and 4-hour timeframes all agree on direction for ${sym}. This is the highest-confidence technical setup — when all timeframes confirm, the probability of the move succeeding is at its peak.`;
    }
    if (lower.includes('conflict') || lower.includes('disagree')) {
        return `Different timeframes are giving conflicting signals for ${sym}. The short-term and long-term trends disagree — this means higher uncertainty. Consider reducing position size or waiting for alignment.`;
    }

    // Generic fallback
    return `This technical indicator provides context on ${sym}'s current price behavior relative to its historical patterns. Combined with other signals, it contributes to the overall directional assessment.`;
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
        <span class="loading-text" id="hotpicks-progress">Initializing...</span>
    </div>`;

    const updateProgress = (msg) => {
        const el = document.getElementById('hotpicks-progress');
        if (el) el.textContent = msg;
    };

    try {
        let picks;
        const currentMode = state.mode;
        if (currentMode === 'stock') {
            picks = await scanStockHotPicks(state.timeframe, 20, updateProgress);
        } else {
            picks = await scanCryptoHotPicks(state.timeframe, 20, updateProgress);
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
    initPLCalculator();

    // Preload AI model in background
    loadModel().then(loaded => {
        if (loaded) console.log('[Market Analyzer] AI model loaded');
    });

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

// ─── P&L CALCULATOR ─────────────────────────────────────────────────────────

function initPLCalculator() {
    const fab = document.getElementById('pl-fab');
    const panel = document.getElementById('pl-panel');
    const overlay = document.getElementById('pl-overlay');
    const closeBtn = document.getElementById('pl-close');
    const calcBtn = document.getElementById('pl-calcBtn');

    // Open panel
    fab.addEventListener('click', () => {
        panel.classList.add('open');
        overlay.classList.add('open');
        // Auto-fill current price from active analysis
        if (state.currentPrice) {
            document.getElementById('pl-currentPrice').value = state.currentPrice;
        }
    });

    // Close panel
    const closePanel = () => {
        panel.classList.remove('open');
        overlay.classList.remove('open');
    };
    closeBtn.addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);

    // Calculate
    calcBtn.addEventListener('click', calculatePL);
    document.getElementById('pl-panel').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') calculatePL();
    });
}

function calculatePL() {
    const errEl = document.getElementById('pl-error');
    const resEl = document.getElementById('pl-result');
    errEl.classList.remove('show');
    resEl.classList.remove('show', 'profit', 'loss', 'neutral');

    const investment = parseFloat(document.getElementById('pl-investment').value);
    const buyPrice = parseFloat(document.getElementById('pl-buyPrice').value);
    const currentPrice = parseFloat(document.getElementById('pl-currentPrice').value);

    if ([investment, buyPrice, currentPrice].some(v => isNaN(v) || v < 0)) {
        errEl.textContent = 'Please enter valid positive numbers for all fields.';
        errEl.classList.add('show');
        return;
    }
    if (buyPrice === 0) {
        errEl.textContent = 'Purchase price cannot be zero.';
        errEl.classList.add('show');
        return;
    }

    const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const shares = investment / buyPrice;
    const currentValue = shares * currentPrice;
    const plDollar = currentValue - investment;
    const plPct = ((currentPrice - buyPrice) / buyPrice) * 100;

    const isProfit = plDollar > 0;
    const isLoss = plDollar < 0;
    const type = isProfit ? 'profit' : isLoss ? 'loss' : 'neutral';

    document.getElementById('pl-resIcon').textContent = isProfit ? '📈' : isLoss ? '📉' : '➖';
    document.getElementById('pl-resLabel').textContent = isProfit ? 'Total Profit' : isLoss ? 'Total Loss' : 'Break Even';
    document.getElementById('pl-resAmount').textContent = (plDollar >= 0 ? '+$' : '-$') + fmt(Math.abs(plDollar));
    document.getElementById('pl-resPct').textContent = (plPct >= 0 ? '+' : '') + fmt(plPct) + '%';
    document.getElementById('pl-resShares').textContent = fmt(shares);
    document.getElementById('pl-resValue').textContent = '$' + fmt(currentValue);

    resEl.classList.add(type);
    requestAnimationFrame(() => resEl.classList.add('show'));
}
