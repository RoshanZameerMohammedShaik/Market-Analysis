// Left-rail glossary + FAQ + Mia intro. Renders into #glossary-rail on init.
// Items are <details> so users can scan and expand what interests them.

const SECTIONS = [
    {
        title: 'Meet Mia',
        intro: 'Market Intelligence Analyst — your in-app chatbot. Click the 💬 launcher (bottom-right) to ask anything about a stock, an indicator, or what a signal means.',
        items: [],
    },
    {
        title: 'Signal terminology',
        items: [
            ['Signal', 'BUY / SELL / NEUTRAL. The direction the engine thinks price is heading over the chosen timeframe.'],
            ['Confidence', 'How likely the signal is to play out, expressed as a percentage. When backtest data is loaded, this is the empirical hit rate — not a heuristic.'],
            ['Timeframe', 'Today = next bar. Tomorrow = roughly 24 hours out. Tomorrow predictions are slightly less confident on average because more can change.'],
            ['Confluence', 'When daily, weekly, and 4-hour timeframes all agree. The highest-quality setup; confidence gets a bonus.'],
            ['Trend regime', 'The market\'s current behavior. "Trending" rewards momentum signals; "ranging" rewards mean-reversion signals.'],
        ],
    },
    {
        title: 'Indicators we use',
        items: [
            ['RSI', 'Relative Strength Index. Below 30 = oversold (bounce likely). Above 70 = overbought (pullback likely).'],
            ['MACD', 'Moving Average Convergence/Divergence. Crossovers signal momentum shifts.'],
            ['Bollinger Bands', 'Volatility envelope around price. Touches of the outer bands often precede mean-reversion moves.'],
            ['ADX', 'Trend strength meter. Above 25 = strong trend. Below 20 = chop, where breakouts often fail.'],
            ['MFI', 'Money Flow Index. Like RSI but weighted by volume — catches institutional moves.'],
            ['ATR', 'Average True Range. Used to scale stop-losses and price targets to a stock\'s normal volatility.'],
        ],
    },
    {
        title: 'Sources we blend',
        items: [
            ['Technicals', 'Multi-timeframe indicator agreement. The largest weight, most reliable in the medium term.'],
            ['AI Model', 'A small LSTM trained on 300 stocks and 38 crypto symbols, retrained monthly. Acts as a pattern-recognition co-pilot.'],
            ['Sentiment', 'FinBERT analyzes recent news headlines. Recent news weighted higher than stale news.'],
            ['Market', 'Fear & Greed Index, VIX, S&P 500 trend. Provides regime context.'],
        ],
    },
    {
        title: 'Calibration',
        items: [
            ['What is calibration?', 'A 70%-confidence signal should hit 70% of the time historically. Calibration adjusts displayed confidence to match real outcomes from backtesting.'],
            ['Backtest', 'A simulation that replays our signal pipeline across years of past data. Daily-refreshed via GitHub Actions.'],
            ['Live accuracy', 'Your personal hit rate. Every signal you\'re shown is logged and resolved against future prices, in your browser.'],
        ],
    },
    {
        title: 'FAQs',
        items: [
            ['How accurate is this?', 'It depends — see the per-confidence-bucket calibration. Anyone claiming "95% accuracy" on stock prediction is either lying or has overfit.'],
            ['Should I trade based on this?', 'No tool replaces your own judgment. This is one input among many. Position size matters more than entry.'],
            ['Where does the data come from?', 'Yahoo Finance for stocks, CoinGecko for crypto, Google News + FinBERT for sentiment, alternative.me for Fear & Greed. All free, no API keys.'],
            ['Is my data sent anywhere?', 'No. Everything runs in your browser. Your prediction history lives in your browser\'s localStorage.'],
            ['What\'s “dev mode”?', 'A diagnostic view for the developer. Shows calibration metadata, raw vs. calibrated confidence, and a personal-accuracy strip. Public users see a cleaner view.'],
        ],
    },
];

export function renderGlossary() {
    const rail = document.getElementById('glossary-rail');
    if (!rail) return;
    rail.innerHTML = SECTIONS.map((section, sIdx) => {
        const intro = section.intro ? `<p class="glos-intro">${section.intro}</p>` : '';
        const items = section.items.map(([term, def]) => `
            <details class="glos-item">
                <summary><span class="glos-term">${term}</span><span class="glos-chev">▸</span></summary>
                <div class="glos-def">${def}</div>
            </details>`).join('');
        return `
            <section class="glos-section" data-idx="${sIdx}">
                <h3 class="glos-title">${section.title}</h3>
                ${intro}
                ${items}
            </section>`;
    }).join('');
}
