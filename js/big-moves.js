// Big-move odds for the next session, the measured question behind Spikers.
//
// Spikers used to rank a live screen by the engine's direction call and show an up target with a
// coin-flip confidence ("DOCN ▲ $127.48 (+15%) · 49% conf ✓"). Nothing about that number was
// measured. What IS measured is how likely a stock is to make a move at least twice its normal
// day, either way, in the next session: spike_odds.py, published nightly for the liquid US
// universe in model/vol_forecasts.json (spk = the probability, spkMove = that stock's threshold),
// walk-forward AUC 0.70, calibrated bucket by bucket, graded every night in model/spike_record.json.
// Direction is not predicted, because nothing measured predicts it.

import { loadVolSlice } from './vol-forecast.js';
import { nextSessionAfter } from './earnings-calendar-slice.js';

let _rec = null;
async function loadRecord() {
    if (_rec !== null) return _rec || null;
    try {
        const r = await fetch('model/spike_record.json', { cache: 'no-cache' });
        _rec = r.ok ? await r.json() : false;
    } catch (_) { _rec = false; }
    return _rec || null;
}

/**
 * @returns {Promise<null|{madeAfter, session, rows, backtest, buckets, live, pending}>}
 *   rows: [{ symbol, p, move, earnings, liquid }], highest odds first.
 */
export async function loadBigMoves() {
    const [slice, rec] = await Promise.all([loadVolSlice().catch(() => null), loadRecord()]);
    const f = slice?.forecasts;
    if (!f || !slice.sessionDate) return null;
    const rows = Object.entries(f)
        .filter(([, v]) => Number.isFinite(v?.spk) && Number.isFinite(v?.spkMove))
        .map(([symbol, v]) => ({ symbol, p: v.spk, move: v.spkMove, earnings: v.e === 1, earningsKnown: v.e === 0 || v.e === 1, liquid: v.liq === 1 }))
        .sort((a, b) => b.p - a.p);
    let session = null;
    try { session = nextSessionAfter('NYSE', slice.sessionDate); } catch (_) { session = null; }
    return {
        madeAfter: slice.sessionDate, session, rows,
        backtest: rec?.backtest?.walkForward || null,
        // Held out only: `buckets` is the calibration fitted on the same rows (equal to its own
        // predictions by construction), so it says nothing about how good the odds are.
        buckets: rec?.backtest?.bucketsHeldOut || null,
        live: rec?.overall || null, liveSince: rec?.since || null, pending: rec?.pending ?? null,
    };
}

/** The calibration bucket a probability falls in, with what actually happened there. */
export function bucketFor(buckets, p) {
    return (buckets || []).find(b => p >= b.lo && p < b.hi) || null;
}
