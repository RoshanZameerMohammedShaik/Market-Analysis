// Weighted Confidence Engine — blends 4 sources, applies disagreement
// penalty, sector-relative adjustment, earnings cap, regime bias, then
// calibrates against backtested empirical hit rate.

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { calibrate, getCalibrationStatus } from './calibration.js';
import { getMacroRegime, regimeBias } from './regime.js';
import { getSectorAdjustment } from './sectors.js';
import { getEarningsProximity, earningsCap } from './earnings.js';

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe) {
    const [aiResult, newsItems, marketResult] = await Promise.allSettled([
        getAIPrediction(multiData.daily.candles),
        mode === 'stock' ? fetchStockNews(symbolOrCoinId).catch(() => []) : fetchCryptoNews(symbolOrCoinId).catch(() => []),
        getMarketConditionsScore(mode),
    ]);

    const technicalPred = generateMultiTimeframePrediction(multiData, timeframe);
    const technicalScore = convertSignalToScore(technicalPred.signal, technicalPred.confidence);

    const ai = aiResult.status === 'fulfilled' ? aiResult.value : { score: 50, available: false };
    const news = newsItems.status === 'fulfilled' ? newsItems.value : [];
    const sentiment = await analyzeNewsSentiment(news);
    const market = marketResult.status === 'fulfilled' ? marketResult.value : { score: 50, reasons: [] };

    let weights;
    if (ai.available) weights = { ai: 0.15, technical: 0.35, sentiment: 0.25, market: 0.25 };
    else weights = { ai: 0, technical: 0.40, sentiment: 0.30, market: 0.30 };

    const weightedScore = ai.score * weights.ai + technicalScore * weights.technical + sentiment.score * weights.sentiment + market.score * weights.market;

    let finalSignal;
    if (weightedScore > 56) finalSignal = 'BUY';
    else if (weightedScore < 44) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    const deviation = Math.abs(weightedScore - 50) / 50;
    let rawConfidence = Math.round(38 + deviation * 50);

    // Disagreement penalty.
    const sourceScores = [technicalScore, sentiment.score, market.score];
    if (ai.available) sourceScores.push(ai.score);
    const minScore = Math.min(...sourceScores);
    const maxScore = Math.max(...sourceScores);
    const dispersion = maxScore - minScore;
    let disagreementPenalty = 0;
    if (dispersion > 50) disagreementPenalty = 12;
    else if (dispersion > 35) disagreementPenalty = 7;
    else if (dispersion > 25) disagreementPenalty = 3;
    rawConfidence = Math.max(38, rawConfidence - disagreementPenalty);

    // —— NEW: macro regime bias ——
    let regime = null;
    let regimePen = 0;
    if (mode === 'stock') {
        try {
            regime = await getMacroRegime();
            const bias = regimeBias(regime?.regime);
            regimePen = bias.pen || 0;
            rawConfidence = Math.max(38, rawConfidence - regimePen);
        } catch (_) { /* */ }
    }

    // —— NEW: sector-relative adjustment ——
    let sectorAdj = 0;
    let sectorMeta = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try {
            const r = await getSectorAdjustment(symbolOrCoinId, finalSignal);
            sectorAdj = r.adjust;
            sectorMeta = r.sector;
            rawConfidence = Math.max(38, Math.min(88, rawConfidence + sectorAdj));
        } catch (_) { /* */ }
    }

    // —— NEW: earnings proximity cap ——
    let earnings = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try {
            earnings = await getEarningsProximity(symbolOrCoinId);
            const { cap, reason } = earningsCap(earnings?.daysUntil);
            if (cap < rawConfidence) rawConfidence = cap;
            earnings = { ...earnings, capReason: reason };
        } catch (_) { /* */ }
    }

    const calibratedConfidence = calibrate(rawConfidence);
    const calibrationApplied = getCalibrationStatus() === 'loaded';

    // —— NEW: confidence range (point + interval) ——
    // Width grows with dispersion + regime uncertainty + (earnings if soon).
    let widthBase = 4;
    widthBase += Math.min(8, dispersion / 6);
    if (regime?.regime === 'transition') widthBase += 2;
    if (regime?.regime === 'risk-off') widthBase += 1;
    if (earnings?.daysUntil != null && earnings.daysUntil <= 5) widthBase += 3;
    const halfWidth = Math.round(widthBase / 2);
    const lo = Math.max(38, calibratedConfidence - halfWidth);
    const hi = Math.min(88, calibratedConfidence + halfWidth);
    const confidenceRange = (hi - lo) >= 4 ? { lo, hi } : null;

    const allReasons = [];
    if (ai.available) allReasons.push(`[AI Model] ${ai.reason}`);
    technicalPred.reasons.slice(0, 3).forEach(r => allReasons.push(r));
    sentiment.reasons.forEach(r => allReasons.push(`[Sentiment] ${r}`));
    market.reasons.slice(0, 2).forEach(r => allReasons.push(`[Market] ${r}`));
    if (regime?.regime && regime.regime !== 'neutral') allReasons.push(`[Macro] Market regime: ${regime.regime}`);
    if (sectorMeta && sectorAdj !== 0) {
        const dir = sectorMeta.rising ? 'rising' : sectorMeta.falling ? 'falling' : 'flat';
        allReasons.push(`[Sector] ${sectorMeta.name} sector ${dir} (${sectorMeta.pct5d?.toFixed(1)}% 5d) — ${sectorAdj > 0 ? 'aligned' : 'conflicting'}`);
    }
    if (earnings?.capReason) allReasons.push(`[Earnings] ${earnings.capReason}`);
    if (disagreementPenalty > 0) allReasons.push(`[Engine] Sources disagree (range ${dispersion.toFixed(0)} pts) — confidence reduced by ${disagreementPenalty}`);

    return {
        signal: finalSignal,
        confidence: calibratedConfidence,
        confidenceRange,
        rawConfidence,
        calibrationApplied,
        disagreementPenalty,
        dispersion: Math.round(dispersion),
        regime: regime?.regime,
        sector: sectorMeta,
        earnings,
        reasons: allReasons.slice(0, 10),
        priceTargets: technicalPred.priceTargets,
        breakdown: {
            ai: { score: ai.score, available: ai.available, weight: weights.ai * 100 },
            technical: { score: technicalScore, weight: weights.technical * 100 },
            sentiment: { score: sentiment.score, weight: weights.sentiment * 100 },
            market: { score: market.score, weight: weights.market * 100 },
        },
        news: sentiment.items || news.map(n => ({ title: n.title, date: n.date, source: n.source, sentiment: { label: 'neutral', score: 0 } })),
        newsOverall: sentiment.overall,
        newsSummary: sentiment.reasons[0] || 'No news data',
        marketConditions: market,
        method: ai.available ? '4-source (AI + Technical + Sentiment + Market) + macro/sector/earnings' : '3-source + macro/sector/earnings',
        trendRegime: technicalPred.meta?.trendRegime || 'unknown',
    };
}

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}
