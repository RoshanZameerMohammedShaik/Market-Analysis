// Tracks every prediction the user is shown and resolves its outcome
// against subsequent prices. Persists to localStorage so the user's
// running accuracy survives across sessions.
//
// This is intentionally a separate module from calibration.js. Calibration
// uses BACKTEST data (the developer's measurement). Outcome tracker uses
// LIVE data (this user's actual experience). Both numbers shown side by
// side gives the user trust without us doing any cherry-picking.

const STORAGE_KEY = 'ma-prediction-log';
const MAX_LOG_SIZE = 1000; // ring buffer

// How many bars after the prediction to wait before resolving.
// 'today' means the next bar; 'tomorrow' means 2 bars out.
const HORIZON_BARS = { today: 1, tomorrow: 2 };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function loadLog() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function saveLog(log) {
    try {
        const trimmed = log.length > MAX_LOG_SIZE ? log.slice(-MAX_LOG_SIZE) : log;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_) { /* quota / disabled */ }
}

/**
 * Record a prediction the moment the user sees it.
 */
export function logPrediction({ mode, symbol, signal, confidence, price, timeframe }) {
    if (!symbol || !signal || price == null) return;
    if (signal === 'NEUTRAL') return; // nothing to score
    const log = loadLog();
    log.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        mode,
        symbol,
        signal,
        confidence,
        priceAtPrediction: price,
        timeframe,
        resolved: false,
    });
    saveLog(log);
}

/**
 * Resolve any pending predictions for `symbol` whose horizon has passed,
 * given the latest known price.
 */
export function resolvePending(symbol, latestPrice) {
    if (!symbol || latestPrice == null) return;
    const log = loadLog();
    const now = Date.now();
    let changed = false;

    for (const p of log) {
        if (p.resolved || p.symbol !== symbol) continue;
        const horizonDays = HORIZON_BARS[p.timeframe] || 1;
        const elapsedDays = (now - p.ts) / MS_PER_DAY;
        if (elapsedDays < horizonDays) continue;

        const movedUp = latestPrice > p.priceAtPrediction;
        const correct = (p.signal === 'BUY' && movedUp) || (p.signal === 'SELL' && !movedUp);
        p.resolved = true;
        p.resolvedAt = now;
        p.priceAtResolve = latestPrice;
        p.correct = correct;
        changed = true;
    }
    if (changed) saveLog(log);
}

/**
 * Get summary stats for display.
 */
export function getStats() {
    const log = loadLog();
    const resolved = log.filter(p => p.resolved);
    const total = resolved.length;
    const hits = resolved.filter(p => p.correct).length;

    // Per-confidence-bucket breakdown.
    const buckets = {};
    for (let lo = 40; lo < 100; lo += 10) {
        buckets[`${lo}-${lo + 10}%`] = { total: 0, hits: 0, predicted: 0 };
    }
    for (const p of resolved) {
        const lo = Math.min(90, Math.max(40, Math.floor(p.confidence / 10) * 10));
        const key = `${lo}-${lo + 10}%`;
        buckets[key].total++;
        buckets[key].predicted += p.confidence;
        if (p.correct) buckets[key].hits++;
    }
    const breakdown = Object.entries(buckets)
        .filter(([_, v]) => v.total > 0)
        .map(([bucket, v]) => ({
            bucket,
            count: v.total,
            predicted: Math.round(v.predicted / v.total),
            actual: Math.round((v.hits / v.total) * 100),
        }));

    return {
        total,
        hits,
        hitRate: total > 0 ? Math.round((hits / total) * 100) : null,
        pending: log.length - total,
        breakdown,
    };
}

export function clearLog() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* */ }
}
