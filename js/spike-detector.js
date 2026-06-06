// Spike detector — finds candidates with above-baseline probability of
// moving ≥X% in the SAME trading session (today only).
//
// This is honest: most picks will be wrong. Single-session ≥10% moves
// are rare. The engine's job is to surface candidates that have *both*
// physical feasibility (ATR is wide enough that the bucket is within ~2σ)
// AND a triggering setup (oversold reversal, coiled breakout, news catalyst,
// sector tailwind). Earnings-imminent stocks are skipped; they move on the
// report which is binary, not predictable.
//
// Output: per-symbol { signal, targetPrice, projectedPct, confidence, reason }.

import { fetchStockData, fetchCryptoData } from './data.js';
import { calculateRSI, calculateBollingerBands, calculateATR, calculateADX, calculateMFI, detectVolumeSpike } from './analysis.js';
import { getMacroRegime } from './regime.js';
import { getSectorAdjustment } from './sectors.js';
import { getEarningsProximity } from './earnings.js';
import { fetchStockNews, fetchCryptoNews } from './news.js';
import { analyzeNewsSentiment } from './sentiment.js';
import { calibrate, getCalibrationStatus } from './calibration.js';

export const BUCKETS = [
    { id: 'gte10', label: '≥10%', minPct: 10, maxPct: Infinity },
    { id: '10to20', label: '10–20%', minPct: 10, maxPct: 20 },
    { id: '20to30', label: '20–30%', minPct: 20, maxPct: 30 },
    { id: '30to40', label: '30–40%', minPct: 30, maxPct: 40 },
    { id: '40to50', label: '40–50%', minPct: 40, maxPct: 50 },
    { id: 'gt50', label: '>50%', minPct: 50, maxPct: Infinity },
];

export function bucketById(id) { return BUCKETS.find(b => b.id === id) || BUCKETS[0]; }

async function scoreOne({ symbol, name, price, candles, mode, regime, sectorAdj, earnings, newsScore }) {
    if (!candles || candles.length < 30) return null;
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume).filter(v => v > 0);
    const last = closes[closes.length - 1];
    if (!Number.isFinite(last)) return null;

    const rsi = calculateRSI(closes);
    const bb = calculateBollingerBands(closes);
    const atr = calculateATR(candles);
    const adx = calculateADX(candles);
    const mfi = volumes.length >= 15 ? calculateMFI(candles) : null;
    const volSpike = detectVolumeSpike(volumes);
    if (!atr || !bb) return null;

    const atrPct = (atr / last) * 100;

    // Vectors. Each contributes 0-1 to a raw score; weights below.
    const meanReversion = (() => {
        let s = 0;
        if (rsi != null && rsi < 25) s += 0.6;
        else if (rsi != null && rsi < 30) s += 0.35;
        if (bb.percentB < 0) s += 0.4;
        else if (bb.percentB < 0.1) s += 0.2;
        return Math.min(1, s);
    })();

    const breakout = (() => {
        let s = 0;
        const bandwidthPct = (bb.bandwidth ?? 0) * 100;
        if (bandwidthPct < 6) s += 0.5;        // squeeze
        else if (bandwidthPct < 10) s += 0.25;
        if (adx != null && adx > 22 && adx < 40) s += 0.3;  // trend forming, not exhausted
        if (volSpike?.ratio > 1.5) s += 0.3;
        else if (volSpike?.ratio > 1.2) s += 0.15;
        return Math.min(1, s);
    })();

    const volumeStrength = (() => {
        const r = volSpike?.ratio || 1;
        if (r > 3) return 1.0;
        if (r > 2) return 0.7;
        if (r > 1.5) return 0.4;
        if (r > 1.2) return 0.2;
        return 0;
    })();

    const moneyFlowBoost = (mfi != null && mfi < 25) ? 0.4 : (mfi != null && mfi < 35) ? 0.2 : 0;
    const sectorBoost = sectorAdj > 0 ? Math.min(0.4, sectorAdj / 10) : sectorAdj < 0 ? -0.3 : 0;
    const macroBoost = regime === 'risk-on' ? 0.15 : regime === 'risk-off' ? -0.2 : 0;
    const newsBoost = (() => {
        if (newsScore == null) return 0;
        // newsScore is the recency-weighted -1..+1 sentiment.
        if (newsScore > 0.4) return 0.35;
        if (newsScore > 0.2) return 0.18;
        if (newsScore < -0.4) return -0.4;
        if (newsScore < -0.2) return -0.2;
        return 0;
    })();

    // Raw probability — weighted blend, clamped 0..1.
    const raw = Math.max(0, Math.min(1,
        meanReversion * 0.30 +
        breakout * 0.25 +
        volumeStrength * 0.18 +
        moneyFlowBoost * 0.10 +
        Math.max(0, sectorBoost) * 0.08 +
        Math.max(0, macroBoost) * 0.05 +
        Math.max(0, newsBoost) * 0.04
    ) + Math.min(0, sectorBoost + macroBoost + newsBoost)); // dampers can subtract

    // Build a one-line rationale from the strongest contributors.
    const reasons = [];
    if (meanReversion > 0.4) reasons.push(rsi < 25 ? `deep oversold (RSI ${rsi.toFixed(0)})` : `oversold + lower-band`);
    if (breakout > 0.4) reasons.push(`coiled (BB squeeze${adx > 22 ? ', ADX rising' : ''})`);
    if (volumeStrength > 0.5) reasons.push(`${(volSpike.ratio || 1).toFixed(1)}× volume`);
    if (moneyFlowBoost > 0) reasons.push(`MFI oversold (${mfi.toFixed(0)})`);
    if (sectorBoost > 0.2) reasons.push('sector tailwind');
    if (newsBoost > 0.15) reasons.push('positive news catalyst');
    if (newsBoost < -0.15) reasons.push('⚠ negative news');
    if (sectorBoost < -0.2) reasons.push('⚠ sector headwind');
    if (earnings?.daysUntil != null && earnings.daysUntil >= 0 && earnings.daysUntil <= 5) {
        reasons.push(`earnings in ${earnings.daysUntil}d`);
    }
    const reason = reasons.length ? reasons.join(' · ') : 'mixed setup';

    return {
        symbol, name, price: last, atr, atrPct, rsi, bb, adx, volSpikeRatio: volSpike?.ratio || 1,
        rawProbability: raw, reason,
    };
}

// ONE physical-reach rule, shared by feasibility AND projection so they
// can't contradict: a same-session move can plausibly stretch to ~3 daily
// ATRs (3-sigma intraday), capped at 80%.
function physicalMaxPct(scored) {
    return Math.min(80, scored.atrPct * 3);
}

function feasibleForBucket(scored, bucket) {
    if (!scored) return false;
    // Feasible only if the candidate can physically REACH the band's floor.
    // Previously the gate used ATR×2-vs-midpoint while the projection used
    // ATR×3, so they disagreed — a candidate could pass the gate yet project
    // a % outside its own bucket (e.g. ">50%" showing "+15%"). Now both use
    // physicalMaxPct, and the test is "can it reach bucket.minPct".
    return physicalMaxPct(scored) >= bucket.minPct;
}

/**
 * @param {Array<{symbol,name,price?,candles?,mode}>} candidates
 * @param {object} bucket from BUCKETS
 * @param {(msg:string)=>void} onProgress
 */
export async function findSpikers(candidates, bucket, onProgress, opts = {}) {
    const { mode = 'stock' } = opts;
    if (onProgress) onProgress('Loading market context…');

    // Shared market context, fetched once per scan.
    let regime = null;
    if (mode === 'stock') {
        try { regime = (await getMacroRegime()).regime; } catch (_) { regime = 'neutral'; }
    }

    const out = [];
    let analyzed = 0;
    const total = candidates.length;
    const concurrency = mode === 'stock' ? 6 : 3; // crypto rate-limited harder

    async function processBatch(batch) {
        return Promise.all(batch.map(async (c) => {
            try {
                let candles = c.candles;
                if (!candles) {
                    if (mode === 'stock') {
                        // Bulk scan path — suffixProbe off so a single
                        // missing symbol doesn't walk 6 candidates × 2
                        // URLs through the proxy chain.
                        const data = await fetchStockData(c.symbol, '3mo', '1d', { suffixProbe: false });
                        candles = data.candles;
                        c.name = c.name || data.name;
                        c.price = data.currentPrice;
                    } else {
                        const data = await fetchCryptoData(c.id || c.symbol.toLowerCase(), 30);
                        candles = data.candles;
                        c.name = c.name || data.name;
                        c.price = data.currentPrice;
                    }
                }
                if (!candles || candles.length < 30) return null;

                // Per-symbol context (parallel where possible).
                let earnings = null, sectorAdj = 0, newsScore = null;
                if (mode === 'stock') {
                    [earnings, sectorAdj] = await Promise.all([
                        getEarningsProximity(c.symbol).catch(() => null),
                        getSectorAdjustment(c.symbol, 'BUY').then(r => r.adjust).catch(() => 0),
                    ]);
                    // Skip earnings-imminent stocks for spike detection.
                    if (earnings?.daysUntil != null && earnings.daysUntil >= 0 && earnings.daysUntil <= 1) return null;
                }
                // Lightweight news: only fetch for top-N candidates later. For now use last close move
                // as a poor-man's catalyst proxy when news is skipped.
                const scored = await scoreOne({
                    symbol: c.symbol, name: c.name, price: c.price, candles, mode,
                    regime, sectorAdj, earnings, newsScore,
                });
                return scored;
            } catch (e) {
                return null;
            }
        }));
    }

    for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        analyzed += batch.length;
        if (onProgress) onProgress(`Scoring ${batch.map(b => b.symbol).join(', ')} (${analyzed}/${total})`);
        const scored = await processBatch(batch);
        scored.forEach(s => { if (s) out.push(s); });
        if (i + concurrency < candidates.length) await new Promise(r => setTimeout(r, 120));
    }

    // Filter by ATR-feasibility for the chosen bucket and rank by raw probability.
    const feasible = out
        .filter(s => feasibleForBucket(s, bucket))
        .sort((a, b) => b.rawProbability - a.rawProbability)
        .slice(0, 30);

    // Add news boost on the top-ranked subset only (cost-aware).
    if (onProgress) onProgress(`Reading news for top ${Math.min(20, feasible.length)} candidates…`);
    const top = feasible.slice(0, 20);
    await Promise.all(top.map(async s => {
        try {
            const news = mode === 'stock' ? await fetchStockNews(s.symbol).catch(() => []) : await fetchCryptoNews(s.symbol).catch(() => []);
            const sent = await analyzeNewsSentiment(news.slice(0, 5));
            const score100 = sent.score; // 0..100 bullish
            const ns = (score100 - 50) / 50; // -1..+1
            // Refine probability with the news vector.
            if (ns > 0.4) s.rawProbability = Math.min(1, s.rawProbability + 0.10);
            else if (ns > 0.2) s.rawProbability = Math.min(1, s.rawProbability + 0.05);
            else if (ns < -0.4) s.rawProbability = Math.max(0, s.rawProbability - 0.15);
            else if (ns < -0.2) s.rawProbability = Math.max(0, s.rawProbability - 0.06);
            s.newsScore = ns;
            s.newsHeadline = news[0]?.title || null;
        } catch (_) { /* */ }
    }));

    // Final sort + finalize fields.
    top.sort((a, b) => b.rawProbability - a.rawProbability);
    const calibratedAvailable = getCalibrationStatus() === 'loaded';
    const finalized = top.map(s => {
        // Project a target that ALWAYS lands inside the selected bucket band.
        // Aim near the midpoint, clamp to [minPct, min(maxPct, physicalMax)],
        // and floor at the band minimum so the shown % can never fall below
        // the bucket the user filtered for. physicalMax uses the SAME ATR×3
        // rule as feasibleForBucket, so gate and projection agree.
        const physMax = physicalMaxPct(s);
        const desiredPct = bucket.maxPct === Infinity ? bucket.minPct + 5 : (bucket.minPct + Math.min(bucket.maxPct, 80)) / 2;
        const bandCap = Math.min(bucket.maxPct === Infinity ? 80 : bucket.maxPct, physMax);
        // If physical reach can't even hit the floor, this candidate doesn't
        // belong in the band — drop it (defense-in-depth; feasibleForBucket
        // already filtered, but keep the projection self-consistent).
        if (bandCap < bucket.minPct) return null;
        const projectedPct = Math.max(bucket.minPct, Math.min(desiredPct, bandCap));
        const targetPrice = s.price * (1 + projectedPct / 100);
        // Confidence: clamp to 38..82 then calibrate.
        const rawConfidence = Math.round(38 + s.rawProbability * 44);
        const confidence = calibrate(rawConfidence);
        return {
            symbol: s.symbol, name: s.name, price: s.price,
            projectedPct: +projectedPct.toFixed(1),
            targetPrice: +targetPrice.toFixed(2),
            confidence, rawConfidence,
            calibrated: calibratedAvailable,
            reason: s.reason,
            newsHeadline: s.newsHeadline || null,
            atrPct: +s.atrPct.toFixed(2),
            rsi: s.rsi != null ? +s.rsi.toFixed(1) : null,
            volSpikeRatio: +s.volSpikeRatio.toFixed(1),
        };
    });

    // Drop any candidate the band-projection excluded (returned null).
    return finalized.filter(Boolean);
}
