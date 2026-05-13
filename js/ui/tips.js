// Loading tips. Random rotation, no consecutive repeats. Designed to
// teach the user something about markets while they wait.

const TIPS = [
    'A signal is most reliable when 3+ independent indicators agree.',
    'RSI under 30 = oversold; over 70 = overbought. Reversals tend to follow.',
    'MACD crossovers are early; the histogram tells you if the move has legs.',
    'Bollinger Bands measure volatility — squeezes often precede big moves.',
    'ADX > 25 = strong trend. Below 20 = chop, where breakouts often fail.',
    'Volume confirms price. A move on low volume is a move on borrowed time.',
    'The Fear & Greed Index is contrarian — extreme fear historically buys.',
    'VIX spikes mark uncertainty; calm VIX = complacency, not safety.',
    'Candle bodies show conviction; wicks show rejection at price levels.',
    'A doji candle signals indecision — watch the next bar for direction.',
    'Support and resistance are zones, not exact lines.',
    'Mean reversion works in ranges. Trend-following works in trends. Know which you are in.',
    'Multi-timeframe confluence (daily + weekly agreeing) is the highest-quality setup.',
    'Price action leads news. By the time news arrives, the move has often started.',
    'Position sizing matters more than entry. A great signal at 100% portfolio is still bad risk.',
    'Stop losses cap downside. Without them, one loss can erase ten wins.',
    'Sentiment leads sometimes, lags often. Use it as confirmation, not a primary signal.',
    'A strong stock in a weak market is fighting the tide. Check the broader trend.',
    'High-confidence signals are rare; if every analysis is 80%+, recalibrate.',
    'Money Flow Index = RSI weighted by volume. Catches institutional moves RSI misses.',
    'Golden cross (50 over 200) historically marks the start of multi-month uptrends.',
    'Death cross is the inverse. It tends to be a slower, longer-lasting bearish signal.',
    'ATR (Average True Range) sizes your stops to the symbol\'s normal volatility.',
    'Crypto trades 24/7 — stocks don\'t. Crypto sentiment can swing harder overnight.',
    'Earnings reports double normal volatility for the day. Position accordingly.',
    '"Sell the news" is real. Stocks often peak the morning of good earnings.',
    'Gaps tend to fill, but not always quickly. Don\'t treat gap-fills as guarantees.',
    'A breakout on huge volume is a breakout. On thin volume it\'s a fakeout 60% of the time.',
    'Beware of confirmation bias — you\'ll find evidence for whatever you already believe.',
    'Backtests overstate live performance. Real markets have slippage and emotion.',
    'The trend is your friend — until it bends. Watch for momentum divergence.',
    'Higher highs and higher lows = uptrend. Break the structure and the trend may be over.',
    'Don\'t chase. The best entries are pullbacks within a confirmed trend.',
    'Two losses in a row don\'t mean the system is broken; six in a row might.',
    'Risk-reward of 2:1 or better lets you be wrong 60% of the time and still profit.',
    'Sector rotation is real — a great stock in a falling sector usually still falls.',
    'Calibrated confidence means "70%" actually hits 70% of the time. Without it, it\'s a vibe.',
    'A flat market is the hardest to predict. Sometimes the right call is no call.',
    'Your worst trades teach the most. Keep a journal.',
    'No model predicts the future perfectly. Edge is statistical, not certain.',
];

let shuffled = [];
let idx = 0;
let lastShown = -1;

function reshuffle() {
    shuffled = [...TIPS].sort(() => Math.random() - 0.5);
    idx = 0;
}

export function nextTip() {
    if (shuffled.length === 0 || idx >= shuffled.length) reshuffle();
    let pick = shuffled[idx];
    idx++;
    // Avoid showing the same tip twice in a row across reshuffles.
    if (pick === lastShown && shuffled.length > 1) {
        pick = shuffled[idx % shuffled.length];
        idx++;
    }
    lastShown = pick;
    return pick;
}

export function startTipRotation(targetEl, intervalMs = 4500) {
    if (!targetEl) return () => {};
    let stopped = false;
    const update = () => {
        if (stopped) return;
        targetEl.textContent = nextTip();
        targetEl.classList.remove('tip-fade');
        // restart fade animation
        void targetEl.offsetWidth;
        targetEl.classList.add('tip-fade');
    };
    update();
    const timer = setInterval(update, intervalMs);
    return () => { stopped = true; clearInterval(timer); };
}
