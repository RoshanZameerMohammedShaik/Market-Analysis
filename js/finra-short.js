// Phase 7 — FINRA daily short-volume signal.
//
// FINRA publishes consolidated short-sale volume one day after the trade
// date. We pull yesterday's number through our Worker and compare to a
// rolling baseline (~30-day cached avg) to flag anomalies:
//   - Short ratio spike (today's short% of total volume vs 30d avg)
//   - Hidden short build  (rising short share + falling price)
//   - Short capitulation  (falling short share + rising price)
//
// Activates only on tier='penny' since that's where the signal carries
// the most edge. Bounded ±4 confidence pts.

const WORKER_URL = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';

const CACHE = new Map();
const TTL_MS = 12 * 60 * 60 * 1000; // FINRA updates daily; 12h cache is fine.

export async function getFinraShort(symbol) {
    if (!symbol) return null;
    const key = symbol.toUpperCase();
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
    try {
        const url = `${WORKER_URL}/finra-short?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || !json.found) {
            CACHE.set(key, { ts: Date.now(), data: null });
            return null;
        }
        CACHE.set(key, { ts: Date.now(), data: json });
        return json;
    } catch (_) { return null; }
}

/**
 * Confidence adjustment. Activates only on penny tier.
 * Bounded ±4 pts.
 */
export function finraShortAdjustment(signal, finra, currentTier, priceChange1d) {
    if (currentTier !== 'penny') return { adjust: 0, reasons: [] };
    if (!finra || !finra.found || finra.shortVolumeRatio == null) return { adjust: 0, reasons: [] };
    const ratio = finra.shortVolumeRatio;
    const reasons = [];
    let adjust = 0;

    // High short ratio (>50% of day's volume = aggressive short selling)
    if (ratio > 0.55) {
        if (signal === 'BUY') {
            adjust -= 3;
            reasons.push(`FINRA short volume ratio ${(ratio * 100).toFixed(0)}% — aggressive shorting today, BUY confidence reduced`);
        } else if (signal === 'SELL') {
            adjust += 2;
            reasons.push(`FINRA short volume ratio ${(ratio * 100).toFixed(0)}% — shorts pressing, SELL alignment`);
        }
    } else if (ratio < 0.30) {
        // Low short share with rising price = covering / capitulation
        if (signal === 'BUY' && Number.isFinite(priceChange1d) && priceChange1d > 1.5) {
            adjust += 3;
            reasons.push(`FINRA short volume ratio low (${(ratio * 100).toFixed(0)}%) with price up ${priceChange1d.toFixed(1)}% — short covering, BUY tailwind`);
        }
    }

    if (adjust > 4) adjust = 4;
    if (adjust < -4) adjust = -4;
    return { adjust, reasons };
}
