// Weighted Confidence Engine. Phase 8 wires tier='penny' through to ai-model
// so penny stocks use the dedicated penny-LSTM (with main-LSTM fallback when
// penny weights aren't yet trained).

import { getAIPrediction } from './ai-model.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { getMarketConditionsScore } from './market.js';
import { generateMultiTimeframePrediction, calculateATR, summarizeAttribution } from './analysis.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { calibrate, calibrateAsync, calibrateWithMeta, classifyTier, classifyVolTier, getCalibrationStatus, getHorizonCalibrations, regionFor } from './calibration.js';
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
import { getCalibrationThresholds } from './calibration-thresholds.js';

export async function computeFullConfidence(multiData, mode, symbolOrCoinId, timeframe, opts = {}) {
    const { bulkScan = false } = opts;
    loadConformal();
    loadPatterns();

    // Compute tier first so we can pass it to the AI model.
    const tier = computeTier(multiData);

    // For the "Today" horizon, prefer the intraday (1h-candle) LSTM and
    // feed it the raw 1h series — it predicts the next intraday move,
    // which is what "Today" actually asks. For "Tomorrow" (or when no 1h
    // data is available) we keep the daily model on daily candles. The
    // intraday model self-heals: if its weights file hasn't shipped yet,
    // ai-model.js falls back to the daily model transparently.
    const useIntraday = timeframe === 'today' && Array.isArray(multiData.hourly?.candles) && multiData.hourly.candles.length > 0;
    const aiCandles = useIntraday ? multiData.hourly.candles : multiData.daily.candles;

    const [aiResult, newsItems, marketResult] = await Promise.allSettled([
        getAIPrediction(aiCandles, { tier, intraday: useIntraday }),
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
    // Regime-conditional weighting: scale the regime tilt by how STRONGLY
    // the regime is expressed, instead of applying a fixed magnitude to
    // any trend. A screaming trend (ADX 40) tilts toward momentum harder
    // than a barely-trending tape (ADX 26); a VIX of 35 tilts toward the
    // risk-off blend harder than a VIX of 23. Strengths are continuous in
    // [0,1] so the shift fades smoothly rather than flipping on a binary
    // threshold (which is what the old fixed-magnitude version did).
    const adxVal = technicalPred.indicators?.adx;
    const trendStrength = regimeStrengthFromAdx(adxVal, trendRegime);
    const macroStrength = regimeStrengthFromVix(currentVix, regime?.regime);
    weights = applyWeightShifts(weights, regime?.regime, trendRegime, attributionShifts(), { trendStrength, macroStrength });

    const weightedScore = ai.score * weights.ai + technicalScore * weights.technical + sentiment.score * weights.sentiment + market.score * weights.market;

    // ALL thresholds below are LEARNED from the live ledger by
    // calibration-thresholds.js. No hardcoded magic numbers.
    // Bootstrap defaults are used only when the ledger is too thin
    // to learn from, and they're documented as transitional in that
    // module. The rule from feedback_dynamic_only is enforced here.
    const thresh = await getCalibrationThresholds();

    const deviation = Math.abs(weightedScore - 50) / 50;
    // Map raw [0, 50] deviation to the [commitFloor, 88] confidence
    // band — anything below commitFloor doesn't commit anyway.
    let rawConfidence = Math.round(thresh.commitFloorConfidence +
        deviation * (88 - thresh.commitFloorConfidence));

    let finalSignal;
    if (weightedScore > thresh.buyScoreThreshold && rawConfidence >= thresh.commitFloorConfidence) finalSignal = 'BUY';
    else if (weightedScore < thresh.sellScoreThreshold && rawConfidence >= thresh.commitFloorConfidence) finalSignal = 'SELL';
    else finalSignal = 'NEUTRAL';

    const sourceScores = [technicalScore, sentiment.score, market.score];
    if (ai.available) sourceScores.push(ai.score);
    const dispersion = Math.max(...sourceScores) - Math.min(...sourceScores);
    // Dispersion penalty bands learned from the ledger — see
    // calibration-thresholds.js. Previously hardcoded as
    // 50/35/25 → 12/7/3, those numbers were guesses. The learner
    // now derives the actual relationship between source dispersion
    // and miss rate.
    let disagreementPenalty = 0;
    for (const band of thresh.dispersionPenaltyBands) {
        if (dispersion > band.gt) { disagreementPenalty = band.penalty; break; }
    }
    rawConfidence = Math.max(thresh.commitFloorConfidence, rawConfidence - disagreementPenalty);

    // Unanimous-agreement bonus. Cutoffs and bonus magnitude come
    // from calibration-thresholds.js (learned from the ledger).
    let unanimousBonus = 0;
    if (finalSignal === 'BUY' || finalSignal === 'SELL') {
        const all = [technicalScore, sentiment.score, market.score];
        if (ai.available) all.push(ai.score);
        const allAgree = finalSignal === 'BUY'
            ? all.every(s => s > thresh.unanimousAgreementCutoff)
            : all.every(s => s < thresh.sellAgreementCutoff);
        if (allAgree) {
            unanimousBonus = thresh.unanimousBonusPts;
            rawConfidence = Math.min(88, rawConfidence + unanimousBonus);
        }
    }

    // Ensemble consensus. Dispersion (above) measures the SPREAD of
    // source scores; consensus measures how many sources actually
    // point the SAME DIRECTION as the committed signal — a different
    // axis. Two sources at 55 and 88 have high dispersion but full
    // agreement; a source at 30 against a BUY is a true contradiction
    // that the spread metric under-weights. We surface the vote tally
    // for the "model consensus N/M agree" trust display, and dock
    // confidence specifically for CONTRADICTING sources (not merely
    // abstaining ones). The dock magnitude reuses the learned
    // dispersion penalty scale so we introduce no new magic numbers.
    const consensus = computeConsensus(
        { ai: ai.available ? ai.score : null, technical: technicalScore, sentiment: sentiment.score, market: market.score },
        finalSignal,
        thresh,
    );
    let contradictionPenalty = 0;
    if ((finalSignal === 'BUY' || finalSignal === 'SELL') && consensus.against > 0 && consensus.total > 0) {
        const maxLearnedPenalty = Math.max(0, ...(thresh.dispersionPenaltyBands || []).map(b => b.penalty || 0));
        // Scale by the fraction of sources actively pointing the wrong
        // way. One of four contradicting → ~1/4 of the max learned dock.
        contradictionPenalty = Math.round(maxLearnedPenalty * (consensus.against / consensus.total));
        if (contradictionPenalty > 0) {
            rawConfidence = Math.max(thresh.commitFloorConfidence, rawConfidence - contradictionPenalty);
        }
    }
    consensus.confidenceDock = contradictionPenalty;

    // ── Ensemble-agreement abstain gate ──────────────────────────────────
    // The engine commits BUY/SELL off the weighted SCORE, but a call the
    // ensemble actively splits on is a coin flip dressed as conviction —
    // exactly the kind of low-edge call that dragged 1-day accuracy toward
    // 50%. So when a committed directional call has a genuine ensemble
    // SPLIT — fewer than half its available sources agree directionally AND
    // at least one actively contradicts — we ABSTAIN to NEUTRAL rather than
    // emit it. This trades volume for hit-rate on the calls we DO make.
    // Conservative by design: a unanimous-but-modest call is untouched
    // (against === 0 → never abstains); only true internal disagreement
    // kills the commit. Bulk-scan still runs it (consensus is computed
    // there too), so Hot Picks and the detail card agree.
    let abstainedFromEnsemble = false;
    // Use the SOFT lean (vs 50), not the strong-conviction cutoff, so we only
    // abstain on a genuine ensemble SPLIT — more sources leaning AGAINST the
    // call than for it, with at least one strong contradiction. A modest
    // call where most sources lean the right way (even if below the 55
    // conviction cutoff) is NOT abstained. Requires ≥3 sources so a single
    // dissenter on a 2-source read can't force an abstain.
    if ((finalSignal === 'BUY' || finalSignal === 'SELL')
        && consensus.total >= 3
        && consensus.against >= 1
        && consensus.leansAgainst > consensus.leansFor) {
        abstainedFromEnsemble = true;
        finalSignal = 'NEUTRAL';
        // Abstaining means "no conviction" — so the displayed confidence
        // must drop to the floor, not keep the high value the BUY/SELL
        // score earned. Otherwise the card shows "DON'T BUY · 74%", a
        // contradiction. (priceTargets are nulled at return time so an
        // abstained call doesn't show a directional predicted range.)
        rawConfidence = thresh.commitFloorConfidence;
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
                // Track-record thresholds from calibration-thresholds.js.
                let trAdj = 0;
                if (symHitRate >= thresh.trackRecord.strong.rateAtLeast) {
                    trAdj = thresh.trackRecord.strong.bonus;
                } else if (symHitRate >= thresh.trackRecord.good.rateAtLeast) {
                    trAdj = thresh.trackRecord.good.bonus;
                } else if (symHitRate <= thresh.trackRecord.weak.rateAtMost) {
                    trAdj = thresh.trackRecord.weak.penalty;
                }
                if (trAdj !== 0) {
                    rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + trAdj));
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
    if (regime) { regimePen = regimeBias(regime.regime).pen || 0; rawConfidence = Math.max(thresh.commitFloorConfidence, rawConfidence - regimePen); }

    let sectorAdj = 0, sectorMeta = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try { const r = await getSectorAdjustment(symbolOrCoinId, finalSignal); sectorAdj = r.adjust; sectorMeta = r.sector; rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + sectorAdj)); } catch (_) {}
    }

    // 10-year yield context. Long-duration / rate-sensitive sectors get
    // headwind/tailwind from yield trajectory; banks get the opposite.
    // Bounded ±3pts. Only stocks (crypto isn't directly rate-sensitive).
    let yieldResult = null;
    if (mode === 'stock' && symbolOrCoinId) {
        try {
            yieldResult = await getYieldAdjustment(symbolOrCoinId, finalSignal);
            if (yieldResult?.adjust) {
                rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + yieldResult.adjust));
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
        try { derivs = await fetchCryptoDerivs(symbolOrCoinId); if (derivs) { const priceChange1d = computePriceChange1d(multiData); derivsResult = derivsAdjustment(finalSignal, derivs, priceChange1d); rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + (derivsResult.adjust || 0))); } } catch (_) {}
    }

    let peerResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { const peer = await getPeerAgreement(symbolOrCoinId, finalSignal); if (peer) { peerResult = peerAdjustment(finalSignal, peer); if (peerResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + peerResult.adjust)); peerResult.peer = peer; } } catch (_) {}
    }

    let options = null, optionsResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { options = await fetchOptionsPositioning(symbolOrCoinId); if (options) { optionsResult = optionsAdjustment(finalSignal, options); rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + (optionsResult.adjust || 0))); } } catch (_) {}
    }

    let squeeze = null, squeezeResult = null;
    try { const closes = (multiData?.daily?.candles || []).map(c => c.close); squeeze = detectSqueeze(closes); if (squeeze) { squeezeResult = squeezeAdjustment(finalSignal, squeeze); if (squeezeResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + squeezeResult.adjust)); } } catch (_) {}

    let tfAgreement = null, tfResult = null;
    if (technicalPred.breakdown) { tfAgreement = timeframeAgreement(finalSignal, technicalPred.breakdown); if (tfAgreement) { tfResult = timeframeAgreementAdjustment(finalSignal, tfAgreement); if (tfResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + tfResult.adjust)); } }

    let vwap = null, vwapResult = null;
    try { vwap = computeVwapClassifier(multiData?.daily?.candles || []); if (vwap) { vwapResult = vwapAdjustment(finalSignal, vwap); if (vwapResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + vwapResult.adjust)); } } catch (_) {}

    let rotation = null, rotationResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try { rotation = await getSectorRotation(symbolOrCoinId); if (rotation) { rotationResult = rotationAdjustment(finalSignal, rotation); if (rotationResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + rotationResult.adjust)); } } catch (_) {}
    }

    let volProfile = null, volProfileResult = null;
    try { volProfile = computeVolumeProfile(multiData?.daily?.candles || []); if (volProfile) { volProfileResult = volumeProfileAdjustment(finalSignal, volProfile, vwap?.volumeTrend); if (volProfileResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + volProfileResult.adjust)); } } catch (_) {}

    let crossAsset = null, crossAssetResult = null;
    if (!bulkScan && symbolOrCoinId) {
        try { crossAsset = await getCrossAsset(mode, symbolOrCoinId); if (crossAsset) { crossAssetResult = crossAssetAdjustment(finalSignal, crossAsset); if (crossAssetResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + crossAssetResult.adjust)); } } catch (_) {}
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
                if (pennyResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + pennyResult.adjust));
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
                if (finraResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + finraResult.adjust));
            }
        } catch (_) {}
    }

    let insider = null, insiderResult = null;
    if (mode === 'stock' && tier === 'penny' && !bulkScan && symbolOrCoinId) {
        try {
            insider = await getOpenInsider(symbolOrCoinId);
            if (insider) {
                insiderResult = openInsiderAdjustment(finalSignal, insider, tier);
                if (insiderResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + insiderResult.adjust));
            }
        } catch (_) {}
    }

    let socialVel = null, socialResult = null;
    if (mode === 'stock' && !bulkScan && symbolOrCoinId) {
        try {
            socialVel = await getSocialVelocity(symbolOrCoinId);
            if (socialVel) {
                socialResult = socialVelocityAdjustment(finalSignal, socialVel);
                if (socialResult.adjust) rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + socialResult.adjust));
            }
        } catch (_) {}
    }

    let patternResult = null;
    if (technicalPred.indicators) {
        const patternKey = encodePattern({ signal: finalSignal, indicators: technicalPred.indicators, tier });
        const adj = patternAdjustment(patternKey);
        if (adj.cap != null && adj.cap < rawConfidence) { rawConfidence = adj.cap; patternResult = adj; }
        else if (adj.adjust) { rawConfidence = Math.max(thresh.commitFloorConfidence, Math.min(88, rawConfidence + adj.adjust)); patternResult = adj; }
    }

    const region = regionFor(symbolOrCoinId);
    // Await the async variant so the calibration JSON is loaded before
    // we read it. Earlier this was a sync call that raced against the
    // ui/core.js init: the first wave of Hot Picks / scanner runs hit
    // calibrate() while liveCalibration was still null, so calibration
    // silently no-op'd and every confidence pinned near the commitFloor.
    // calibrateWithMeta returns { value, n } atomically so the sample size
    // can't be clobbered by a concurrent Hot Picks calibrate() between the
    // await and the read (the mutable-global race).
    const { value: calibratedConfidence, n: calN } = await calibrateWithMeta(rawConfidence, { tier, volTier, region });
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

    // Confidence band (the "63–71%" shown by the number). Previously this
    // was a pure heuristic guess-stack (+2 for transition, +dispersion/6,
    // …) — a made-up width presented as engine uncertainty. Now it's
    // ANCHORED to the binomial standard error of the calibrated hit-rate:
    // half-width = 1·SE where SE = sqrt(p(1-p)/n) in percentage points,
    // using the sample size n behind the calibration answer. Few samples →
    // genuinely wide; many → tight. That's an empirical, defensible band.
    // The heuristic factors are kept only as a SMALL additive widener for
    // known event-risk (earnings/gap/calendar), capped, so the band can
    // honestly fatten near binary events without inventing the base width.
    let halfWidth;
    if (calN >= 30) {
        const p = Math.max(0.01, Math.min(0.99, calibratedConfidence / 100));
        const sePts = Math.sqrt((p * (1 - p)) / calN) * 100;   // 1σ in conf-points
        halfWidth = sePts;
    } else {
        // Not enough calibration samples to ground a band statistically —
        // fall back to the prior dispersion-based heuristic so we still
        // show *something*, but this is the un-grounded path.
        halfWidth = 2 + Math.min(4, dispersion / 12);
    }
    // Small event-risk widener (bounded) — binary events genuinely widen
    // the outcome distribution regardless of historical calibration.
    let eventWiden = 0;
    if (earnings?.daysUntil != null && earnings.daysUntil <= 5) eventWiden += 1.5;
    if (calendar) eventWiden += 1.5;
    if (gap?.big) eventWiden += 1.5;
    if (penny?.squeezeRisk >= 0.5) eventWiden += 2;
    if (socialVel?.label === 'extreme') eventWiden += 1.5;
    halfWidth = Math.round(Math.min(12, halfWidth + Math.min(5, eventWiden)));
    const lo = Math.max(thresh.commitFloorConfidence, calibratedConfidence - halfWidth);
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
    if (abstainedFromEnsemble) {
        allReasons.push(`[Consensus] Sat out — only ${consensus.for}/${consensus.total} sources agreed and ${consensus.against} pushed the other way. The ensemble is split, so the engine declines to call it.`);
    } else if (consensus && (finalSignal === 'BUY' || finalSignal === 'SELL') && consensus.total > 0) {
        if (consensus.against > 0) allReasons.push(`[Consensus] ${consensus.for}/${consensus.total} sources back this ${finalSignal} — ${consensus.against} pointing the other way${contradictionPenalty > 0 ? `, confidence reduced by ${contradictionPenalty}` : ''}`);
        else if (consensus.for === consensus.total) allReasons.push(`[Consensus] All ${consensus.total} sources agree on ${finalSignal}`);
        else allReasons.push(`[Consensus] ${consensus.for}/${consensus.total} sources back this ${finalSignal} (rest neutral)`);
    }
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
        consensus,
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
        // On an ensemble abstain, suppress the directional predicted range —
        // showing "Possible High +X% / Possible Low −Y%" for a call the
        // engine just declined to make is contradictory. NEUTRAL → no range.
        priceTargets: abstainedFromEnsemble ? null : technicalPred.priceTargets,
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
        // meta carries why the engine abstained (read by the signal card's
        // "Sit this one out" insight). abstainedFrom = the directional call
        // the score WOULD have made before the ensemble split killed it.
        meta: abstainedFromEnsemble ? {
            abstainReason: `The ensemble is split — only ${consensus.for} of ${consensus.total} sources agreed and ${consensus.against} pushed the other way. Better to wait for a cleaner setup than force a coin-flip.`,
            abstainedFrom: weightedScore > 50 ? 'BUY' : 'SELL',
        } : undefined,
    };
}

// Tally how many ensemble sources agree / contradict / abstain
// relative to the committed signal. A source "agrees" when it leans
// the same direction past the learned agreement cutoff; "contradicts"
// when it leans the OPPOSITE direction past the mirror cutoff;
// otherwise it abstains (too close to neutral to count either way).
// Returns { for, against, neutral, total, votes, ratioPct } where
// `votes` is a per-source label map used by the UI trust panel.
function computeConsensus(scores, signal, thresh) {
    const bullCut = thresh?.unanimousAgreementCutoff ?? 55;
    const bearCut = thresh?.sellAgreementCutoff ?? 45;
    const votes = {};
    let forN = 0, against = 0, neutral = 0, total = 0;
    // Soft directional lean (relative to the true neutral, 50) — used by the
    // abstain gate. The strong cutoffs above create a 45–55 dead zone that's
    // right for the DISPLAY ("which sources took a strong stand") but too
    // strict for abstaining: a source at 53 on a BUY genuinely backs the
    // direction, it's just not highly convicted. leansFor/leansAgainst count
    // that softer agreement so the gate doesn't nuke the modest 50–60 band.
    let leansFor = 0, leansAgainst = 0;
    for (const [src, score] of Object.entries(scores)) {
        if (score == null || !Number.isFinite(score)) { votes[src] = 'n/a'; continue; }
        total++;
        const leansBull = score > bullCut;
        const leansBear = score < bearCut;
        let label;
        if (signal === 'BUY') label = leansBull ? 'agree' : leansBear ? 'against' : 'neutral';
        else if (signal === 'SELL') label = leansBear ? 'agree' : leansBull ? 'against' : 'neutral';
        else label = 'neutral';
        votes[src] = label;
        if (label === 'agree') forN++;
        else if (label === 'against') against++;
        else neutral++;
        // Soft lean vs 50 (ignore exactly-50 as truly neutral).
        const softBull = score > 50, softBear = score < 50;
        if (signal === 'BUY') { if (softBull) leansFor++; else if (softBear) leansAgainst++; }
        else if (signal === 'SELL') { if (softBear) leansFor++; else if (softBull) leansAgainst++; }
    }
    return {
        for: forN,
        against,
        neutral,
        total,
        leansFor,
        leansAgainst,
        votes,
        ratioPct: total ? Math.round((forN / total) * 100) : 0,
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

// Map ADX to a 0..1 trend-strength multiplier. The trend tilt should
// ramp in across the ADX band the technical layer already uses to label
// regime (>25 trending, <20 ranging). At the boundary the multiplier is
// ~0 so we don't yank weights around on a marginal regime call; deep in
// the regime it approaches 1 (full tilt). Returns 1 (neutral full
// strength) when ADX is unavailable so behavior matches the old fixed
// magnitude rather than silently zeroing the tilt.
function regimeStrengthFromAdx(adx, trendRegime) {
    if (!Number.isFinite(adx)) return 1;
    if (trendRegime === 'trending') {
        // ADX 25 → 0, ADX 45 → 1 (clamped).
        return Math.max(0, Math.min(1, (adx - 25) / 20));
    }
    if (trendRegime === 'ranging') {
        // ADX 20 → 0, ADX 8 → 1 (lower ADX = more firmly ranging).
        return Math.max(0, Math.min(1, (20 - adx) / 12));
    }
    return 0; // transitional/unknown — no trend tilt
}

// Map VIX to a 0..1 macro-strength multiplier scaled by distance from
// the neutral 16-22 band. VIX 22 → 0 ramping to VIX 35 → 1 (risk-off
// intensity); VIX 16 → 0 ramping to VIX 10 → 1 (risk-on calm). Returns
// 1 when VIX is unavailable (old fixed-magnitude behavior).
function regimeStrengthFromVix(vix, macroRegime) {
    if (!Number.isFinite(vix)) return 1;
    if (macroRegime === 'risk-off') return Math.max(0, Math.min(1, (vix - 22) / 13));
    if (macroRegime === 'risk-on') return Math.max(0, Math.min(1, (16 - vix) / 6));
    return 0;
}

function applyWeightShifts(base, macroRegime, trendRegime, attribution, strengths = {}) {
    const out = { ...base };
    // Strength multipliers in [0,1] (default 1 = old fixed behavior when
    // the caller doesn't pass them, e.g. unit tests / legacy callers).
    const ts = Number.isFinite(strengths.trendStrength) ? strengths.trendStrength : 1;
    const ms = Number.isFinite(strengths.macroStrength) ? strengths.macroStrength : 1;
    let techShift = 0, sentShift = 0, mktShift = 0, aiShift = 0;
    if (trendRegime === 'trending') { techShift += 0.05 * ts; sentShift -= 0.025 * ts; mktShift -= 0.025 * ts; }
    else if (trendRegime === 'ranging') { techShift -= 0.05 * ts; sentShift += 0.025 * ts; mktShift += 0.025 * ts; }
    if (macroRegime === 'risk-off') { sentShift -= 0.05 * ms; techShift += 0.025 * ms; mktShift += 0.025 * ms; }
    else if (macroRegime === 'risk-on') { sentShift += 0.025 * ms; mktShift += 0.025 * ms; techShift -= 0.05 * ms; }
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
