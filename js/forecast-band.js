// 7-day High/Low forecast bands with a confidence that is actually measured.
//
// What this answers, and what it deliberately does NOT:
//   ANSWERS: "over the next N days, what High and Low will price reach, and how
//            often does a band like this actually contain them?"
//   DOES NOT: say whether price ends up or down. Direction at a daily horizon
//            measured 49.5% on correctly-graded ledger rows, i.e. a coin flip.
//            A 70% directional claim would require explaining 34.5% of daily
//            return variance; the best published figure anywhere is 0.40%.
//
// Why range IS predictable when direction isn't: volatility clusters. Calm days
// follow calm days, wild days follow wild days. That autocorrelation is strong
// and stable, which is why an 80% band calibrates to 80.0% realized.
//
// Sigma comes from the high-low RANGE (Parkinson), not close-to-close, because
// it uses the intraday extremes and is ~5x more efficient on the same bar count.
//
// The z multiplier is LOADED FROM CALIBRATION, never assumed. Returns have fat
// tails, so the normal-theory z for 80% (1.28) is far too narrow; the measured
// values run 1.66-2.09 depending on volatility tier. Assuming normality here is
// exactly how the app became overconfident the first time.
//
// Replaces js/multi-horizon.js, which multiplied expected move by the signal's
// direction and by a hand-picked 0.5-1.5 confidence multiplier. Both were
// unfounded; see git history.

const CAL_URL = 'model/band_calibration.json';
const VOL_LOOKBACK = 30;

let _cal = null;
let _calPromise = null;

/** Fallback used only if the calibration file is missing or malformed. Marked so
 *  the UI can badge the band as uncalibrated rather than silently pretending. */
const FALLBACK = {
    targetConfidence: 0.80,
    volLookbackDays: VOL_LOOKBACK,
    horizons: [1, 2, 3, 4, 5, 6, 7],
    tierEdges: [[0, 0.015, 'calm'], [0.015, 0.025, 'normal'],
                [0.025, 0.040, 'active'], [0.040, 9.99, 'wild']],
    z: null,
    _fallback: true,
};

export async function loadBandCalibration() {
    if (_cal) return _cal;
    if (_calPromise) return _calPromise;
    _calPromise = (async () => {
        try {
            const r = await fetch(CAL_URL, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            if (!j || !j.z || typeof j.targetConfidence !== 'number') {
                throw new Error('malformed calibration');
            }
            _cal = j;
        } catch (_) {
            // Fail visibly-degraded, not silently-wrong: without z we cannot
            // honestly claim a confidence, so callers get calibrated:false.
            _cal = FALLBACK;
        }
        return _cal;
    })();
    return _calPromise;
}

// Data-quality gates. MUST stay identical to tools/calibrate_bands.py, or the
// browser will size bands with a different sigma than the one the z values were
// solved against. tools/band_sync_check.py enforces that.
//
// These exist because the live ledger surfaced symbols printing high == low on 60
// of 60 days: Parkinson collapses to 0.00%, the tier lookup says "calm", and the
// band comes out near zero width. AUVI read 0.00% sigma while its true
// close-to-close volatility was 14.3% per day. Measured effect on real ledger
// rows: day-1 coverage 70.0% -> 75.9%, calm tier 56.7% -> 80.5%.
const MIN_PRICE = 0.01;
const MAX_SIGMA = 0.50;
const MIN_LIVE_BARS = 20;

/** Daily sigma over the last n candles, robust to untraded days.
 *
 *  Parkinson (high-low) is ~5x more efficient than close-to-close WHEN the asset
 *  trades continuously: sigma^2 = mean(ln(H/L)^2) / (4 ln 2). On a thin name that
 *  prints high == low it collapses toward zero, understating risk exactly where
 *  risk is highest. Close-to-close cannot be hidden that way. max() of the two
 *  never understates while keeping Parkinson's efficiency on liquid names.
 */
export function rangeSigma(candles, n = VOL_LOOKBACK) {
    if (!Array.isArray(candles) || candles.length < Math.ceil(n * 0.7)) return null;
    const tail = candles.slice(-n);

    let live = 0;
    const sq = [];
    for (const c of tail) {
        const h = c.high ?? c.h;
        const l = c.low ?? c.l;
        if (!(h > 0) || !(l > 0) || h < l) continue;
        if (h > l * 1.0000001) live++;
        sq.push(Math.log(h / l) ** 2);
    }
    if (sq.length < Math.ceil(n * 0.7)) return null;

    let pk = 0;
    if (live >= MIN_LIVE_BARS) {
        pk = Math.sqrt((sq.reduce((a, b) => a + b, 0) / sq.length) / (4 * Math.LN2));
    }

    const rets = [];
    for (let i = 1; i < tail.length; i++) {
        const c0 = tail[i - 1].close ?? tail[i - 1].c;
        const c1 = tail[i].close ?? tail[i].c;
        if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
    }
    let cc = 0;
    if (rets.length > 5) {
        const m = rets.reduce((a, b) => a + b, 0) / rets.length;
        // Sample standard deviation (n-1), matching Python's statistics.stdev.
        cc = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
    }

    const s = Math.max(pk, cc);
    return Number.isFinite(s) && s > 0 && s <= MAX_SIGMA ? s : null;
}

function tierFor(sigma, tierEdges) {
    for (const [lo, hi, name] of tierEdges) {
        if (sigma >= lo && sigma < hi) return name;
    }
    return tierEdges[tierEdges.length - 1][2];
}

/** Calendar dates for the next n sessions. Weekends are skipped for equities;
 *  crypto trades every day. Holidays are not modelled, so a label can be one
 *  session optimistic around a market holiday. Labels only: the forecast itself
 *  is indexed by session count, not by date. */
function forwardDates(n, { cryptoMode = false, from = null } = {}) {
    const out = [];
    const d = from ? new Date(from) : new Date();
    while (out.length < n) {
        d.setDate(d.getDate() + 1);
        const day = d.getDay();
        if (!cryptoMode && (day === 0 || day === 6)) continue;
        out.push(new Date(d));
    }
    return out;
}

/**
 * Build the 7-day band forecast.
 *
 * @param {Object} args
 *   - candles: [{high, low, close}, ...] oldest-first, >= VOL_LOOKBACK bars
 *   - currentPrice: number
 *   - cryptoMode: boolean (7 calendar days vs 7 weekday sessions)
 *   - mode: 'perDay' (default) | 'cumulative'
 *       perDay     = day h's OWN session High/Low. This is what the UI shows,
 *                    because "what will Thursday look like" is the question a
 *                    per-day row is asking.
 *       cumulative = the most extreme High/Low reached anywhere within h days.
 *                    Wider, and the correct basis for a STOP, since a stop can be
 *                    taken out on any day of the hold. js/risk.js uses this.
 *       Identical at h = 1, since a one-day window is one day.
 *   - now: Date | null (injectable for deterministic tests)
 * @returns {Object|null} { calibrated, confidence, sigmaDaily, volTier, days: [...] }
 *   days[i] = { day, date, low, high, widthPct, confidence }
 */
export function forecastBands({ candles, currentPrice, cryptoMode = false,
                                mode = 'perDay', now = null }) {
    const cal = _cal || FALLBACK;
    const price = Number(currentPrice);
    if (!(price > 0)) return null;

    const sigma = rangeSigma(candles, cal.volLookbackDays || VOL_LOOKBACK);
    if (!sigma) return null;

    const tier = tierFor(sigma, cal.tierEdges || FALLBACK.tierEdges);
    const horizons = cal.horizons || FALLBACK.horizons;
    const dates = forwardDates(horizons.length, { cryptoMode, from: now });

    // perDay is the display default; cumulative is what stops are sized from.
    const zTable = mode === 'cumulative' ? cal.z : (cal.zPerDay || cal.z);
    const days = horizons.map((h, i) => {
        // z from calibration when available. Without it we cannot state a
        // confidence, so the band is returned but flagged uncalibrated.
        const z = zTable?.[tier]?.[String(h)] ?? null;
        const zz = z ?? 1.96;   // placeholder ONLY for the uncalibrated path
        const move = zz * sigma * Math.sqrt(h);
        const high = price * Math.exp(move);
        const low = price * Math.exp(-move);
        return {
            day: h,
            date: dates[i].toISOString().slice(0, 10),
            low: +low.toFixed(low < 1 ? 4 : 2),
            high: +high.toFixed(high < 1 ? 4 : 2),
            widthPct: +((high / price - 1) * 100).toFixed(2),
            confidence: z === null ? null : Math.round(cal.targetConfidence * 100),
        };
    });

    return {
        calibrated: !!zTable?.[tier] && !cal._fallback,
        mode,
        confidence: Math.round((cal.targetConfidence ?? 0.8) * 100),
        sigmaDaily: +(sigma * 100).toFixed(2),
        volTier: tier,
        generatedFrom: cal.generatedAt || null,
        days,
    };
}
