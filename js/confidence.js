// Weighted Confidence Engine — blends 4 analysis sources, then calibrates
// the result against backtested empirical hit rate.
//
// Composition: AI (15-30%) + Technicals (35-40%) + Sentiment (25-30%) +
// Market (25-30%). Output passes through calibrate() so the displayed
// number reflects historical accuracy, not raw heuristic strength.

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
    const rawConfidence = Math.round(38 + deviation * 50); // 38-88 heuristic
    const calibratedConfidence = calibrate(rawConfidence);
    const calibrationApplied = getCalibrationStatus() === 'loaded';

    const allReasons = [];
    if (ai.available) allReasons.push(`[AI Model] ${ai.reason}`);
    technicalPred.reasons.slice(0, 3).forEach(r => allReasons.push(r));
    sentiment.reasons.forEach(r => allReasons.push(`[Sentiment] ${r}`));
    market.reasons.slice(0, 2).forEach(r => allReasons.push(`[Market] ${r}`));

    return {
        signal: finalSignal,
        confidence: calibratedConfidence,
        rawConfidence,
        calibrationApplied,
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
    };
}

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
