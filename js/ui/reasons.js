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

// Symbol-specific context for a small set of indicators. When an
// `indicatorSnapshot` is supplied (the real RSI / MACD / Bollinger /
// ADX / volume values the engine just computed for THIS symbol), the
// explanation is built from those actual numbers — e.g. "RSI is 27.4
// for AAPL, 2.6 points below the 30 oversold line" — instead of a
// textbook blurb. Without a snapshot it degrades to the prior generic
// (still symbol-named) text. Returns null when nothing matches so the
// caller surfaces the raw reason (already specific).
//
// snap shape (all fields optional): { price, rsi, macd:{hist,line,signal,
//   crossover,crossunder}, bb:{upper,middle,lower,percentB,bandwidthPct},
//   adx, mfi, atr, atrPct, volRatio, momentumPct, trendRegime }
export function generateTechnicalExplanation(reason, _overallSignal, symbol, snap = null) {
    const sym = symbol || 'this asset';
    const lower = reason.toLowerCase();
    const has = (k) => snap && snap[k] != null;
    // Compact price formatter for band edges — avoids importing the FX
    // formatter here (these are raw native-currency levels, shown plain).
    const px = (v) => {
        if (!Number.isFinite(v)) return '';
        const abs = Math.abs(v);
        const d = abs >= 100 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
        return v.toFixed(d);
    };

    // ── RSI ──────────────────────────────────────────────────────────────
    if (lower.includes('rsi')) {
        if (has('rsi')) {
            const v = snap.rsi;
            if (v < 30) return `RSI is <strong>${v}</strong> for ${sym} — ${(30 - v).toFixed(1)} points below the 30 oversold line. Sellers look exhausted; this is the engine's strongest mean-reversion read, and at the short horizon oversold ${sym} has historically bounced back toward its mean.`;
            if (v < 40) return `RSI is <strong>${v}</strong> for ${sym} — approaching the 30 oversold zone but not there yet. Downside momentum is cooling; a turn is plausible but not confirmed until RSI either crosses back up or tags 30.`;
            if (v > 70) return `RSI is <strong>${v}</strong> for ${sym} — ${(v - 70).toFixed(1)} points above the 70 overbought line. The move is stretched; momentum can persist, but the odds of a pause or pullback rise sharply this far above 70.`;
            if (v > 60) return `RSI is <strong>${v}</strong> for ${sym} — elevated but below the 70 overbought line. Buyers are still in control; watch for a push above 70 (exhaustion risk) or a roll-over back under 60 (momentum fading).`;
            return `RSI is <strong>${v}</strong> for ${sym} — squarely in the neutral 40–60 band. No mean-reversion edge from RSI here; the call is leaning on other indicators.`;
        }
        if (lower.includes('oversold')) return `RSI has dropped below 30 for ${sym} — oversold. Sellers look exhausted and a bounce is the most probable near-term outcome.`;
        if (lower.includes('overbought')) return `RSI is above 70 for ${sym} — overbought. The move is stretched and a pullback or consolidation becomes more likely.`;
    }

    // ── MACD ─────────────────────────────────────────────────────────────
    if (lower.includes('macd')) {
        const m = has('macd') ? snap.macd : null;
        const histTxt = m && m.hist != null ? ` (histogram ${m.hist >= 0 ? '+' : ''}${m.hist})` : '';
        if (lower.includes('crossover') || (m?.crossover)) return `MACD just crossed bullish for ${sym}${histTxt} — the fast line pulled above its signal line. Short-term momentum is now outrunning the longer-term trend, which often marks the start of an upward leg.`;
        if (lower.includes('crossunder') || (m?.crossunder)) return `MACD just crossed bearish for ${sym}${histTxt} — the fast line dropped below its signal line. Short-term selling is overtaking buying; this frequently precedes further downside.`;
        if (lower.includes('positive momentum')) return `MACD histogram is positive for ${sym}${histTxt} and the line sits above zero — the uptrend has real momentum behind it, so the trend is more likely to continue than reverse.`;
        if (lower.includes('negative momentum')) return `MACD histogram is negative for ${sym}${histTxt} with the line below zero — selling momentum is building and bounces are getting weaker, a bearish short-term posture.`;
        if (lower.includes('turning positive')) return `MACD histogram is just turning positive for ${sym}${histTxt} — an early, not-yet-confirmed hint that downside momentum is easing. Watch for a full line-over-signal cross to confirm.`;
        if (lower.includes('weakening')) return `MACD histogram is weakening for ${sym}${histTxt} — upward momentum is fading even if price hasn't turned yet. An early caution flag, not a reversal on its own.`;
    }

    // ── Bollinger Bands ──────────────────────────────────────────────────
    if (lower.includes('bollinger')) {
        const b = has('bb') ? snap.bb : null;
        if (lower.includes('lower')) {
            if (b) return `${sym} is trading at or below its lower Bollinger Band (${px(b.lower)}${b.percentB != null ? `, %B ${b.percentB}` : ''}) — roughly 2 standard deviations under its 20-day mean of ${px(b.middle)}. Statistically stretched to the downside; a reversion back toward the middle band is the higher-probability outcome.`;
            return `${sym}'s price has broken below its lower Bollinger Band — about 2σ under its 20-day average. Mean reversion back toward the middle band is the most probable path.`;
        }
        if (lower.includes('upper')) {
            if (b) return `${sym} is trading at or above its upper Bollinger Band (${px(b.upper)}${b.percentB != null ? `, %B ${b.percentB}` : ''}) — roughly 2 standard deviations over its 20-day mean of ${px(b.middle)}. Extended territory; breakouts can run, but the odds of reverting toward the mean are elevated.`;
            return `${sym} is at or above its upper Bollinger Band — about 2σ over its 20-day average. The move is extended and reversion risk is elevated.`;
        }
    }

    // ── MA crossovers / trend ────────────────────────────────────────────
    if (lower.includes('golden cross') || (lower.includes('ma') && lower.includes('crossed above'))) return `Short-term MA crossed above the longer-term MA for ${sym} — a "golden cross". Recent price action is now stronger than the prevailing trend, a bullish structural shift.`;
    if (lower.includes('death cross') || (lower.includes('ma') && lower.includes('crossed below'))) return `Short-term MA crossed below the longer-term MA for ${sym} — a "death cross". The short-term trend has turned down, a bearish structural shift that often leads to more downside.`;
    if (lower.includes('trending upward') || lower.includes('bullish trend')) {
        const adxTxt = has('adx') ? ` ADX is ${snap.adx} (${snap.adx > 25 ? 'a confirmed trend' : snap.adx < 20 ? 'weak — more chop than trend' : 'borderline'}).` : '';
        return `${sym} is in an uptrend — short-term MA above long-term MA.${adxTxt} In trending tape, pullbacks to the moving average tend to be buying opportunities rather than reversals.`;
    }
    if (lower.includes('trending downward') || lower.includes('bearish trend')) {
        const adxTxt = has('adx') ? ` ADX is ${snap.adx} (${snap.adx > 25 ? 'a confirmed trend' : snap.adx < 20 ? 'weak — more chop than trend' : 'borderline'}).` : '';
        return `${sym} is in a downtrend — short-term MA below long-term MA.${adxTxt} Bounces inside a downtrend tend to be short-lived; trading against it carries higher risk.`;
    }

    // ── Volume ───────────────────────────────────────────────────────────
    if (lower.includes('volume') && lower.includes('spike')) {
        if (has('volRatio')) return `Volume is running <strong>${snap.volRatio}×</strong> its average for ${sym}. Heavy volume validates the move — on up moves it means buyers are committed, on down moves it means institutions are distributing. Either way the price action carries more weight than on thin volume.`;
        return `Volume is well above average for ${sym}, validating the current move — high-volume moves are more trustworthy than thin-volume ones.`;
    }

    // ── Momentum ─────────────────────────────────────────────────────────
    if (lower.includes('momentum') && lower.includes('upward')) {
        if (has('momentumPct')) return `${sym} is up <strong>${snap.momentumPct >= 0 ? '+' : ''}${snap.momentumPct}%</strong> over the last 5 periods — strong positive momentum. Momentum tends to persist short-term before exhausting, so this favors continuation in the near term.`;
        return `Strong positive 5-period momentum for ${sym} — it tends to persist short-term before exhausting.`;
    }
    if (lower.includes('momentum') && lower.includes('downward')) {
        if (has('momentumPct')) return `${sym} is down <strong>${snap.momentumPct}%</strong> over the last 5 periods — strong negative momentum. Persistent selling is hard to reverse quickly without a fresh catalyst.`;
        return `Strong negative 5-period momentum for ${sym} — persistent selling that's hard to reverse without a catalyst.`;
    }

    // ── Multi-timeframe ──────────────────────────────────────────────────
    if (lower.includes('all timeframes align')) return `Daily, weekly, and 4-hour timeframes all agree on direction for ${sym} — the engine's highest-confidence technical setup. When every timeframe confirms, the odds of the move following through are at their peak.`;
    if (lower.includes('conflict') || lower.includes('disagree')) return `Timeframes disagree for ${sym} — short-term and longer-term trends point different ways. That means higher uncertainty; consider a smaller position or waiting for alignment.`;

    // No textbook match → null, caller surfaces the raw (already specific) reason.
    return null;
}
