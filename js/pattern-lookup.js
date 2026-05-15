// Failed-setup lookup. backtest.py emits pattern_hit_rates keyed by a
// compact setup encoding (rsi bucket, macd state, BB state, signal, tier).
// At inference, we encode the current setup the same way and look up its
// historical hit rate.
//
// Catches edge-case combos that the linear engine doesn't penalize:
// e.g. "BUY + RSI 55-65 + MACD positive + tier=penny" might historically
// hit 38%; engine says 65% confidence; lookup caps to 55 and adds a warn.

let patternMap = null;
let status = 'unloaded';

export async function loadPatterns() {
    if (status !== 'unloaded') return patternMap;
    try {
        const res = await fetch('./model/backtest_results.json');
        if (!res.ok) { status = 'unavailable'; return null; }
        const data = await res.json();
        patternMap = data?.overall?.pattern_hit_rates || null;
        status = patternMap ? 'loaded' : 'unavailable';
        return patternMap;
    } catch (_) { status = 'unavailable'; return null; }
}

export function getPatternStatus() { return status; }

function rsiBucket(rsi) {
    if (rsi == null) return 'X';
    if (rsi < 30) return 'OS';
    if (rsi < 45) return 'L';
    if (rsi < 55) return 'M';
    if (rsi < 70) return 'H';
    return 'OB';
}

function macdState(macd) {
    if (!macd) return 'X';
    if (macd.crossover) return 'XU';
    if (macd.crossunder) return 'XD';
    if (macd.histogram > 0) return 'P';
    if (macd.histogram < 0) return 'N';
    return 'F';
}

function bbState(bb) {
    if (!bb) return 'X';
    const pb = bb.percentB;
    if (pb < 0) return 'B';     // below lower band
    if (pb < 0.2) return 'L';
    if (pb > 1) return 'A';     // above upper band
    if (pb > 0.8) return 'H';
    return 'M';
}

/**
 * Stable, compact pattern key. Must match the Python encoder in backtest.py.
 * Format: SIGNAL|rsi|macd|bb|tier
 */
export function encodePattern({ signal, indicators, tier }) {
    const i = indicators || {};
    return [
        signal || 'X',
        rsiBucket(i.rsi),
        macdState(i.macd),
        bbState(i.bb),
        tier || 'X',
    ].join('|');
}

/**
 * Apply pattern lookup. Returns { adjust, cap, reason } or { adjust:0 } if no match.
 *   - n>=30 + hit_rate < 0.50: cap confidence at 55, warn
 *   - n>=30 + hit_rate > 0.60: +3 boost, confirm
 */
export function patternAdjustment(pattern) {
    if (!patternMap || !pattern) return { adjust: 0 };
    const entry = patternMap[pattern];
    if (!entry || entry.n < 30) return { adjust: 0 };
    const hr = entry.hit_rate;
    if (hr < 0.50) {
        return { adjust: 0, cap: 55, reason: `Setup historically weak — ${(hr * 100).toFixed(0)}% hit rate over ${entry.n} similar bars` };
    }
    if (hr > 0.60) {
        return { adjust: 3, reason: `Setup historically strong — ${(hr * 100).toFixed(0)}% hit rate over ${entry.n} similar bars` };
    }
    return { adjust: 0 };
}
