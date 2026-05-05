// Weighted Confidence Engine — blends 4 analysis sources
// AI Model (30%) + Technicals (25%) + Sentiment (25%) + Market Conditions (20%)

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';

// ─── MAIN CONFIDENCE ENGINE ──────────────────────────────────────────────────

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe) {
    // Run all 4 analysis sources in parallel
    const [aiResult, newsItems, marketResult] = await Promise.allSettled([
        getAIPrediction(multiData.daily.candles),
        mode === 'stock'
            ? fetchStockNews(symbolOrCoinId).catch(() => [])
            : fetchCryptoNews(symbolOrCoinId).catch(() => []),
        getMarketConditionsScore(mode),
    ]);

    // 1. Technical Analysis (already computed via generateMultiTimeframePrediction)
    const technicalPred = generateMultiTimeframePrediction(multiData, timeframe);
    const technicalScore = convertSignalToScore(technicalPred.signal, technicalPred.confidence);

    // 2. AI Model
    const ai = aiResult.status === 'fulfilled' ? aiResult.value : { score: 50, available: false };

    // 3. News Sentiment (HuggingFace NLP)
    const news = newsItems.status === 'fulfilled' ? newsItems.value : [];
    const sentiment = await analyzeNewsSentiment(news);

    // 4. Market Conditions
    const market = marketResult.status === 'fulfilled' ? marketResult.value : { score: 50, reasons: [] };

    // ─── WEIGHTED BLEND ──────────────────────────────────────────────────────

    // Weights adjust if AI model isn't available
    let weights;
    // Weights: Technical leads (real indicators), then market conditions (VIX, Fear/Greed),
    // then sentiment (news NLP), then AI model (pattern recognition supplement)
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

    // Convert 0-100 score to signal + confidence
    let finalSignal;
    if (weightedScore > 56) finalSignal = 'BUY';
    else if (weightedScore < 44) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    // Confidence: how strongly the sources agree on direction
    // Ranges from 38 (all sources at 50 = total uncertainty) to 88 (all sources strongly agree)
    const deviation = Math.abs(weightedScore - 50) / 50; // 0 to 1
    const confidence = Math.round(38 + deviation * 50); // 38 to 88

    // Compile reasons from all sources
    const allReasons = [];

    if (ai.available) {
        allReasons.push(`[AI Model] ${ai.reason}`);
    }

    technicalPred.reasons.slice(0, 3).forEach(r => allReasons.push(r));

    sentiment.reasons.forEach(r => allReasons.push(`[Sentiment] ${r}`));

    market.reasons.slice(0, 2).forEach(r => allReasons.push(`[Market] ${r}`));

    return {
        signal: finalSignal,
        confidence,
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function convertSignalToScore(signal, confidence) {
    // Convert BUY/SELL/NEUTRAL + confidence to 0-100 bullish score
    if (signal === 'BUY') {
        return 50 + (confidence - 38) * (50 / 50); // 50-100
    } else if (signal === 'SELL') {
        return 50 - (confidence - 38) * (50 / 50); // 0-50
    }
    return 50; // NEUTRAL
}
