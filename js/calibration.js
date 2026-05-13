// Empirical calibration of signal confidence.
//
// The pipeline produces a heuristic 38-88 confidence number. Without
// calibration that number means "how strongly the indicators agreed" —
// it does NOT mean "this prediction will hit X% of the time." That gap
// matters when real money is on the line.
//
// This module loads model/backtest_results.json (produced by backtest.py)
// and remaps raw confidence to empirical hit rate using the
// calibration buckets. When 70%-bucket historically hit 62%, we display
// 62% — truth instead of bravado.

let calibration = null;
let calibrationStatus = 'unloaded'; // 'unloaded' | 'loaded' | 'unavailable'

export async function loadCalibration() {
    if (calibrationStatus !== 'unloaded') return calibration;
    try {
        const res = await fetch('./model/backtest_results.json');
        if (!res.ok) {
            calibrationStatus = 'unavailable';
            return null;
        }
        const data = await res.json();
        calibration = data?.overall?.calibration || null;
        calibrationStatus = calibration ? 'loaded' : 'unavailable';
        return calibration;
    } catch (_) {
        calibrationStatus = 'unavailable';
        return null;
    }
}

export function getCalibrationStatus() {
    return calibrationStatus;
}

/**
 * Map a raw confidence (38-88) to its empirical hit rate.
 * Returns the raw value unchanged if no calibration is available.
 */
export function calibrate(rawConfidence) {
    if (!calibration || calibration.length === 0) return rawConfidence;

    // Find the bucket whose range contains rawConfidence.
    for (const bucket of calibration) {
        const [loStr, hiStr] = bucket.bucket.replace('%', '').split('-');
        const lo = parseInt(loStr, 10);
        const hi = parseInt(hiStr, 10);
        if (rawConfidence >= lo && rawConfidence < hi) {
            return Math.round(bucket.actual);
        }
    }
    // Below or above all buckets: clamp to nearest bucket's actual.
    if (rawConfidence < parseInt(calibration[0].bucket.split('-')[0], 10)) {
        return Math.round(calibration[0].actual);
    }
    return Math.round(calibration[calibration.length - 1].actual);
}

export function getCalibrationCurve() {
    return calibration;
}
