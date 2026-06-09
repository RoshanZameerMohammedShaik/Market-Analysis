// Empirical calibration of signal confidence.
//
// Strata picked in priority order at inference time:
//   0. Live ledger by horizon+signal (real-world hit rate from
//      record_outcomes.py) — if the bucket has ≥30 samples, this beats
//      everything because it reflects current model behavior in current
//      market conditions, not a backtest replay.
//   0b. Live ledger by region (when no horizon+signal bucket but the
//       region has data — covers non-US markets).
//   1. Recency-weighted backtest curve (exp decay 30d)
//   2. Volatility tier (low / mid / high VIX)
//   3. Liquidity tier (mega/large/mid/small/penny)
//   4. Global backtest curve
//
// Each requires >=30 directional samples. Falls through otherwise.

let calibration = null;
let calibrationByTier = null;
let calibrationByVolTier = null;
let calibrationRecency = null;
let liveCalibration = null;       // model/live_calibration.json
let calibrationStatus = 'unloaded';
let lastSourceUsed = null;        // for telemetry: which strata answered last call

export async function loadCalibration() {
    if (calibrationStatus !== 'unloaded') return calibration;
    // Each source loads INDEPENDENTLY. A failure in one (e.g. a malformed
    // backtest_results.json — historically it shipped bare `NaN` tokens that
    // throw in JSON.parse) must NOT take down the other. Previously both were
    // in one try/catch, so a backtest parse error bailed before live
    // calibration loaded — silently disabling ALL live-ledger calibration and
    // dropping confidence back to raw. Isolating them prevents that cascade.
    try {
        // Backtest calibration (fallback once live has data).
        const res = await fetch('./model/backtest_results.json');
        if (res.ok) {
            const data = await res.json();
            calibration = data?.overall?.calibration || null;
            calibrationByTier = data?.overall?.calibration_by_tier || null;
            calibrationByVolTier = data?.overall?.calibration_by_vol_tier || null;
            calibrationRecency = data?.overall?.calibration_recency_weighted || null;
        }
    } catch (e) {
        // Leave backtest curves null; live calibration below can still load.
        console.warn('Backtest calibration failed to load (continuing with live):', e);
    }

    // Live calibration from the ledger pipeline (Step 3 output).
    // Optional — file may not exist yet on fresh deploys.
    try {
        const lr = await fetch('./model/live_calibration.json');
        if (lr.ok) liveCalibration = await lr.json();
    } catch (_) { /* ledger not seeded yet */ }

    calibrationStatus = (calibration || liveCalibration) ? 'loaded' : 'unavailable';
    return calibration;
}

export function getCalibrationStatus() { return calibrationStatus; }

// Mirror of ledger_universe.region_for — keep in sync. The region tag
// makes Priority 0b region-specific live calibration usable for non-US
// symbols (RELIANCE.NS, 0700.HK, 7203.T, etc.) once the ledger has ≥30
// resolved horizons in that region's bucket.
export function regionFor(symbol) {
    if (!symbol) return null;
    const s = String(symbol).toUpperCase();
    if (s.endsWith('-USD')) return 'CRYPTO';
    if (s.endsWith('.NS')) return 'NSE';
    if (s.endsWith('.L') || s.endsWith('.LON')) return 'LSE';
    if (s.endsWith('.HK')) return 'HKEX';
    if (s.endsWith('.T')) return 'TYO';
    if (s.endsWith('.DE')) return 'XETRA';
    if (s.endsWith('.AX')) return 'ASX';
    return 'NYSE';
}

export function classifyTier(price, avgVolume) {
    const p = Number(price) || 0;
    const v = Number(avgVolume) || 0;
    if (p < 1) return 'penny';
    if (p < 5 || v < 100_000) return 'small';
    if (p < 20 || v < 1_000_000) return 'mid';
    if (p < 100 || v < 10_000_000) return 'large';
    return 'mega';
}

export function classifyVolTier(vix) {
    const v = Number(vix);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v < 16) return 'low';
    if (v < 22) return 'mid';
    return 'high';
}

function interpolateOnCurve(rawConfidence, curve) {
    for (const bucket of curve) {
        const [loStr, hiStr] = bucket.bucket.replace('%', '').split('-');
        const lo = parseInt(loStr, 10);
        const hi = parseInt(hiStr, 10);
        if (rawConfidence >= lo && rawConfidence < hi) {
            return Math.round(bucket.actual);
        }
    }
    if (rawConfidence < parseInt(curve[0].bucket.split('-')[0], 10)) {
        return Math.round(curve[0].actual);
    }
    return Math.round(curve[curve.length - 1].actual);
}

function totalN(curve) {
    if (!curve) return 0;
    return curve.reduce((s, b) => s + (b.count || 0), 0);
}

const MIN_BUCKET_N = 30;   // confidence floor before we trust a bucket

// Candidate bucket keys for a confidence, finest first:
//   1. the 5pp bucket the value lands in (e.g. 53 → "50-55")
//   2. its 10pp parent (e.g. "50-60") as a roll-up when the 5pp bucket
//      is too thin (n < MIN_BUCKET_N).
// recalibrate_from_ledger.py writes 5pp keys; the 10pp parent is
// synthesized here by merging the two 5pp children at read time.
function bucketKeys5(rawConfidence) {
    const lo5 = Math.max(40, Math.min(95, Math.floor(rawConfidence / 5) * 5));
    const lo10 = Math.max(40, Math.min(90, Math.floor(rawConfidence / 10) * 10));
    return {
        fine: `${lo5}-${lo5 + 5}`,
        parentChildren: [`${lo10}-${lo10 + 5}`, `${lo10 + 5}-${lo10 + 10}`],
    };
}

// Merge an array of {n, actual} slots into one n-weighted {actual, n}.
function mergeSlots(slots) {
    const valid = slots.filter(s => s && s.n);
    if (!valid.length) return null;
    const totalN = valid.reduce((s, x) => s + x.n, 0);
    const weighted = valid.reduce((s, x) => s + x.actual * x.n, 0) / totalN;
    return { actual: weighted, n: totalN };
}

// Resolve a confidence against a bucket-map: try the 5pp bucket; if it's
// below the sample floor, roll up to the 10pp parent (both 5pp children
// merged). Returns {actual, n} or null. `mapGetter(key)` returns the
// slot for a bucket key, or an array of slots to merge (BUY+SELL case).
function resolveBucket(rawConfidence, mapGetter) {
    const { fine, parentChildren } = bucketKeys5(rawConfidence);
    const fineSlot = mergeSlots([].concat(mapGetter(fine)));
    if (fineSlot && fineSlot.n >= MIN_BUCKET_N) return fineSlot;
    // Roll up to 10pp parent.
    const parentSlots = parentChildren.flatMap(k => [].concat(mapGetter(k)));
    const parent = mergeSlots(parentSlots);
    if (parent && parent.n >= MIN_BUCKET_N) return parent;
    // Neither clears the floor — return the finer one if it exists at all
    // (caller still applies its own >=30 gate via the returned n).
    return fineSlot || parent || null;
}

function liveBucketLookup(rawConfidence) {
    // Returns {actual, n} from live_calibration.byHorizon[1][BUY|SELL][bucket].
    // Averages BUY+SELL. 5pp bucket with 10pp roll-up fallback.
    if (!liveCalibration?.byHorizon) return null;
    const h1 = liveCalibration.byHorizon['1'];
    if (!h1) return null;
    return resolveBucket(rawConfidence, (key) => [h1.BUY?.[key], h1.SELL?.[key]]);
}

function liveRegionLookup(rawConfidence, region) {
    if (!liveCalibration?.byRegion || !region) return null;
    const buckets = liveCalibration.byRegion[region];
    if (!buckets) return null;
    return resolveBucket(rawConfidence, (key) => buckets[key]);
}

// Lazy-load on first calibrate() call. Previously calibration was
// only loaded by ui/core.js init, which raced against confidence.js
// callers that fire from Hot Picks / scanner / prewarm before init
// finished. Result: liveCalibration was null on early calls and
// calibrate() returned raw confidence unchanged — every signal looked
// pinned to the commitFloor (~53). Lazy-load eliminates that race.
let _loadingPromise = null;
function ensureLoaded() {
    if (calibrationStatus !== 'unloaded') return null;
    if (!_loadingPromise) _loadingPromise = loadCalibration();
    return _loadingPromise;
}

export async function calibrateAsync(rawConfidence, opts) {
    await ensureLoaded();
    return calibrate(rawConfidence, opts);
}

// Race-free variant: returns { value, n, source } computed ATOMICALLY in
// one synchronous calibrate() call, so a caller awaiting it can't read a
// DIFFERENT concurrent calibrate()'s sample size off a mutable global
// (the bug that bit getCalibrationSource()). Concurrent Hot Picks scans
// each get their OWN n. Prefer this over getCalibrationSampleN() after an
// await.
export async function calibrateWithMeta(rawConfidence, opts) {
    await ensureLoaded();
    const value = calibrate(rawConfidence, opts);
    // lastSourceUsed/lastSampleN were just set synchronously by the line
    // above, in THIS microtask, before any other calibrate() can run —
    // so reading them here (no await between) is race-free.
    return { value, n: lastSampleN, source: lastSourceUsed };
}

let lastSampleN = 0;   // sample size behind the last calibrate() answer (0 = raw)

export function calibrate(rawConfidence, { tier = null, volTier = null, region = null } = {}) {
    // If load hasn't kicked off yet, kick it off now so subsequent
    // calls have data. This call still uses whatever's currently in
    // memory (may be null on the very first call).
    ensureLoaded();
    // Priority 0: live ledger by REGION first (asset-class-matched, real-world).
    // This MUST come before the asset-blind byHorizon lookup below — otherwise a
    // stock calibrates against the pooled byHorizon bucket, which right now (post
    // 2026-06-06 engine reset) is built almost entirely from CRYPTO outcomes
    // (the only region with resolved 1d samples yet). Calibrating a US megacap
    // against crypto's 22.9% hit-rate was the "every stock is a uniform ~25% BUY"
    // bug. So: when we know the symbol's region, the region's own live data is
    // the only live source we trust; if it's too thin, fall THROUGH to backtest
    // (Priority 1+) rather than borrowing another asset class's record.
    const liveR = liveRegionLookup(rawConfidence, region);
    if (liveR && liveR.n >= 30) {
        lastSourceUsed = 'live-region'; lastSampleN = liveR.n;
        return Math.round(liveR.actual);
    }
    // Priority 0b: asset-BLIND live ledger by horizon+signal — ONLY when region
    // is unknown. With a known region we deliberately skip this to avoid
    // cross-asset contamination (see above); a thin region just rebuilds via
    // backtest until it has its own resolved samples.
    if (!region) {
        const live = liveBucketLookup(rawConfidence);
        if (live && live.n >= 30) {
            lastSourceUsed = 'live-horizon'; lastSampleN = live.n;
            return Math.round(live.actual);
        }
    }
    // Priority 1: recency-weighted backtest
    if (calibrationRecency && totalN(calibrationRecency) >= 30) {
        lastSourceUsed = 'backtest-recency'; lastSampleN = totalN(calibrationRecency);
        return interpolateOnCurve(rawConfidence, calibrationRecency);
    }
    // Priority 2: volatility tier
    if (volTier && calibrationByVolTier && calibrationByVolTier[volTier] && totalN(calibrationByVolTier[volTier]) >= 30) {
        lastSourceUsed = 'backtest-voltier'; lastSampleN = totalN(calibrationByVolTier[volTier]);
        return interpolateOnCurve(rawConfidence, calibrationByVolTier[volTier]);
    }
    // Priority 3: liquidity tier
    if (tier && calibrationByTier && calibrationByTier[tier] && totalN(calibrationByTier[tier]) >= 30) {
        lastSourceUsed = 'backtest-tier'; lastSampleN = totalN(calibrationByTier[tier]);
        return interpolateOnCurve(rawConfidence, calibrationByTier[tier]);
    }
    // Priority 4: global
    if (calibration && calibration.length > 0) {
        lastSourceUsed = 'backtest-global'; lastSampleN = totalN(calibration);
        return interpolateOnCurve(rawConfidence, calibration);
    }
    lastSourceUsed = 'raw'; lastSampleN = 0;
    return rawConfidence;
}

// Track-record rebuild status. After an engine logic change, recalibrate_
// from_ledger.py excludes prior-engine rows (version gate), so the live
// calibration is rebuilt from scratch under the new engine. This surfaces
// that state to the UI so it can say "track record rebuilding under the
// updated engine" instead of either (a) implying a long proven history that
// belongs to the OLD engine, or (b) implying this is a brand-new app with no
// history at all. Returns null until live calibration loads.
//   rebuilding = the new engine's resolved sample is still smaller than the
//   retired one (we're in the catch-up window). 1-day buckets refill fastest
//   because 1d horizons resolve daily.
export function getTrackRecordStatus() {
    if (!liveCalibration) return null;
    const current = liveCalibration.totalResolvedHorizons || 0;
    const retired = liveCalibration.skippedOldEngineResolved || 0;
    return {
        engineVersion: liveCalibration.engineVersion || null,
        currentResolved: current,
        retiredResolved: retired,
        rebuilding: retired > 0 && current < retired,
    };
}

export function getCalibrationSource() { return lastSourceUsed; }
// Sample size behind the LAST calibrate() answer (0 when raw/ungrounded).
// Lets callers size an HONEST confidence band: wide when few samples back
// the rate, tight when many — the binomial standard error of the hit-rate,
// instead of a heuristic guess-stack.
export function getCalibrationSampleN() { return lastSampleN; }
export function getLiveCalibration() { return liveCalibration; }

// Per-horizon confidence bands. Returns one entry per horizon in
// byHorizon (1, 3, 5, 10, 20 days) showing the historical hit-rate for
// signals near this confidence level at that horizon. UI uses this so
// the user can see "engine has been 62% accurate at 1d but only 51% at
// 20d in this band" — i.e., trust shorter horizons more.
//
// Returns null when the live ledger doesn't have enough resolved
// horizons yet (we need at least 30 samples per horizon to be honest).
export function getHorizonCalibrations(rawConfidence, signal) {
    if (!liveCalibration?.byHorizon) return null;
    const out = [];
    for (const [hStr, perSignal] of Object.entries(liveCalibration.byHorizon)) {
        if (!perSignal) continue;
        // 5pp bucket with 10pp roll-up, averaging BUY+SELL (engine
        // accuracy, not BUY-only). resolveBucket handles the
        // fine→parent fallback; we then apply the n>=30 honesty gate.
        const merged = resolveBucket(rawConfidence, (key) => [perSignal.BUY?.[key], perSignal.SELL?.[key]]);
        if (!merged || merged.n < MIN_BUCKET_N) continue;
        const totalN = merged.n;
        const weightedActual = merged.actual;
        out.push({
            horizonDays: parseInt(hStr, 10),
            hitRate: Math.round(weightedActual),
            n: totalN,
        });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.horizonDays - b.horizonDays);
    return out;
}
export function getCalibrationCurve() { return calibration; }
export function getCalibrationByTier() { return calibrationByTier; }
export function getCalibrationByVolTier() { return calibrationByVolTier; }
export function getCalibrationRecency() { return calibrationRecency; }
