// Weighted Confidence Engine — blends 4 analysis sources, applies
// disagreement penalty, then calibrates against backtested hit rate.

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { calibrate, getCalibrationStatus } from './calibration.js';

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe) {
    const [aiResult, newsItems, marketResult] = await Promise.allSettled([
        getAIPrediction(multiData.daily.candles),
        mode === 'stock'
            ? fetchStockNews(symbolOrCoinId).catch(() => [])
            : fetchCryptoNews(symbolOrCoinId).catch(() => []),
        getMarketConditionsScore(mode),
    ]);

    const technicalPred = generateMultiTimeframePrediction(multiData, timeframe);
    const technicalScore = convertSignalToScore(technicalPred.signal, technicalPred.confidence);

    const ai = aiResult.status === 'fulfilled' ? aiResult.value : { score: 50, available: false };
    const news = newsItems.status === 'fulfilled' ? newsItems.value : [];
    const sentiment = await analyzeNewsSentiment(news);
    const market = marketResult.status === 'fulfilled' ? marketResult.value : { score: 50, reasons: [] };

    let weights;
    if (ai.available) {
        weights = { ai: 0.15, technical: 0.35, sentiment: 0.25, market: 0.25 };
    } else {
        weights = { ai: 0, technical: 0.40, sentiment: 0.30, market: 0.30 };
    }

    const weightedScore = (
        ai.score * weights.ai +
        technicalScore * weights.technical +
        sentiment.score * weights.sentiment +
        market.score * weights.market
    );

    let finalSignal;
    if (weightedScore > 56) finalSignal = 'BUY';
    else if (weightedScore < 44) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    const deviation = Math.abs(weightedScore - 50) / 50;
    let rawConfidence = Math.round(38 + deviation * 50);

    // Disagreement penalty: when sources span a wide range, that's real
    // information about uncertainty. We can't show high confidence when
    // our own components are voting in different directions.
    const sourceScores = [technicalScore, sentiment.score, market.score];
    if (ai.available) sourceScores.push(ai.score);
    const minScore = Math.min(...sourceScores);
    const maxScore = Math.max(...sourceScores);
    const dispersion = maxScore - minScore;
    let disagreementPenalty = 0;
    if (dispersion > 50) disagreementPenalty = 12;       // sources span > half the scale
    else if (dispersion > 35) disagreementPenalty = 7;
    else if (dispersion > 25) disagreementPenalty = 3;
    rawConfidence = Math.max(38, rawConfidence - disagreementPenalty);

    const calibratedConfidence = calibrate(rawConfidence);
    const calibrationApplied = getCalibrationStatus() === 'loaded';

    const allReasons = [];
    if (ai.available) allReasons.push(`[AI Model] ${ai.reason}`);
    technicalPred.reasons.slice(0, 3).forEach(r => allReasons.push(r));
    sentiment.reasons.forEach(r => allReasons.push(`[Sentiment] ${r}`));
    market.reasons.slice(0, 2).forEach(r => allReasons.push(`[Market] ${r}`));
    if (disagreementPenalty > 0) {
        allReasons.push(`[Engine] Sources disagree (range ${dispersion.toFixed(0)} pts) — confidence reduced by ${disagreementPenalty}`);
    }

    return {
        signal: finalSignal,
        confidence: calibratedConfidence,
        rawConfidence,
        calibrationApplied,
        disagreementPenalty,
        dispersion: Math.round(dispersion),
        reasons: allReasons.slice(0, 8),
        priceTargets: technicalPred.priceTargets,
        breakdown: {
            ai: { score: ai.score, available: ai.available, weight: weights.ai * 100 },
            technical: { score: technicalScore, weight: weights.technical * 100 },
            sentiment: { score: sentiment.score, weight: weights.sentiment * 100 },
            market: { score: market.score, weight: weights.market * 100 },
        },
        news: sentiment.items || news.map(n => ({
            title: n.title, date: n.date, source: n.source,
            sentiment: { label: 'neutral', score: 0 },
        })),
        newsOverall: sentiment.overall,
        newsSummary: sentiment.reasons[0] || 'No news data',
        marketConditions: market,
        method: ai.available ? '4-source (AI + Technical + Sentiment + Market)' : '3-source (Technical + Sentiment + Market)',
        trendRegime: technicalPred.meta?.trendRegime || 'unknown',
    };
}

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
