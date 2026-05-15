// Weighted Confidence Engine — blends 4 sources, applies disagreement
// penalty, sector-relative adjustment, earnings cap, calendar cap, regime
// bias, peer confirmation, crypto derivs, then calibrates against backtested
// empirical hit rate.
//
// computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe, opts)
//   opts.bulkScan: true skips the heavier per-symbol fetches (peer confirmation)
//                  used by Hot Picks / Spikers scanners to avoid latency.

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { calibrate, classifyTier, classifyVolTier, getCalibrationStatus } from './calibration.js';
import { loadConformal, getInterval } from './conformal.js';
import { getMacroRegime, regimeBias } from './regime.js';
import { getSectorAdjustment } from './sectors.js';
import { getEarningsProximity, earningsCap } from './earnings.js';
import { calendarCap } from './calendar-events.js';
import { fetchCryptoDerivs, derivsAdjustment } from './crypto-derivs.js';
import { getPeerAgreement, peerAdjustment } from './peer-confirmation.js';

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe, opts = {}) {
    const { bulkScan = false } = opts;
    loadConformal();

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

    let regime = null;
    if (mode === 'stock') {
        try { regime = await getMacroRegime(); } catch (_) { /* */ }
    }
    const trendRegime = technicalPred.meta?.trendRegime || 'unknown';
    const currentVix = regime?.components?.vix?.level;
    const volTier = classifyVolTier(currentVix);

    let weights = ai.available
        ? { ai: 0.15, technical: 0.35, sentiment: 0.25, market: 0.25 }
        : { ai: 0,    technical: 0.40, sentiment: 0.30, market: 0.30 };
    weights = applyRegimeWeighting(weights, regime?.regime, trendRegime);

    const weightedScore = ai.score * weights.ai + technicalScore * weights.technical + sentiment.score * weights.sentiment + market.score * weights.market;

    let finalSignal;
    if (weightedScore > 56) finalSignal = 'BUY';
    else if (weightedScore < 44) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    const deviation = Math.abs(weightedScore - 50) / 50;
    let rawConfidence = Math.round(38 + deviation * 50);

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

    let regimePen = 0;
    if (regime) {
        const bias = regimeBias(regime.regime);
        regimePen = bias.pen || 0;
        rawConfidence = Math.max(38, rawConfidence - regimePen);
    }

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

    let earnings = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try {
            earnings = await getEarningsProximity(symbolOrCoinId);
            const { cap, reason } = earningsCap(earnings?.daysUntil);
            if (cap < rawConfidence) rawConfidence = cap;
            earnings = { ...earnings, capReason: reason };
        } catch (_) { /* */ }
    }

    let calendar = null;
    if (mode === 'stock') {
        const cc = calendarCap(new Date());
        if (cc.cap < rawConfidence) {
            rawConfidence = cc.cap;
            calendar = cc;
        }
    }

    // Crypto derivatives positioning (Binance public). Only on user-initiated
    // analyses, not bulk scans — bulk scans add too much latency.
    let derivs = null;
    let derivsResult = null;
    if (mode === 'crypto' && !bulkScan && symbolOrCoinId) {
        try {
            derivs = await fetchCryptoDerivs(symbolOrCoinId);
            if (derivs) {
                const priceChange1d = computePriceChange1d(multiData);
                derivsResult = derivsAdjustment(finalSignal, derivs, priceChange1d);
                rawConfidence = Math.max(38, Math.min(88, rawConfidence + (derivsResult.adjust || 0)));
            }
        } catch (_) { /* */ }
    }

    // Peer confirmation for stocks (single-symbol only, not bulk).
    let peerResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try {
            const peer = await getPeerAgreement(symbolOrCoinId, finalSignal);
            if (peer) {
                peerResult = peerAdjustment(finalSignal, peer);
                if (peerResult.adjust) {
                    rawConfidence = Math.max(38, Math.min(88, rawConfidence + peerResult.adjust));
                }
                peerResult.peer = peer;
            }
        } catch (_) { /* */ }
    }

    const tier = computeTier(multiData);
    const calibratedConfidence = calibrate(rawConfidence, { tier, volTier });
    const calibrationApplied = getCalibrationStatus() === 'loaded';

    const ci = getInterval(finalSignal, calibratedConfidence);

    let widthBase = 4;
    widthBase += Math.min(8, dispersion / 6);
    if (regime?.regime === 'transition') widthBase += 2;
    if (regime?.regime === 'risk-off') widthBase += 1;
    if (earnings?.daysUntil != null && earnings.daysUntil <= 5) widthBase += 3;
    if (calendar) widthBase += 3;
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
    if (peerResult?.reason) allReasons.push(`[Peers] ${peerResult.reason}`);
    if (earnings?.capReason) allReasons.push(`[Earnings] ${earnings.capReason}`);
    if (calendar?.reason) allReasons.push(`[Calendar] ${calendar.reason}`);
    if (derivsResult?.reasons?.length) {
        derivsResult.reasons.forEach(r => allReasons.push(`[Derivs] ${r}`));
    }
    if (disagreementPenalty > 0) allReasons.push(`[Engine] Sources disagree (range ${dispersion.toFixed(0)} pts) — confidence reduced by ${disagreementPenalty}`);

    return {
        signal: finalSignal,
        confidence: calibratedConfidence,
        confidenceRange,
        confidenceInterval: ci,
        rawConfidence,
        calibrationApplied,
        liquidityTier: tier,
        volTier,
        disagreementPenalty,
        dispersion: Math.round(dispersion),
        regime: regime?.regime,
        sector: sectorMeta,
        earnings,
        calendar,
        derivs: derivs ? { ...derivs, ...derivsResult } : null,
        peers: peerResult || null,
        reasons: allReasons.slice(0, 12),
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
        method: ai.available ? '4-source + macro/sector/earnings/calendar/peers/derivs + tier+vol-calibrated' : '3-source + macro/sector/earnings/calendar/peers/derivs + tier+vol-calibrated',
        trendRegime,
    };
}

function convertSignalToScore(signal, confidence) {
    if (signal === 'BUY') return 50 + (confidence - 38) * (50 / 50);
    if (signal === 'SELL') return 50 - (confidence - 38) * (50 / 50);
    return 50;
}

function computeTier(multiData) {
    try {
        const candles = multiData?.daily?.candles || [];
        if (candles.length < 5) return null;
        const recent = candles.slice(-21);
        const sumVol = recent.reduce((s, c) => s + (c.volume || 0), 0);
        const avgVol = sumVol / recent.length;
        const price = multiData?.daily?.currentPrice || candles[candles.length - 1]?.close;
        if (!price) return null;
        return classifyTier(price, avgVol);
    } catch (_) {
        return null;
    }
}

function computePriceChange1d(multiData) {
    const candles = multiData?.daily?.candles || [];
    if (candles.length < 2) return 0;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!last || !prev || !prev.close) return 0;
    return ((last.close - prev.close) / prev.close) * 100;
}

function applyRegimeWeighting(base, macroRegime, trendRegime) {
    const out = { ...base };
    let techShift = 0, sentShift = 0, mktShift = 0;

    if (trendRegime === 'trending') { techShift += 0.05; sentShift -= 0.025; mktShift -= 0.025; }
    else if (trendRegime === 'ranging') { techShift -= 0.05; sentShift += 0.025; mktShift += 0.025; }

    if (macroRegime === 'risk-off') { sentShift -= 0.05; techShift += 0.025; mktShift += 0.025; }
    else if (macroRegime === 'risk-on') { sentShift += 0.025; mktShift += 0.025; techShift -= 0.05; }

    techShift = Math.max(-0.10, Math.min(0.10, techShift));
    sentShift = Math.max(-0.10, Math.min(0.10, sentShift));
    mktShift  = Math.max(-0.10, Math.min(0.10, mktShift));

    out.technical = Math.max(0.10, base.technical + techShift);
    out.sentiment = Math.max(0.10, base.sentiment + sentShift);
    out.market    = Math.max(0.10, base.market    + mktShift);

    const sum = out.ai + out.technical + out.sentiment + out.market;
    if (sum > 0) {
        out.ai /= sum; out.technical /= sum; out.sentiment /= sum; out.market /= sum;
    }
    return out;
}
