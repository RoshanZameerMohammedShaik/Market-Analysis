// Technical Analysis & Prediction Engine
// Indicators: RSI, MACD, Bollinger Bands, MA Crossovers, Volume, ATR, ADX, MFI
// + Divergence detection (bullish/bearish across RSI/MACD/OBV)
// + Failed-breakout / failed-breakdown reversal pattern
// + Volume-confirmed weighting (real-trader truth: setups on thin volume
//   are statistically much weaker; setups on confirming volume much stronger)

import { detectDivergences } from './divergence.js';
import { detectFailedBreak } from './failed-break.js';

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

export function calculateADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return null;
    const len = candles.length;
    const tr = new Array(len).fill(0);
    const plusDM = new Array(len).fill(0);
    const minusDM = new Array(len).fill(0);
    for (let i = 1; i < len; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevHigh = candles[i - 1].high;
        const prevLow = candles[i - 1].low;
        const prevClose = candles[i - 1].close;
        tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        const upMove = high - prevHigh;
        const downMove = prevLow - low;
        plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
        minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    }
    let smTR = 0, smPlusDM = 0, smMinusDM = 0;
    for (let i = 1; i <= period; i++) {
        smTR += tr[i];
        smPlusDM += plusDM[i];
        smMinusDM += minusDM[i];
    }
    const dxValues = [];
    for (let i = period + 1; i < len; i++) {
        smTR = smTR - smTR / period + tr[i];
        smPlusDM = smPlusDM - smPlusDM / period + plusDM[i];
        smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];
        const plusDI = smTR === 0 ? 0 : 100 * smPlusDM / smTR;
        const minusDI = smTR === 0 ? 0 : 100 * smMinusDM / smTR;
        const sumDI = plusDI + minusDI;
        const dx = sumDI === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sumDI;
        dxValues.push(dx);
    }
    if (dxValues.length < period) return null;
    let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxValues.length; i++) {
        adx = (adx * (period - 1) + dxValues[i]) / period;
    }
    return adx;
}

export function calculateMFI(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const len = candles.length;
    const tp = candles.map(c => (c.high + c.low + c.close) / 3);
    let posFlow = 0, negFlow = 0;
    const start = Math.max(1, len - period);
    for (let i = start; i < len; i++) {
        const moneyFlow = tp[i] * (candles[i].volume || 0);
        if (tp[i] > tp[i - 1]) posFlow += moneyFlow;
        else if (tp[i] < tp[i - 1]) negFlow += moneyFlow;
    }
    if (negFlow === 0) return 100;
    const ratio = posFlow / negFlow;
    return 100 - (100 / (1 + ratio));
}

export function calculateMACrossover(closes, shortPeriod = 9, longPeriod = 21) {
    const shortMA = calculateSMA(closes, shortPeriod);
    const longMA = calculateSMA(closes, longPeriod);
    if (!shortMA || !longMA) return null;
    const prevShort = calculateSMA(closes.slice(0, -1), shortPeriod);
    const prevLong = calculateSMA(closes.slice(0, -1), longPeriod);
    if (!prevShort || !prevLong) return null;
    return {
        shortMA, longMA,
        bullishCross: prevShort <= prevLong && shortMA > longMA,
        bearishCross: prevShort >= prevLong && shortMA < longMA,
        bullish: shortMA > longMA,
    };
}

export function generatePrediction(candles, timeframe = 'today') {
    if (!candles || candles.length < 30) {
        return { signal: 'NEUTRAL', confidence: 0, reasons: ['Insufficient data for analysis'] };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume).filter(v => v > 0);

    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const maCross = calculateMACrossover(closes);
    const volumeData = detectVolumeSpike(volumes);
    const atr = calculateATR(candles);
    const adx = calculateADX(candles);
    const mfi = volumes.length >= 15 ? calculateMFI(candles) : null;

    // NEW: divergences and failed-break detection.
    const divs = detectDivergences(candles);
    const failedBreak = detectFailedBreak(candles);

    const trendRegime = adx === null ? 'unknown' : adx > 25 ? 'trending' : adx < 20 ? 'ranging' : 'transitional';
    const trendWeightBonus = trendRegime === 'trending' ? 1.3 : 1.0;
    const meanReversionBonus = trendRegime === 'ranging' ? 1.3 : 1.0;

    // Volume-confirmation factor: applied to MACD/MA-cross/RSI-extreme weights.
    // Real-trader truth: a directional setup without volume backing is much weaker.
    const volRatio = volumeData?.ratio || 1;
    const volumeConfirmedFactor = volRatio > 1.4 ? 1.30 : volRatio < 0.7 ? 0.75 : 1.0;

    let bullScore = 0;
    let bearScore = 0;
    let totalWeight = 0;
    const reasons = [];

    if (rsi !== null) {
        const w = 2 * meanReversionBonus * volumeConfirmedFactor;
        totalWeight += w;
        if (rsi < 30) { bullScore += w; reasons.push(`RSI oversold at ${rsi.toFixed(1)} — reversal likely`); }
        else if (rsi < 40) { bullScore += w * 0.5; reasons.push(`RSI approaching oversold (${rsi.toFixed(1)})`); }
        else if (rsi > 70) { bearScore += w; reasons.push(`RSI overbought at ${rsi.toFixed(1)} — pullback likely`); }
        else if (rsi > 60) { bearScore += w * 0.5; reasons.push(`RSI elevated (${rsi.toFixed(1)})`); }
        else { reasons.push(`RSI neutral at ${rsi.toFixed(1)}`); }
    }

    if (macd) {
        const w = 2.5 * trendWeightBonus * volumeConfirmedFactor;
        totalWeight += w;
        if (macd.crossover) { bullScore += w; reasons.push(`MACD bullish crossover — strong buy signal${volumeConfirmedFactor > 1 ? ' (volume confirmed)' : volumeConfirmedFactor < 1 ? ' (thin volume — caution)' : ''}`); }
        else if (macd.crossunder) { bearScore += w; reasons.push(`MACD bearish crossunder — strong sell signal${volumeConfirmedFactor > 1 ? ' (volume confirmed)' : ''}`); }
        else if (macd.histogram > 0 && macd.macd > 0) { bullScore += w * 0.6; reasons.push('MACD positive momentum'); }
        else if (macd.histogram < 0 && macd.macd < 0) { bearScore += w * 0.6; reasons.push('MACD negative momentum'); }
        else if (macd.histogram > 0) { bullScore += w * 0.2; reasons.push('MACD histogram turning positive'); }
        else { bearScore += w * 0.2; reasons.push('MACD histogram weakening'); }
    }

    if (bb) {
        const w = 2 * meanReversionBonus;
        totalWeight += w;
        if (bb.percentB < 0) { bullScore += w; reasons.push('Price below lower Bollinger Band — mean reversion expected'); }
        else if (bb.percentB < 0.2) { bullScore += w * 0.75; reasons.push(`Price near lower band (${(bb.percentB * 100).toFixed(0)}%B)`); }
        else if (bb.percentB > 1) { bearScore += w; reasons.push('Price above upper Bollinger Band — overextended'); }
        else if (bb.percentB > 0.8) { bearScore += w * 0.75; reasons.push(`Price near upper band (${(bb.percentB * 100).toFixed(0)}%B)`); }
    }

    if (maCross) {
        const w = 2 * trendWeightBonus * volumeConfirmedFactor;
        totalWeight += w;
        if (maCross.bullishCross) { bullScore += w; reasons.push(`Golden cross — 9 MA crossed above 21 MA${volumeConfirmedFactor > 1 ? ' (volume confirmed)' : ''}`); }
        else if (maCross.bearishCross) { bearScore += w; reasons.push(`Death cross — 9 MA crossed below 21 MA${volumeConfirmedFactor > 1 ? ' (volume confirmed)' : ''}`); }
        else if (maCross.bullish) { bullScore += w * 0.5; reasons.push('Short MA above long MA — bullish trend'); }
        else { bearScore += w * 0.5; reasons.push('Short MA below long MA — bearish trend'); }
    }

    if (volumeData && volumes.length > 20) {
        totalWeight += 1.5;
        if (volumeData.spike) {
            const priceUp = closes[closes.length - 1] > closes[closes.length - 2];
            if (priceUp) { bullScore += 1.5; reasons.push(`Volume spike (${volumeData.ratio.toFixed(1)}x avg) confirms upward move`); }
            else { bearScore += 1.5; reasons.push(`Volume spike (${volumeData.ratio.toFixed(1)}x avg) confirms selling pressure`); }
        }
    }

    if (adx !== null && adx > 25) {
        totalWeight += 1.5;
        if (bullScore > bearScore) { bullScore += 1.5; reasons.push(`ADX ${adx.toFixed(1)} — strong trend in motion`); }
        else if (bearScore > bullScore) { bearScore += 1.5; reasons.push(`ADX ${adx.toFixed(1)} — strong trend in motion`); }
    } else if (adx !== null && adx < 20) {
        reasons.push(`ADX ${adx.toFixed(1)} — ranging market, breakouts often fail`);
    }

    if (mfi !== null) {
        totalWeight += 1.5;
        if (mfi < 20) { bullScore += 1.5; reasons.push(`MFI ${mfi.toFixed(1)} — oversold with weak money flow, bounce likely`); }
        else if (mfi < 30) { bullScore += 0.75; reasons.push(`MFI ${mfi.toFixed(1)} — approaching oversold money flow`); }
        else if (mfi > 80) { bearScore += 1.5; reasons.push(`MFI ${mfi.toFixed(1)} — overbought, money flow exhausted`); }
        else if (mfi > 70) { bearScore += 0.75; reasons.push(`MFI ${mfi.toFixed(1)} — elevated money flow`); }
    }

    // NEW: divergence vector.
    if (divs.bullish) {
        const w = 2 * divs.bullish.strength;
        totalWeight += w;
        bullScore += w;
        reasons.push(divs.bullish.reason);
    }
    if (divs.bearish) {
        const w = 2 * divs.bearish.strength;
        totalWeight += w;
        bearScore += w;
        reasons.push(divs.bearish.reason);
    }

    // NEW: failed-break vector.
    if (failedBreak) {
        const w = 2.2 * failedBreak.strength;
        totalWeight += w;
        if (failedBreak.direction === 'bullish') bullScore += w;
        else bearScore += w;
        reasons.push(failedBreak.reason);
    }

    totalWeight += 1;
    const recentCloses = closes.slice(-5);
    const momentum = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0] * 100;
    if (momentum > 2) { bullScore += 1; reasons.push(`Strong upward momentum (+${momentum.toFixed(1)}% over 5 periods)`); }
    else if (momentum < -2) { bearScore += 1; reasons.push(`Strong downward momentum (${momentum.toFixed(1)}% over 5 periods)`); }

    const netScore = bullScore - bearScore;
    const maxPossible = totalWeight;
    const normalizedScore = netScore / maxPossible;
    const absNorm = Math.abs(normalizedScore);
    const absConfidence = Math.min(88, 42 + absNorm * 35 + Math.pow(absNorm, 0.7) * 15);

    let signal;
    if (normalizedScore > 0.12) signal = 'BUY';
    else if (normalizedScore < -0.12) signal = 'SELL';
    else signal = 'NEUTRAL';

    const confidenceMultiplier = timeframe === 'tomorrow' ? 0.92 : 1;
    const finalConfidence = Math.round(absConfidence * confidenceMultiplier);

    return {
        signal,
        confidence: finalConfidence,
        reasons: reasons.filter(r => !r.includes('neutral')).slice(0, 7),
        indicators: { rsi, macd, bb, maCross, volumeData, atr, adx, mfi, momentum, trendRegime, divergences: divs, failedBreak, volumeConfirmedFactor },
        scores: { bull: bullScore, bear: bearScore, net: netScore, normalized: normalizedScore },
    };
}

export function generateMultiTimeframePrediction(multiData, timeframe = 'today') {
    const dailyPred = generatePrediction(multiData.daily.candles, timeframe);
    const weeklyPred = generatePrediction(multiData.weekly.candles, timeframe);
    const fourHourPred = generatePrediction(multiData.fourHour.candles, timeframe);

    const signals = [dailyPred, weeklyPred, fourHourPred];
    const weights = [0.50, 0.25, 0.25];

    let weightedBull = 0;
    let weightedBear = 0;
    signals.forEach((pred, i) => {
        if (pred.signal === 'BUY') weightedBull += weights[i];
        else if (pred.signal === 'SELL') weightedBear += weights[i];
    });

    const allAgree = signals.every(s => s.signal === signals[0].signal) && signals[0].signal !== 'NEUTRAL';
    const twoAgree = (signals[0].signal === signals[1].signal || signals[0].signal === signals[2].signal) && signals[0].signal !== 'NEUTRAL';
    const confluenceBonus = allAgree ? 10 : twoAgree ? 4 : 0;

    const dailyBuy = dailyPred.signal === 'BUY';
    const dailySell = dailyPred.signal === 'SELL';
    const weeklyBuy = weeklyPred.signal === 'BUY';
    const weeklySell = weeklyPred.signal === 'SELL';
    const hardConflict = (dailyBuy && weeklySell) || (dailySell && weeklyBuy);
    const conflictPenalty = hardConflict ? 8 : 0;

    let finalSignal;
    if (weightedBull > weightedBear + 0.05) finalSignal = 'BUY';
    else if (weightedBear > weightedBull + 0.05) finalSignal = 'SELL';
    else finalSignal = dailyPred.signal;

    const combinedConfidence = signals.reduce((sum, pred, i) => sum + pred.confidence * weights[i], 0);
    let baseConfidence = Math.max(combinedConfidence, dailyPred.confidence * 0.9);
    baseConfidence = Math.round(baseConfidence + confluenceBonus - conflictPenalty);
    baseConfidence = Math.max(38, Math.min(88, baseConfidence));

    const allReasons = [
        ...dailyPred.reasons.map(r => `[Daily] ${r}`),
        ...weeklyPred.reasons.slice(0, 2).map(r => `[Weekly] ${r}`),
        ...fourHourPred.reasons.slice(0, 1).map(r => `[4H] ${r}`),
    ];
    if (allAgree) allReasons.unshift(`All timeframes align ${finalSignal} — high confluence`);
    if (hardConflict) allReasons.unshift('Daily vs Weekly conflict — proceed with caution');

    const priceTargets = calculatePriceTargets(multiData.daily.candles, finalSignal, baseConfidence, timeframe);

    return {
        signal: finalSignal,
        confidence: baseConfidence,
        reasons: allReasons.slice(0, 7),
        breakdown: { daily: dailyPred, weekly: weeklyPred, fourHour: fourHourPred },
        meta: { confluenceBonus, conflictPenalty, allAgree, trendRegime: dailyPred.indicators?.trendRegime },
        priceTargets,
    };
}

export function calculatePriceTargets(candles, signal, confidence, timeframe = 'today') {
    if (!candles || candles.length < 20) return null;
    const currentPrice = candles[candles.length - 1].close;
    const atr = calculateATR(candles, 14);
    if (!atr) return null;
    const recent = candles.slice(-20);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const recentHigh = Math.max(...highs);
    const recentLow = Math.min(...lows);
    const closes = candles.map(c => c.close);
    const bb = calculateBollingerBands(closes, 20, 2);
    const atrMultiplier = timeframe === 'today' ? 0.8 : 1.2;
    const expectedMove = atr * atrMultiplier;
    const confidenceFactor = confidence / 100;
    let predictedHigh, predictedLow;
    if (signal === 'BUY') {
        predictedHigh = currentPrice + (expectedMove * (0.8 + confidenceFactor * 0.7));
        predictedLow = currentPrice - (expectedMove * (0.3 + (1 - confidenceFactor) * 0.3));
    } else if (signal === 'SELL') {
        predictedHigh = currentPrice + (expectedMove * (0.3 + (1 - confidenceFactor) * 0.3));
        predictedLow = currentPrice - (expectedMove * (0.8 + confidenceFactor * 0.7));
    } else {
        predictedHigh = currentPrice + (expectedMove * 0.6);
        predictedLow = currentPrice - (expectedMove * 0.6);
    }
    if (bb) {
        const maxUp = currentPrice + (bb.upper - bb.middle) * 2;
        const maxDown = currentPrice - (bb.middle - bb.lower) * 2;
        predictedHigh = Math.min(predictedHigh, maxUp);
        predictedLow = Math.max(predictedLow, maxDown);
    }
    if (predictedHigh > recentHigh * 1.05) predictedHigh = recentHigh + (predictedHigh - recentHigh) * 0.5;
    if (predictedLow < recentLow * 0.95) predictedLow = recentLow - (recentLow - predictedLow) * 0.5;
    const highPct = ((predictedHigh - currentPrice) / currentPrice) * 100;
    const lowPct = ((predictedLow - currentPrice) / currentPrice) * 100;

    // Probable band — narrower target zone biased toward the predicted
    // direction. Possible band shows what's plausible (ATR × ~1); probable
    // band shows what's likely (ATR × ~0.3, asymmetric toward the call).
    // Widens slightly when confidence is low; tightens when high.
    const probableInner = 0.18 + (1 - confidenceFactor) * 0.18;  // 0.18 .. 0.36
    const probableOuter = 0.45 + (1 - confidenceFactor) * 0.20;  // 0.45 .. 0.65
    let probableHigh, probableLow;
    if (signal === 'BUY') {
        probableHigh = currentPrice + expectedMove * probableOuter;
        probableLow = currentPrice - expectedMove * probableInner;
    } else if (signal === 'SELL') {
        probableHigh = currentPrice + expectedMove * probableInner;
        probableLow = currentPrice - expectedMove * probableOuter;
    } else {
        probableHigh = currentPrice + expectedMove * 0.30;
        probableLow = currentPrice - expectedMove * 0.30;
    }
    // Probable band must always sit inside the possible band.
    probableHigh = Math.min(probableHigh, predictedHigh);
    probableLow = Math.max(probableLow, predictedLow);
    const probableHighPct = ((probableHigh - currentPrice) / currentPrice) * 100;
    const probableLowPct = ((probableLow - currentPrice) / currentPrice) * 100;

    return {
        currentPrice,
        predictedHigh: +predictedHigh.toFixed(2),
        predictedLow: +predictedLow.toFixed(2),
        highPercent: +highPct.toFixed(2),
        lowPercent: +lowPct.toFixed(2),
        probableHigh: +probableHigh.toFixed(2),
        probableLow: +probableLow.toFixed(2),
        probableHighPercent: +probableHighPct.toFixed(2),
        probableLowPercent: +probableLowPct.toFixed(2),
        expectedMove: +expectedMove.toFixed(2),
        atr: +atr.toFixed(2),
        support: +recentLow.toFixed(2),
        resistance: +recentHigh.toFixed(2),
        timeframe,
    };
}
