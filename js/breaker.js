// Single-source-of-truth circuit breaker.
//
// Pattern: each external endpoint that has a track record of being
// unreliable (HF Inference, Google News, Reddit, StockTwits, Yahoo
// crumb-walled paths) gets a named breaker. On first failure within
// the failure window, the breaker trips and short-circuits subsequent
// calls for the cooldown duration. After cooldown, it tries again —
// if it succeeds, the failure window resets; if it fails, cooldown
// extends.
//
// Why threshold = 1 (was 2 in earlier per-module versions): when
// hot-picks scans 12 symbols in parallel, each kicks off an
// independent call. With threshold 2, the first 12 calls all fly
// before breaker has a chance to trip; we see 12 failed cascades
// where 1 would have been enough to learn the upstream is dead.
// Threshold 1 + a "probe" retry at end of cooldown gives the same
// recovery semantics with vastly less noise.

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

const breakers = new Map(); // name → { failuresInWindow: ts[], cooldownUntil }

function getOrCreate(name) {
    let b = breakers.get(name);
    if (!b) {
        b = { failuresInWindow: [], cooldownUntil: 0 };
        breakers.set(name, b);
    }
    return b;
}

/**
 * Returns true if calls under this name should be short-circuited.
 * Use BEFORE making the network call.
 *
 * @example
 *   if (isCooling('hf-finbert')) return null;
 *   const res = await fetch(HF_API_URL, ...);
 */
export function isCooling(name) {
    const b = getOrCreate(name);
    return Date.now() < b.cooldownUntil;
}

/**
 * Record a failure. Threshold 1 means the breaker trips immediately
 * on the first failure within the failure window. After cooldown
 * expires, the next call probes — if it succeeds, recordSuccess
 * resets state; if it fails, the breaker re-cools.
 */
export function recordFailure(name) {
    const b = getOrCreate(name);
    const now = Date.now();
    b.failuresInWindow = b.failuresInWindow.filter(ts => now - ts < FAILURE_WINDOW_MS);
    b.failuresInWindow.push(now);
    if (b.failuresInWindow.length >= 1) {
        b.cooldownUntil = now + COOLDOWN_MS;
        b.failuresInWindow = [];
    }
}

/**
 * Reset the breaker on a successful call. Lets a recovery probe
 * re-open the gate without waiting another full window.
 */
export function recordSuccess(name) {
    const b = breakers.get(name);
    if (!b) return;
    b.failuresInWindow = [];
    b.cooldownUntil = 0;
}

/**
 * Wraps any async fn with the breaker pattern. On cooldown, returns
 * fallback immediately. On call, records success / failure.
 */
export async function withBreaker(name, fn, fallback = null) {
    if (isCooling(name)) return fallback;
    try {
        const result = await fn();
        recordSuccess(name);
        return result;
    } catch (e) {
        recordFailure(name);
        throw e;
    }
}

// Inspect — used by /dev for diagnostic display if we add it later.
export function getBreakerStates() {
    const out = {};
    const now = Date.now();
    for (const [name, b] of breakers) {
        out[name] = {
            cooling: now < b.cooldownUntil,
            cooldownRemainingMs: Math.max(0, b.cooldownUntil - now),
            recentFailures: b.failuresInWindow.length,
        };
    }
    return out;
}

// Expose to window so the debug panel can show it.
if (typeof window !== 'undefined') {
    window.__breakerStates = getBreakerStates;
}
