// Humanizers and explainers for technical reasons / news headlines.
// Lifted from the old ui.js so the rest of the UI can stay rendering-focused.

export function humanizeReason(reason) {
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

export function generateNewsImpact(title, sentimentLabel, symbol) {
    const sym = symbol || 'this asset';
    const lower = title.toLowerCase();

    if (lower.includes('earnings') || lower.includes('revenue') || lower.includes('profit')) {
        if (sentimentLabel === 'positive') return `Positive earnings/revenue news suggests strong fundamentals for ${sym}. This could drive buying pressure and push the price higher in the short term.`;
        if (sentimentLabel === 'negative') return `Negative earnings data signals weakness in ${sym}'s fundamentals. Expect potential selling pressure as investors reassess valuations.`;
        return `Earnings-related news for ${sym}. Monitor the actual numbers vs analyst expectations for directional clarity.`;
    }
    if (lower.includes('upgrade') || lower.includes('price target')) return `Analyst action on ${sym}. Upgrades and raised price targets typically trigger institutional buying. This is a bullish catalyst.`;
    if (lower.includes('downgrade') || lower.includes('cut')) return `Analyst downgrade or target cut for ${sym}. This signals reduced institutional confidence and may trigger selling pressure.`;
    if (lower.includes('fda') || lower.includes('approval') || lower.includes('patent')) return `Regulatory/IP news for ${sym}. Approvals and patent grants are strong catalysts that can drive significant price moves.`;
    if (lower.includes('lawsuit') || lower.includes('investigation') || lower.includes('sec') || lower.includes('fraud')) return `Legal/regulatory risk for ${sym}. Investigations and lawsuits create uncertainty and typically pressure stock prices downward until resolution.`;
    if (lower.includes('partnership') || lower.includes('deal') || lower.includes('contract') || lower.includes('launch')) return `Business development news for ${sym}. New partnerships and product launches signal growth potential and can attract buyers.`;
    if (lower.includes('layoff') || lower.includes('restructur')) return `Restructuring news for ${sym}. Layoffs may boost short-term margins but signal underlying business challenges. Mixed impact.`;
    if (lower.includes('inflation') || lower.includes('rate') || lower.includes('fed')) return `Macro/Fed news affecting ${sym}. Interest rate decisions and inflation data impact all equities — higher rates typically pressure growth stocks.`;
    if (lower.includes('war') || lower.includes('geopolit') || lower.includes('sanction') || lower.includes('tariff')) return `Geopolitical event impacting ${sym}. These create market uncertainty and typically increase volatility across sectors.`;

    if (sentimentLabel === 'positive') return `Positive coverage for ${sym}. Bullish news flow tends to attract buying interest and supports upward price movement.`;
    if (sentimentLabel === 'negative') return `Negative coverage for ${sym}. Bearish news creates selling pressure and may weigh on price in the near term.`;
    return `Neutral news mention for ${sym}. No strong directional bias from this headline alone — monitor for follow-up developments.`;
}

// Plain-English context for a small set of textbook indicators.
// Returns null when the reason doesn't match a known pattern — caller
// should fall back to the raw reason text rather than a generic
// placeholder, since the raw reason is already specific (e.g.
// "[Sector] Tech sector rising 1.2% 5d — aligned" already explains
// itself; wrapping it in a generic "this indicator provides context"
// blurb adds noise instead of insight).
export function generateTechnicalExplanation(reason, _overallSignal, symbol) {
    const sym = symbol || 'this asset';
    const lower = reason.toLowerCase();

    if (lower.includes('rsi') && lower.includes('oversold')) return `The RSI (Relative Strength Index) has dropped below 30, indicating ${sym} is oversold. Historically, this means sellers are exhausted and a bounce is likely. This is one of the strongest mean-reversion signals — price has fallen too far too fast and tends to recover.`;
    if (lower.includes('rsi') && lower.includes('overbought')) return `The RSI is above 70, signaling ${sym} is overbought. The stock has risen too fast relative to its normal range. While momentum can continue, the probability of a pullback or consolidation increases significantly at these levels.`;
    if (lower.includes('macd') && (lower.includes('crossover') || lower.includes('bullish'))) return `The MACD line has crossed above the signal line for ${sym}. This is a classic momentum shift — short-term momentum is now outpacing longer-term momentum, suggesting the start of an upward move.`;
    if (lower.includes('macd') && (lower.includes('crossunder') || lower.includes('bearish'))) return `The MACD line has crossed below the signal line. Momentum for ${sym} is shifting downward — short-term selling pressure is overtaking buying interest. This often precedes further decline.`;
    if (lower.includes('macd') && lower.includes('positive momentum')) return `MACD histogram is positive and expanding for ${sym}. This confirms the current uptrend has momentum behind it — buyers are in control and the trend is likely to continue.`;
    if (lower.includes('macd') && lower.includes('negative momentum')) return `MACD histogram is negative for ${sym}. Selling momentum is building — each bounce is weaker than the last, suggesting bears are in control of the short-term trend.`;
    if (lower.includes('bollinger') && lower.includes('lower')) return `${sym}'s price has touched or broken below the lower Bollinger Band. This means price is 2 standard deviations below its 20-day average — statistically unusual. Mean reversion (bounce back toward the middle band) is the most probable outcome.`;
    if (lower.includes('bollinger') && lower.includes('upper')) return `Price is at or above the upper Bollinger Band for ${sym}. The stock is 2 standard deviations above its average — extended territory. While breakouts can continue, the probability of reverting back toward the mean is elevated.`;
    if (lower.includes('golden cross') || (lower.includes('ma') && lower.includes('crossed above'))) return `Short-term moving average crossed above the longer-term average for ${sym}. This "golden cross" signals that recent price action is now stronger than the prevailing trend — a bullish structural shift.`;
    if (lower.includes('death cross') || (lower.includes('ma') && lower.includes('crossed below'))) return `Short-term moving average crossed below the longer-term for ${sym}. This "death cross" indicates the short-term trend has turned negative — a bearish structural shift that often leads to further downside.`;
    if (lower.includes('trending upward') || lower.includes('bullish trend')) return `${sym} is in a confirmed uptrend — the short-term MA is above the long-term MA. In trending markets, pullbacks to the moving average are typically buying opportunities rather than trend reversals.`;
    if (lower.includes('trending downward') || lower.includes('bearish trend')) return `${sym} is in a confirmed downtrend. Bounces within a downtrend tend to be short-lived. Trading against the trend carries higher risk — wait for a structural shift before going long.`;
    if (lower.includes('volume') && lower.includes('spike')) return `Volume is significantly above average for ${sym}. High volume validates the current price move — if price is rising on high volume, buyers are committed. If falling on high volume, institutions are selling.`;
    if (lower.includes('momentum') && lower.includes('upward')) return `Strong positive momentum over the last 5 days for ${sym}. The price has been consistently climbing — momentum tends to persist in the short term before exhaustion.`;
    if (lower.includes('momentum') && lower.includes('downward')) return `Strong negative momentum for ${sym} over the last 5 days. Persistent selling is hard to reverse quickly — expect continued pressure unless a catalyst changes the narrative.`;
    if (lower.includes('all timeframes align')) return `Daily, weekly, and 4-hour timeframes all agree on direction for ${sym}. This is the highest-confidence technical setup — when all timeframes confirm, the probability of the move succeeding is at its peak.`;
    if (lower.includes('conflict') || lower.includes('disagree')) return `Different timeframes are giving conflicting signals for ${sym}. The short-term and long-term trends disagree — this means higher uncertainty. Consider reducing position size or waiting for alignment.`;

    // No textbook match. Return null so the caller surfaces the raw
    // reason text — it's already specific (tagged + parameterized
    // from real engine output) and rendering a generic placeholder
    // dozens of times made the panel look broken.
    return null;
}
