// Technical Analysis & Prediction Engine
// Indicators: RSI, MACD, Bollinger Bands, MA Crossovers, Volume, ATR

// ─── INDICATOR CALCULATIONS ──────────────────────────────────────────────────

export function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;

    const emaFast = calculateEMA(closes, fast);
    const emaSlow = calculateEMA(closes, slow);

    if (!emaFast || !emaSlow) return null;

    const macdLine = [];
    const startIdx = slow - 1;
    for (let i = startIdx; i < closes.length; i++) {
        const fastIdx = i - (fast - 1);
        const slowIdx = i - (slow - 1);
        if (fastIdx >= 0 && slowIdx >= 0 && fastIdx < emaFast.length && slowIdx < emaSlow.length) {
            macdLine.push(emaFast[fastIdx] - emaSlow[slowIdx]);
        }
    }

    if (macdLine.length < signal) return null;

    const signalLine = calculateEMAFromValues(macdLine, signal);
    if (!signalLine || signalLine.length === 0) return null;

    const lastMACD = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];
    const prevMACD = macdLine[macdLine.length - 2];
    const prevSignal = signalLine.length > 1 ? signalLine[signalLine.length - 2] : lastSignal;
    const histogram = lastMACD - lastSignal;

    return {
        macd: lastMACD,
        signal: lastSignal,
        histogram,
        crossover: prevMACD <= prevSignal && lastMACD > lastSignal,
        crossunder: prevMACD >= prevSignal && lastMACD < lastSignal,
    };
}

export function calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;

    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const std = Math.sqrt(variance);

    const upper = sma + stdDev * std;
    const lower = sma - stdDev * std;
    const currentPrice = closes[closes.length - 1];
    const percentB = (currentPrice - lower) / (upper - lower);

    return { upper, middle: sma, lower, percentB, bandwidth: (upper - lower) / sma };
}

export function calculateSMA(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

export function calculateEMA(values, period) {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    const ema = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];

    for (let i = period; i < values.length; i++) {
        ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
}

function calculateEMAFromValues(values, period) {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    const ema = [values.slice(0, period).reduce((a, b) => a + b, 0) / period];

    for (let i = period; i < values.length; i++) {
        ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
}

export function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
    }
    return atr;
}

export function detectVolumeSpike(volumes, threshold = 1.5) {
    if (volumes.length < 21) return { spike: false, ratio: 1 };
    const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const ratio = currentVolume / avgVolume;
    return { spike: ratio > threshold, ratio };
}

// ─── MOVING AVERAGE CROSSOVER ────────────────────────────────────────────────

export function calculateMACrossover(closes, shortPeriod = 9, longPeriod = 21) {
    const shortMA = calculateSMA(closes, shortPeriod);
    const longMA = calculateSMA(closes, longPeriod);

    if (!shortMA || !longMA) return null;

    const prevShort = calculateSMA(closes.slice(0, -1), shortPeriod);
    const prevLong = calculateSMA(closes.slice(0, -1), longPeriod);

    if (!prevShort || !prevLong) return null;

    return {
        shortMA,
        longMA,
        bullishCross: prevShort <= prevLong && shortMA > longMA,
        bearishCross: prevShort >= prevLong && shortMA < longMA,
        bullish: shortMA > longMA,
    };
}

// ─── PREDICTION ENGINE ───────────────────────────────────────────────────────

export function generatePrediction(candles, timeframe = 'today') {
    if (!candles || candles.length < 30) {
        return { signal: 'NEUTRAL', confidence: 0, reasons: ['Insufficient data for analysis'] };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume).filter(v => v > 0);

    // Calculate all indicators
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const maCross = calculateMACrossover(closes);
    const volumeData = detectVolumeSpike(volumes);
    const atr = calculateATR(candles);

    // Score system: each indicator contributes a weighted vote
    let bullScore = 0;
    let bearScore = 0;
    let totalWeight = 0;
    const reasons = [];

    // RSI Analysis (weight: 2)
    if (rsi !== null) {
        totalWeight += 2;
        if (rsi < 30) {
            bullScore += 2;
            reasons.push(`RSI oversold at ${rsi.toFixed(1)} — reversal likely`);
        } else if (rsi < 40) {
            bullScore += 1;
            reasons.push(`RSI approaching oversold (${rsi.toFixed(1)})`);
        } else if (rsi > 70) {
            bearScore += 2;
            reasons.push(`RSI overbought at ${rsi.toFixed(1)} — pullback likely`);
        } else if (rsi > 60) {
            bearScore += 1;
            reasons.push(`RSI elevated (${rsi.toFixed(1)})`);
        } else {
            reasons.push(`RSI neutral at ${rsi.toFixed(1)}`);
        }
    }

    // MACD Analysis (weight: 2.5)
    if (macd) {
        totalWeight += 2.5;
        if (macd.crossover) {
            bullScore += 2.5;
            reasons.push('MACD bullish crossover — strong buy signal');
        } else if (macd.crossunder) {
            bearScore += 2.5;
            reasons.push('MACD bearish crossunder — strong sell signal');
        } else if (macd.histogram > 0 && macd.macd > 0) {
            bullScore += 1.5;
            reasons.push('MACD positive momentum');
        } else if (macd.histogram < 0 && macd.macd < 0) {
            bearScore += 1.5;
            reasons.push('MACD negative momentum');
        } else if (macd.histogram > 0) {
            bullScore += 0.5;
            reasons.push('MACD histogram turning positive');
        } else {
            bearScore += 0.5;
            reasons.push('MACD histogram weakening');
        }
    }

    // Bollinger Bands (weight: 2)
    if (bb) {
        totalWeight += 2;
        if (bb.percentB < 0) {
            bullScore += 2;
            reasons.push('Price below lower Bollinger Band — mean reversion expected');
        } else if (bb.percentB < 0.2) {
            bullScore += 1.5;
            reasons.push(`Price near lower band (${(bb.percentB * 100).toFixed(0)}%B)`);
        } else if (bb.percentB > 1) {
            bearScore += 2;
            reasons.push('Price above upper Bollinger Band — overextended');
        } else if (bb.percentB > 0.8) {
            bearScore += 1.5;
            reasons.push(`Price near upper band (${(bb.percentB * 100).toFixed(0)}%B)`);
        }
    }

    // MA Crossover (weight: 2)
    if (maCross) {
        totalWeight += 2;
        if (maCross.bullishCross) {
            bullScore += 2;
            reasons.push('Golden cross — 9 MA crossed above 21 MA');
        } else if (maCross.bearishCross) {
            bearScore += 2;
            reasons.push('Death cross — 9 MA crossed below 21 MA');
        } else if (maCross.bullish) {
            bullScore += 1;
            reasons.push('Short MA above long MA — bullish trend');
        } else {
            bearScore += 1;
            reasons.push('Short MA below long MA — bearish trend');
        }
    }

    // Volume Confirmation (weight: 1.5)
    if (volumeData && volumes.length > 20) {
        totalWeight += 1.5;
        if (volumeData.spike) {
            const priceUp = closes[closes.length - 1] > closes[closes.length - 2];
            if (priceUp) {
                bullScore += 1.5;
                reasons.push(`Volume spike (${volumeData.ratio.toFixed(1)}x avg) confirms upward move`);
            } else {
                bearScore += 1.5;
                reasons.push(`Volume spike (${volumeData.ratio.toFixed(1)}x avg) confirms selling pressure`);
            }
        }
    }

    // Price momentum (weight: 1)
    totalWeight += 1;
    const recentCloses = closes.slice(-5);
    const momentum = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0] * 100;
    if (momentum > 2) {
        bullScore += 1;
        reasons.push(`Strong upward momentum (+${momentum.toFixed(1)}% over 5 periods)`);
    } else if (momentum < -2) {
        bearScore += 1;
        reasons.push(`Strong downward momentum (${momentum.toFixed(1)}% over 5 periods)`);
    }

    // Calculate final signal
    const netScore = bullScore - bearScore;
    const maxPossible = totalWeight;
    const normalizedScore = netScore / maxPossible; // -1 to +1

    // Convert to confidence (42% to 88% range)
    // Use a curve that rewards strong signals more
    const absNorm = Math.abs(normalizedScore);
    const absConfidence = Math.min(88, 42 + absNorm * 35 + Math.pow(absNorm, 0.7) * 15);

    let signal;
    if (normalizedScore > 0.12) signal = 'BUY';
    else if (normalizedScore < -0.12) signal = 'SELL';
    else signal = 'NEUTRAL';

    // Tomorrow adjustment: slightly reduce confidence for next-day predictions
    const confidenceMultiplier = timeframe === 'tomorrow' ? 0.92 : 1;
    const finalConfidence = Math.round(absConfidence * confidenceMultiplier);

    return {
        signal,
        confidence: finalConfidence,
        reasons: reasons.filter(r => !r.includes('neutral')).slice(0, 5),
        indicators: { rsi, macd, bb, maCross, volumeData, atr, momentum },
        scores: { bull: bullScore, bear: bearScore, net: netScore, normalized: normalizedScore },
    };
}

// ─── MULTI-TIMEFRAME CONFLUENCE ──────────────────────────────────────────────

export function generateMultiTimeframePrediction(multiData, timeframe = 'today') {
    const dailyPred = generatePrediction(multiData.daily.candles, timeframe);
    const weeklyPred = generatePrediction(multiData.weekly.candles, timeframe);
    const fourHourPred = generatePrediction(multiData.fourHour.candles, timeframe);

    // Confluence scoring — daily is primary, others confirm or warn
    const signals = [dailyPred, weeklyPred, fourHourPred];
    const weights = [0.50, 0.25, 0.25]; // Daily dominates

    let weightedBull = 0;
    let weightedBear = 0;

    signals.forEach((pred, i) => {
        if (pred.signal === 'BUY') weightedBull += weights[i];
        else if (pred.signal === 'SELL') weightedBear += weights[i];
    });

    // Confluence bonus: if all timeframes agree, boost confidence
    const allAgree = signals.every(s => s.signal === signals[0].signal) && signals[0].signal !== 'NEUTRAL';
    const twoAgree = (signals[0].signal === signals[1].signal || signals[0].signal === signals[2].signal) && signals[0].signal !== 'NEUTRAL';
    const confluenceBonus = allAgree ? 10 : twoAgree ? 4 : 0;

    // Conflict penalty: only when daily and weekly ACTIVELY disagree (BUY vs SELL)
    // Neutral doesn't count as conflict — it just means unclear
    const dailyBuy = dailyPred.signal === 'BUY';
    const dailySell = dailyPred.signal === 'SELL';
    const weeklyBuy = weeklyPred.signal === 'BUY';
    const weeklySell = weeklyPred.signal === 'SELL';
    const hardConflict = (dailyBuy && weeklySell) || (dailySell && weeklyBuy);
    const conflictPenalty = hardConflict ? 8 : 0;

    // Determine signal — daily gets tie-breaking power
    let finalSignal;
    if (weightedBull > weightedBear + 0.05) finalSignal = 'BUY';
    else if (weightedBear > weightedBull + 0.05) finalSignal = 'SELL';
    else finalSignal = dailyPred.signal; // Daily breaks ties

    // Weighted average confidence — use the stronger of daily vs combined
    const combinedConfidence = signals.reduce((sum, pred, i) => sum + pred.confidence * weights[i], 0);
    // Don't let multi-timeframe reduce below what daily alone shows
    let baseConfidence = Math.max(combinedConfidence, dailyPred.confidence * 0.9);
    baseConfidence = Math.round(baseConfidence + confluenceBonus - conflictPenalty);
    baseConfidence = Math.max(38, Math.min(88, baseConfidence));

    // Combine reasons from all timeframes (prioritize daily)
    const allReasons = [
        ...dailyPred.reasons.map(r => `[Daily] ${r}`),
        ...weeklyPred.reasons.slice(0, 2).map(r => `[Weekly] ${r}`),
        ...fourHourPred.reasons.slice(0, 1).map(r => `[4H] ${r}`),
    ];

    if (allAgree) allReasons.unshift(`All timeframes align ${finalSignal} — high confluence`);
    if (hardConflict) allReasons.unshift('Daily vs Weekly conflict — proceed with caution');

    // Calculate price targets
    const priceTargets = calculatePriceTargets(multiData.daily.candles, finalSignal, baseConfidence, timeframe);

    return {
        signal: finalSignal,
        confidence: baseConfidence,
        reasons: allReasons.slice(0, 6),
        breakdown: {
            daily: dailyPred,
            weekly: weeklyPred,
            fourHour: fourHourPred,
        },
        meta: { confluenceBonus, conflictPenalty, allAgree },
        priceTargets,
    };
}

// ─── PRICE TARGET PREDICTION ─────────────────────────────────────────────────

export function calculatePriceTargets(candles, signal, confidence, timeframe = 'today') {
    if (!candles || candles.length < 20) return null;

    const currentPrice = candles[candles.length - 1].close;
    const atr = calculateATR(candles, 14);
    if (!atr) return null;

    // Calculate recent support/resistance levels
    const recent = candles.slice(-20);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const recentHigh = Math.max(...highs);
    const recentLow = Math.min(...lows);

    // Bollinger Bands for price envelope
    const closes = candles.map(c => c.close);
    const bb = calculateBollingerBands(closes, 20, 2);

    // ATR-based movement expectation
    // Today: expect ~0.7-1.0x ATR movement (intraday)
    // Tomorrow: expect ~1.0-1.5x ATR movement (next full day)
    const atrMultiplier = timeframe === 'today' ? 0.8 : 1.2;
    const expectedMove = atr * atrMultiplier;

    // Confidence adjusts how aggressively we project
    const confidenceFactor = confidence / 100; // 0.35 to 0.88

    // Calculate predicted high and low
    let predictedHigh, predictedLow;

    if (signal === 'BUY') {
        // Bullish: higher upside, limited downside
        predictedHigh = currentPrice + (expectedMove * (0.8 + confidenceFactor * 0.7));
        predictedLow = currentPrice - (expectedMove * (0.3 + (1 - confidenceFactor) * 0.3));
    } else if (signal === 'SELL') {
        // Bearish: limited upside, higher downside
        predictedHigh = currentPrice + (expectedMove * (0.3 + (1 - confidenceFactor) * 0.3));
        predictedLow = currentPrice - (expectedMove * (0.8 + confidenceFactor * 0.7));
    } else {
        // Neutral: symmetric range
        predictedHigh = currentPrice + (expectedMove * 0.6);
        predictedLow = currentPrice - (expectedMove * 0.6);
    }

    // Constrain within reasonable bounds using support/resistance
    if (bb) {
        // Don't predict beyond 1.5x Bollinger Band width from current price
        const maxUp = currentPrice + (bb.upper - bb.middle) * 2;
        const maxDown = currentPrice - (bb.middle - bb.lower) * 2;
        predictedHigh = Math.min(predictedHigh, maxUp);
        predictedLow = Math.max(predictedLow, maxDown);
    }

    // Use support/resistance as soft caps
    if (predictedHigh > recentHigh * 1.05) {
        predictedHigh = recentHigh + (predictedHigh - recentHigh) * 0.5;
    }
    if (predictedLow < recentLow * 0.95) {
        predictedLow = recentLow - (recentLow - predictedLow) * 0.5;
    }

    // Calculate percentage moves
    const highPct = ((predictedHigh - currentPrice) / currentPrice) * 100;
    const lowPct = ((predictedLow - currentPrice) / currentPrice) * 100;

    return {
        currentPrice,
        predictedHigh: +predictedHigh.toFixed(2),
        predictedLow: +predictedLow.toFixed(2),
        highPercent: +highPct.toFixed(2),
        lowPercent: +lowPct.toFixed(2),
        expectedMove: +expectedMove.toFixed(2),
        atr: +atr.toFixed(2),
        support: +recentLow.toFixed(2),
        resistance: +recentHigh.toFixed(2),
        timeframe,
    };
}
