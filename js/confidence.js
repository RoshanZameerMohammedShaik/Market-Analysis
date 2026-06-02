// Weighted Confidence Engine. Phase 8 wires tier='penny' through to ai-model
// so penny stocks use the dedicated penny-LSTM (with main-LSTM fallback when
// penny weights aren't yet trained).

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction, calculateATR, summarizeAttribution } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { calibrate, classifyTier, classifyVolTier, getCalibrationStatus, getHorizonCalibrations, regionFor } from './calibration.js';
import { loadConformal, getInterval } from './conformal.js';
import { getMacroRegime, regimeBias } from './regime.js';
import { getSectorAdjustment } from './sectors.js';
import { getYieldAdjustment } from './yields.js';
import { getEarningsProximity, earningsCap } from './earnings.js';
import { calendarCap } from './calendar-events.js';
import { fetchCryptoDerivs, derivsAdjustment } from './crypto-derivs.js';
import { getPeerAgreement, peerAdjustment } from './peer-confirmation.js';
import { attributionShifts } from './source-attribution.js';
import { loadPatterns, encodePattern, patternAdjustment } from './pattern-lookup.js';
import { fetchOptionsPositioning, optionsAdjustment } from './options-iv.js';
import { detectSqueeze, squeezeAdjustment } from './squeeze-detector.js';
import { timeframeAgreement, timeframeAgreementAdjustment } from './timeframe-agreement.js';
import { predictMultiHorizon } from './multi-horizon.js';
import { computeVwapClassifier, vwapAdjustment } from './vwap.js';
import { getSectorRotation, rotationAdjustment } from './sector-rotation.js';
import { computeVolumeProfile, volumeProfileAdjustment } from './volume-profile.js';
import { getCrossAsset, crossAssetAdjustment } from './cross-asset.js';
import { detectGap, gapCap } from './premarket-gap.js';
import { findRecentSpike, recentSpikeCap } from './recent-spike.js';
import { getEarningsReactionHistory, earningsHistoryCap } from './earnings-history.js';
import { getPennyTierData, pennyTierAdjustment } from './penny-tier.js';
import { getFinraShort, finraShortAdjustment } from './finra-short.js';
import { getOpenInsider, openInsiderAdjustment } from './openinsider.js';
import { getSocialVelocity, socialVelocityAdjustment } from './social-velocity.js';
import { readLedgerHistory } from './ledger-reader.js';
import { getLearnedWeights } from './source-weights.js';

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe, opts = {}) {
    const { bulkScan = false } = opts;
    loadConformal();
    loadPatterns();

    // Compute tier first so we can pass it to the AI model.
    const tier = computeTier(multiData);

    const [aiResult, newsItems, marketResult] = await Promise.allSettled([
        getAIPrediction(multiData.daily.candles, { tier }),
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
        try { regime = await getMacroRegime(); } catch (_) {}
    }
    const trendRegime = technicalPred.meta?.trendRegime || 'unknown';
    const currentVix = regime?.components?.vix?.level;
    const volTier = classifyVolTier(currentVix);

    // Source weights are LEARNED from the live ledger every 30 min
    // (see js/source-weights.js). Each source's per-prediction
    // directional accuracy → normalized weight. Replaces the old
    // hardcoded 0.15/0.35/0.25/0.25 split that violated the
    // dynamic-only rule. Falls back to baseline only while the
    // ledger is too thin (< 50 resolved rows with breakdown data).
    let weights = await getLearnedWeights(ai.available);
    weights = applyWeightShifts(weights, regime?.regime, trendRegime, attributionShifts());

    const weightedScore = ai.score * weights.ai + technicalScore * weights.technical + sentiment.score * weights.sentiment + market.score * weights.market;

    // Tighter BUY/SELL bands. Earlier 56/44 thresholds let half-
    // hearted calls slip through with calibrated confidence in the
    // 38–50 range, which the user reads as "BUY at low conviction"
    // — exactly what Roshan pushed back on. Now 60/40 with a hard
    // 55%-confidence floor: anything weaker becomes NEUTRAL (which
    // surfaces as "DON'T BUY" in the UI). Engine commits less
    // often, but each commit is meaningful.
    // Calibration floor was 38, ceiling 88. The 38–50 band is mostly
    // coin-flips that the engine already won't commit on (we filter
    // BUY/SELL by score AND >=55 threshold below). Raising the
    // displayed floor to 50 doesn't change accuracy — it just maps
    // the score to the part of the scale where commitments actually
    // happen. "60% confidence" stops being a rare ceiling and
    // becomes the routine commit threshold that matches our prompt
    // language. Range now 50–88.
    const deviation = Math.abs(weightedScore - 50) / 50;
    let rawConfidence = Math.round(50 + deviation * 38);

    let finalSignal;
    if (weightedScore > 60 && rawConfidence >= 55) finalSignal = 'BUY';
    else if (weightedScore < 40 && rawConfidence >= 55) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    const sourceScores = [technicalScore, sentiment.score, market.score];
    if (ai.available) sourceScores.push(ai.score);
    const dispersion = Math.max(...sourceScores) - Math.min(...sourceScores);
    let disagreementPenalty = 0;
    if (dispersion > 50) disagreementPenalty = 12;
    else if (dispersion > 35) disagreementPenalty = 7;
    else if (dispersion > 25) disagreementPenalty = 3;
    rawConfidence = Math.max(50, rawConfidence - disagreementPenalty);

    // Unanimous-agreement bonus. When all available weighted sources
    // (AI / Technical / Sentiment / Market) agree DIRECTIONALLY on
    // the call (all >55 for BUY, all <45 for SELL), confidence gets
    // +5 points (capped at 88). The engine's 4 sources rarely all
    // agree; when they do, that's the strongest signal we can detect
    // and it deserves a confidence boost. Honest because the boost
    // is gated on real source agreement, not math inflation. Skip
    // for NEUTRAL — by definition there's no direction to agree on.
    let unanimousBonus = 0;
    if (finalSignal === 'BUY' || finalSignal === 'SELL') {
        const all = [technicalScore, sentiment.score, market.score];
        if (ai.available) all.push(ai.score);
        const direction = finalSignal === 'BUY' ? 'up' : 'down';
        const allAgree = direction === 'up'
            ? all.every(s => s > 55)
            : all.every(s => s < 45);
        if (allAgree) {
            unanimousBonus = 5;
            rawConfidence = Math.min(88, rawConfidence + unanimousBonus);
        }
    }

    // Per-symbol live-ledger track-record bonus. If the engine has
    // a meaningful number of resolved predictions on THIS exact
    // symbol (>=5) AND its 1d hit rate on this symbol is above the
    // engine-wide average, we have evidence the engine reads this
    // particular name well — boost up to +5pts. If the symbol's
    // track record is BELOW average, dock up to -3pts. Skipped on
    // bulkScan to keep Hot Picks scan fast (the ledger fetch is
    // small but adds up across 60 symbols). Skipped for crypto
    // because the ledger is stock-only today.
    let trackRecord = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId && (finalSignal === 'BUY' || finalSignal === 'SELL')) {
        try {
            const lh = await readLedgerHistory({ symbol: symbolOrCoinId, limit: 50 });
            if (lh?.available && lh.resolved1d >= 5) {
                const symHitRate = lh.hitRate1dPct;
                // Engine-wide baseline ~50% on the live ledger
                // (slightly above coin-flip per the calibration audit).
                // Anything >60% is meaningfully above; >70% is strong.
                let trAdj = 0;
                if (symHitRate >= 70) trAdj = 5;
                else if (symHitRate >= 60) trAdj = 3;
                else if (symHitRate < 40) trAdj = -3;
                if (trAdj !== 0) {
                    rawConfidence = Math.max(50, Math.min(88, rawConfidence + trAdj));
                }
                trackRecord = {
                    resolvedN: lh.resolved1d,
                    hitRatePct: symHitRate,
                    adjust: trAdj,
                    reason: trAdj > 0
                        ? `Engine has ${symHitRate}% hit rate on ${symbolOrCoinId} over ${lh.resolved1d} resolved calls — track-record bonus`
                        : trAdj < 0
                            ? `Engine has only ${symHitRate}% hit rate on ${symbolOrCoinId} over ${lh.resolved1d} resolved calls — track-record penalty`
                            : null,
                };
            }
        } catch (_) {}
    }

    let regimePen = 0;
    if (regime) { regimePen = regimeBias(regime.regime).pen || 0; rawConfidence = Math.max(50, rawConfidence - regimePen); }

    let sectorAdj = 0, sectorMeta = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try { const r = await getSectorAdjustment(symbolOrCoinId, finalSignal); sectorAdj = r.adjust; sectorMeta = r.sector; rawConfidence = Math.max(50, Math.min(88, rawConfidence + sectorAdj)); } catch (_) {}
    }

    // 10-year yield context. Long-duration / rate-sensitive sectors get
    // headwind/tailwind from yield trajectory; banks get the opposite.
    // Bounded ±3pts. Only stocks (crypto isn't directly rate-sensitive).
    let yieldResult = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try {
            yieldResult = await getYieldAdjustment(symbolOrCoinId, finalSignal);
            if (yieldResult?.adjust) {
                rawConfidence = Math.max(50, Math.min(88, rawConfidence + yieldResult.adjust));
            }
        } catch (_) {}
    }

    let earnings = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try { earnings = await getEarningsProximity(symbolOrCoinId); const { cap, reason } = earningsCap(earnings?.daysUntil); if (cap < rawConfidence) rawConfidence = cap; earnings = { ...earnings, capReason: reason }; } catch (_) {}
    }
    let calendar = null;
    if (mode === 'stock') { const cc = calendarCap(new Date()); if (cc.cap < rawConfidence) { rawConfidence = cc.cap; calendar = cc; } }

    let derivs = null, derivsResult = null;
    if (mode === 'crypto' && !bulkScan && symbolOrCoinId) {
        try { derivs = await fetchCryptoDerivs(symbolOrCoinId); if (derivs) { const priceChange1d = computePriceChange1d(multiData); derivsResult = derivsAdjustment(finalSignal, derivs, priceChange1d); rawConfidence = Math.max(50, Math.min(88, rawConfidence + (derivsResult.adjust || 0))); } } catch (_) {}
    }

    let peerResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { const peer = await getPeerAgreement(symbolOrCoinId, finalSignal); if (peer) { peerResult = peerAdjustment(finalSignal, peer); if (peerResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + peerResult.adjust)); peerResult.peer = peer; } } catch (_) {}
    }

    let options = null, optionsResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { options = await fetchOptionsPositioning(symbolOrCoinId); if (options) { optionsResult = optionsAdjustment(finalSignal, options); rawConfidence = Math.max(50, Math.min(88, rawConfidence + (optionsResult.adjust || 0))); } } catch (_) {}
    }

    let squeeze = null, squeezeResult = null;
    try { const closes = (multiData?.daily?.candles || []).map(c => c.close); squeeze = detectSqueeze(closes); if (squeeze) { squeezeResult = squeezeAdjustment(finalSignal, squeeze); if (squeezeResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + squeezeResult.adjust)); } } catch (_) {}

    let tfAgreement = null, tfResult = null;
    if (technicalPred.breakdown) { tfAgreement = timeframeAgreement(finalSignal, technicalPred.breakdown); if (tfAgreement) { tfResult = timeframeAgreementAdjustment(finalSignal, tfAgreement); if (tfResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + tfResult.adjust)); } }

    let vwap = null, vwapResult = null;
    try { vwap = computeVwapClassifier(multiData?.daily?.candles || []); if (vwap) { vwapResult = vwapAdjustment(finalSignal, vwap); if (vwapResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + vwapResult.adjust)); } } catch (_) {}

    let rotation = null, rotationResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { rotation = await getSectorRotation(symbolOrCoinId); if (rotation) { rotationResult = rotationAdjustment(finalSignal, rotation); if (rotationResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + rotationResult.adjust)); } } catch (_) {}
    }

    let volProfile = null, volProfileResult = null;
    try { volProfile = computeVolumeProfile(multiData?.daily?.candles || []); if (volProfile) { volProfileResult = volumeProfileAdjustment(finalSignal, volProfile, vwap?.volumeTrend); if (volProfileResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + volProfileResult.adjust)); } } catch (_) {}

    let crossAsset = null, crossAssetResult = null;
    if (!bulkScan && symbolOrCoinId) {
        try { crossAsset = await getCrossAsset(mode, symbolOrCoinId); if (crossAsset) { crossAssetResult = crossAssetAdjustment(finalSignal, crossAsset); if (crossAssetResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + crossAssetResult.adjust)); } } catch (_) {}
    }

    let gap = null;
    if (mode === 'stock') { try { gap = detectGap(multiData); const gc = gapCap(gap); if (gc.cap < rawConfidence) { rawConfidence = gc.cap; gap = { ...gap, capReason: gc.reason }; } } catch (_) {} }

    let recentSpike = null;
    try { recentSpike = findRecentSpike(multiData?.daily?.candles || []); if (recentSpike) { const rsc = recentSpikeCap(recentSpike); if (rsc.cap < rawConfidence) { rawConfidence = rsc.cap; recentSpike = { ...recentSpike, capReason: rsc.reason }; } } } catch (_) {}

    let earningsHistory = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId && earnings?.daysUntil != null) {
        try { earningsHistory = await getEarningsReactionHistory(symbolOrCoinId, multiData?.daily?.candles || []); if (earningsHistory) { const ehc = earningsHistoryCap(earningsHistory, earnings.daysUntil, finalSignal); if (ehc.cap < rawConfidence) { rawConfidence = ehc.cap; earningsHistory = { ...earningsHistory, capReason: ehc.reason }; } } } catch (_) {}
    }

    const priceChange1d = computePriceChange1d(multiData);

    let penny = null, pennyResult = null;
    if (mode === 'stock' && tier === 'penny' && !bulkScan && symbolOrCoinId) {
        try {
            penny = await getPennyTierData(symbolOrCoinId);
            if (penny) {
                pennyResult = pennyTierAdjustment(finalSignal, penny, tier);
                if (pennyResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + pennyResult.adjust));
                if (pennyResult.cap < rawConfidence) rawConfidence = pennyResult.cap;
            }
        } catch (_) {}
    }

    let finraShort = null, finraResult = null;
    if (mode === 'stock' && tier === 'penny' && !bulkScan && symbolOrCoinId) {
        try {
            finraShort = await getFinraShort(symbolOrCoinId);
            if (finraShort) {
                finraResult = finraShortAdjustment(finalSignal, finraShort, tier, priceChange1d);
                if (finraResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + finraResult.adjust));
            }
        } catch (_) {}
    }

    let insider = null, insiderResult = null;
    if (mode === 'stock' && tier === 'penny' && !bulkScan && symbolOrCoinId) {
        try {
            insider = await getOpenInsider(symbolOrCoinId);
            if (insider) {
                insiderResult = openInsiderAdjustment(finalSignal, insider, tier);
                if (insiderResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + insiderResult.adjust));
            }
        } catch (_) {}
    }

    let socialVel = null, socialResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try {
            socialVel = await getSocialVelocity(symbolOrCoinId);
            if (socialVel) {
                socialResult = socialVelocityAdjustment(finalSignal, socialVel);
                if (socialResult.adjust) rawConfidence = Math.max(50, Math.min(88, rawConfidence + socialResult.adjust));
            }
        } catch (_) {}
    }

    let patternResult = null;
    if (technicalPred.indicators) {
        const patternKey = encodePattern({ signal: finalSignal, indicators: technicalPred.indicators, tier });
        const adj = patternAdjustment(patternKey);
        if (adj.cap != null && adj.cap < rawConfidence) { rawConfidence = adj.cap; patternResult = adj; }
        else if (adj.adjust) { rawConfidence = Math.max(50, Math.min(88, rawConfidence + adj.adjust)); patternResult = adj; }
    }

    const region = regionFor(symbolOrCoinId);
    const calibratedConfidence = calibrate(rawConfidence, { tier, volTier, region });
    const calibrationApplied = getCalibrationStatus() === 'loaded';
    const ci = getInterval(finalSignal, calibratedConfidence);

    let multiHorizon = null;
    try {
        const closes = (multiData?.daily?.candles || []).map(c => c.close);
        const candles = multiData?.daily?.candles || [];
        const atrV = calculateATR ? calculateATR(candles) : null;
        const currentPrice = multiData?.daily?.currentPrice || closes[closes.length - 1];
        if (atrV && currentPrice) {
            multiHorizon = predictMultiHorizon({ signal: finalSignal, confidence: calibratedConfidence, atr: atrV, currentPrice, volTier, conformal1d: ci });
            if (multiHorizon && squeeze?.inSqueeze && squeeze.expectedExpansionMult > 1) {
                multiHorizon.horizons = multiHorizon.horizons.map(h => ({ ...h, expectedPct: +(h.expectedPct * squeeze.expectedExpansionMult).toFixed(2), targetPrice: +(currentPrice * (1 + (h.expectedPct * squeeze.expectedExpansionMult) / 100)).toFixed(2) }));
                multiHorizon.squeezeAmplified = true;
            }
        }
    } catch (_) {}

    let widthBase = 4;
    widthBase += Math.min(8, dispersion / 6);
    if (regime?.regime === 'transition') widthBase += 2;
    if (regime?.regime === 'risk-off') widthBase += 1;
    if (earnings?.daysUntil != null && earnings.daysUntil <= 5) widthBase += 3;
    if (calendar) widthBase += 3;
    if (gap?.big) widthBase += 3;
    if (penny?.squeezeRisk >= 0.5) widthBase += 4;
    if (socialVel?.label === 'extreme') widthBase += 3;
    const halfWidth = Math.round(widthBase / 2);
    const lo = Math.max(50, calibratedConfidence - halfWidth);
    const hi = Math.min(88, calibratedConfidence + halfWidth);
    const confidenceRange = (hi - lo) >= 4 ? { lo, hi } : null;

    const allReasons = [];
    if (ai.available) allReasons.push(`[AI Model] ${ai.reason}`);
    technicalPred.reasons.slice(0, 3).forEach(r => allReasons.push(r));
    sentiment.reasons.forEach(r => allReasons.push(`[Sentiment] ${r}`));
    market.reasons.slice(0, 2).forEach(r => allReasons.push(`[Market] ${r}`));
    if (regime?.regime && regime.regime !== 'neutral') allReasons.push(`[Macro] Market regime: ${regime.regime}`);
    if (sectorMeta && sectorAdj !== 0) { const dir = sectorMeta.rising ? 'rising' : sectorMeta.falling ? 'falling' : 'flat'; allReasons.push(`[Sector] ${sectorMeta.name} sector ${dir} (${sectorMeta.pct5d?.toFixed(1)}% 5d) — ${sectorAdj > 0 ? 'aligned' : 'conflicting'}`); }
    if (rotationResult?.reason) allReasons.push(`[Rotation] ${rotationResult.reason}`);
    if (peerResult?.reason) allReasons.push(`[Peers] ${peerResult.reason}`);
    if (tfResult?.reason) allReasons.push(`[Timeframes] ${tfResult.reason}`);
    if (squeezeResult?.reason) allReasons.push(`[Squeeze] ${squeezeResult.reason}`);
    if (vwapResult?.reason) allReasons.push(`[VWAP] ${vwapResult.reason}`);
    if (volProfileResult?.reason) allReasons.push(`[Volume Profile] ${volProfileResult.reason}`);
    if (crossAssetResult?.reason) allReasons.push(`[Cross-asset] ${crossAssetResult.reason}`);
    if (yieldResult?.reason) allReasons.push(`[Rates] ${yieldResult.reason}`);
    if (optionsResult?.reasons?.length) optionsResult.reasons.forEach(r => allReasons.push(`[Options] ${r}`));
    if (earnings?.capReason) allReasons.push(`[Earnings] ${earnings.capReason}`);
    if (earningsHistory?.capReason) allReasons.push(`[Earnings History] ${earningsHistory.capReason}`);
    if (calendar?.reason) allReasons.push(`[Calendar] ${calendar.reason}`);
    if (gap?.capReason) allReasons.push(`[Gap] ${gap.capReason}`);
    if (recentSpike?.capReason) allReasons.push(`[Spike] ${recentSpike.capReason}`);
    if (patternResult?.reason) allReasons.push(`[Pattern] ${patternResult.reason}`);
    if (derivsResult?.reasons?.length) derivsResult.reasons.forEach(r => allReasons.push(`[Derivs] ${r}`));
    if (pennyResult?.reasons?.length) pennyResult.reasons.forEach(r => allReasons.push(`[Penny tier] ${r}`));
    if (finraResult?.reasons?.length) finraResult.reasons.forEach(r => allReasons.push(`[FINRA] ${r}`));
    if (insiderResult?.reasons?.length) insiderResult.reasons.forEach(r => allReasons.push(`[Insiders] ${r}`));
    if (socialResult?.reasons?.length) socialResult.reasons.forEach(r => allReasons.push(`[Social] ${r}`));
    if (disagreementPenalty > 0) allReasons.push(`[Engine] Sources disagree (range ${dispersion.toFixed(0)} pts) — confidence reduced by ${disagreementPenalty}`);
    if (unanimousBonus > 0) allReasons.push(`[Engine] All sources agree directionally — confidence boosted by ${unanimousBonus}`);
    if (trackRecord?.reason) allReasons.push(`[Track Record] ${trackRecord.reason}`);

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
        unanimousBonus,
        trackRecord,
        dispersion: Math.round(dispersion),
        regime: regime?.regime,
        sector: sectorMeta,
        rotation: rotation || null,
        earnings,
        earningsHistory: earningsHistory || null,
        calendar,
        gap: gap || null,
        recentSpike: recentSpike || null,
        derivs: derivs ? { ...derivs, ...derivsResult } : null,
        peers: peerResult || null,
        pattern: patternResult || null,
        options: options ? { ...options, ...optionsResult } : null,
        squeeze: squeeze || null,
        tfAgreement: tfAgreement || null,
        multiHorizon: multiHorizon || null,
        vwap: vwap || null,
        volProfile: volProfile || null,
        crossAsset: crossAsset || null,
        yields: yieldResult || null,
        // Per-horizon confidence bands derived from the live ledger.
        // null until the ledger accumulates enough resolved horizons.
        horizonBands: getHorizonCalibrations(rawConfidence, finalSignal),
        penny: penny ? { ...penny, ...pennyResult } : null,
        finraShort: finraShort ? { ...finraShort, ...finraResult } : null,
        insider: insider ? { ...insider, ...insiderResult } : null,
        socialVelocity: socialVel ? { ...socialVel, ...socialResult } : null,
        reasons: allReasons.slice(0, 24),
        priceTargets: technicalPred.priceTargets,
        // Top features that drove the technical signal — Mia uses this to
        // answer "why did the model say this?" without re-running anything.
        attribution: summarizeAttribution(technicalPred, 5),
        breakdown: {
            ai: { score: ai.score, available: ai.available, weight: weights.ai * 100, modelTier: ai.modelTier || 'main' },
            technical: { score: technicalScore, weight: weights.technical * 100 },
            sentiment: { score: sentiment.score, weight: weights.sentiment * 100 },
            market: { score: market.score, weight: weights.market * 100 },
        },
        news: sentiment.items || news.map(n => ({ title: n.title, date: n.date, source: n.source, url: n.url || null, sentiment: { label: 'neutral', score: 0 } })),
        newsOverall: sentiment.overall,
        newsSummary: sentiment.reasons[0] || 'No news data',
        marketConditions: market,
        method: 'multi-source + macro/sector/rotation/earnings/history/calendar/gap/spike/peers/derivs/options/squeeze/tf/vwap/volprofile/crossasset/pattern/penny/finra/insider/social + tier-aware LSTM + recency+tier+vol calibrated',
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
    } catch (_) { return null; }
}

function computePriceChange1d(multiData) {
    const candles = multiData?.daily?.candles || [];
    if (candles.length < 2) return 0;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!last || !prev || !prev.close) return 0;
    return ((last.close - prev.close) / prev.close) * 100;
}

function applyWeightShifts(base, macroRegime, trendRegime, attribution) {
    const out = { ...base };
    let techShift = 0, sentShift = 0, mktShift = 0, aiShift = 0;
    if (trendRegime === 'trending') { techShift += 0.05; sentShift -= 0.025; mktShift -= 0.025; }
    else if (trendRegime === 'ranging') { techShift -= 0.05; sentShift += 0.025; mktShift += 0.025; }
    if (macroRegime === 'risk-off') { sentShift -= 0.05; techShift += 0.025; mktShift += 0.025; }
    else if (macroRegime === 'risk-on') { sentShift += 0.025; mktShift += 0.025; techShift -= 0.05; }
    if (attribution) { aiShift += attribution.ai || 0; techShift += attribution.technical || 0; sentShift += attribution.sentiment || 0; mktShift += attribution.market || 0; }
    aiShift = clampShift(aiShift); techShift = clampShift(techShift); sentShift = clampShift(sentShift); mktShift = clampShift(mktShift);
    if (out.ai > 0) out.ai = Math.max(0.05, base.ai + aiShift);
    out.technical = Math.max(0.10, base.technical + techShift);
    out.sentiment = Math.max(0.10, base.sentiment + sentShift);
    out.market = Math.max(0.10, base.market + mktShift);
    const sum = out.ai + out.technical + out.sentiment + out.market;
    if (sum > 0) { out.ai /= sum; out.technical /= sum; out.sentiment /= sum; out.market /= sum; }
    return out;
}

function clampShift(v) {
    if (v > 0.10) return 0.10;
    if (v < -0.10) return -0.10;
    return v;
}
