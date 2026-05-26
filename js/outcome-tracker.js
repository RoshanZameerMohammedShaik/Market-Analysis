// Tracks every prediction the user is shown and resolves its outcome
// against subsequent prices. Persists to localStorage so the user's
// running accuracy survives across sessions.
//
// Now also captures source breakdown so source-attribution.js can
// compute rolling per-source hit rates and shift weights toward the
// sources that have actually been working in the current regime.

const STORAGE_KEY = 'ma-prediction-log';
const MAX_LOG_SIZE = 1000;

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
 * `breakdown` (optional) shape: { ai: {score, weight}, technical: {...},
 *                                 sentiment: {...}, market: {...} }
 */
export function logPrediction({ mode, symbol, signal, confidence, price, timeframe, breakdown }) {
    if (!symbol || !signal || price == null) return;
    // NEUTRAL and NO_TRADE are non-directional — there's nothing to score
    // against, so we don't log them. NO_TRADE is the engine deliberately
    // abstaining; NEUTRAL is "trend is flat".
    if (signal === 'NEUTRAL' || signal === 'NO_TRADE') return;
    const log = loadLog();

    // Compute dominant source: which source contributed most to the score?
    let dominantSource = null;
    if (breakdown) {
        const contribs = ['ai', 'technical', 'sentiment', 'market']
            .filter(k => breakdown[k] && (breakdown[k].available !== false))
            .map(k => ({ k, c: (breakdown[k].score || 50) * (breakdown[k].weight || 0) }));
        if (contribs.length) {
            contribs.sort((a, b) => b.c - a.c);
            dominantSource = contribs[0].k;
        }
    }

    log.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        mode, symbol, signal, confidence,
        priceAtPrediction: price,
        timeframe,
        breakdown: breakdown
            ? Object.fromEntries(['ai', 'technical', 'sentiment', 'market'].map(k => [k, breakdown[k] ? { score: breakdown[k].score, weight: breakdown[k].weight, available: breakdown[k].available !== false } : null]))
            : null,
        dominantSource,
        resolved: false,
    });
    saveLog(log);
}

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

export function getStats() {
    const log = loadLog();
    const resolved = log.filter(p => p.resolved);
    const total = resolved.length;
    const hits = resolved.filter(p => p.correct).length;

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

/**
 * Per-source rolling hit rate over the last `windowSize` resolved
 * outcomes. Returns null when fewer than `min` resolved samples exist.
 * Used by source-attribution.js to nudge weights.
 */
export function getSourceAccuracy({ windowSize = 30, min = 15 } = {}) {
    const log = loadLog();
    const resolved = log.filter(p => p.resolved && p.dominantSource).slice(-windowSize);
    if (resolved.length < min) return null;

    const counts = { ai: { hits: 0, total: 0 }, technical: { hits: 0, total: 0 }, sentiment: { hits: 0, total: 0 }, market: { hits: 0, total: 0 } };
    for (const p of resolved) {
        const src = p.dominantSource;
        if (!counts[src]) continue;
        counts[src].total++;
        if (p.correct) counts[src].hits++;
    }
    const out = {};
    for (const [src, v] of Object.entries(counts)) {
        if (v.total >= 5) out[src] = { n: v.total, hitRate: v.hits / v.total };
    }
    return Object.keys(out).length ? out : null;
}

export function clearLog() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* */ }
}
