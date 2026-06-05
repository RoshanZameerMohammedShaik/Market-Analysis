// Today's locked call + live status.
//
// The problem this solves: the engine recomputes on every refresh, so the
// on-screen signal/confidence/targets drifted minute-to-minute — which
// reads as "no conviction" and is confusing ("which number do I act on?").
//
// The fix (designed with Roshan): there is ONE prediction per symbol per
// day — the FIRST one computed today — and it HOLDS. Subsequent recomputes
// don't replace it; instead the live price drives a STATUS of that locked
// call (on-track / target-reached / stopped / reversed). One number to
// act on, plus an honest read of how it's playing out — never a second
// competing prediction.
//
// Locked calls live in localStorage keyed by symbol+date, so they survive
// reloads within the day and auto-expire when the date rolls over.

const LS_KEY = 'ma-daily-locks-v1';

function todayIso() { return new Date().toISOString().slice(0, 10); }

function loadAll() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
}
function saveAll(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (_) {}
}

// Prune locks from previous days so the store doesn't grow unbounded.
function prune(map) {
    const today = todayIso();
    let changed = false;
    for (const k of Object.keys(map)) {
        if (map[k]?.date !== today) { delete map[k]; changed = true; }
    }
    if (changed) saveAll(map);
    return map;
}

function keyFor(symbol) { return String(symbol || '').toUpperCase(); }

// Return today's locked call for a symbol, or null. Auto-prunes stale days.
export function getLockedCall(symbol) {
    if (!symbol) return null;
    const map = prune(loadAll());
    const rec = map[keyFor(symbol)];
    return rec && rec.date === todayIso() ? rec : null;
}

// Lock today's call for a symbol the FIRST time it's computed today. If a
// lock already exists for today, this is a no-op (the call holds). Stores
// only the decision-relevant fields. Returns the locked record (existing
// or newly created).
export function lockCall(symbol, prediction) {
    if (!symbol || !prediction || !prediction.signal) return null;
    const map = prune(loadAll());
    const k = keyFor(symbol);
    if (map[k] && map[k].date === todayIso()) return map[k];   // already locked today
    const t = prediction.priceTargets || {};
    map[k] = {
        date: todayIso(),
        lockedAt: new Date().toISOString(),
        signal: prediction.signal,
        confidence: prediction.confidence,
        entry: t.currentPrice ?? null,
        predictedHigh: t.predictedHigh ?? null,
        predictedLow: t.predictedLow ?? null,
        currency: prediction.currency || 'USD',
    };
    saveAll(map);
    return map[k];
}

// Compute the live STATUS of a locked call given the current price.
// Returns { key, label, detail, tone } where tone ∈ 'good'|'bad'|'neutral'.
//   - target-reached: price hit the locked target in the called direction
//   - stopped: price crossed past the locked downside (opposite extreme)
//   - reversed: price moved meaningfully against the call (but not stopped)
//   - on-track: moving the called way, target not yet reached
//   - flat: little movement since the lock
// For NEUTRAL/AVOID calls there's no directional target, so we just report
// drift from entry.
export function computeStatus(locked, livePrice) {
    if (!locked || !Number.isFinite(livePrice) || !Number.isFinite(locked.entry)) return null;
    const { signal, entry, predictedHigh, predictedLow } = locked;
    const movePct = ((livePrice - entry) / entry) * 100;
    const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

    if (signal === 'BUY') {
        if (predictedHigh != null && livePrice >= predictedHigh) {
            return { key: 'target-reached', label: '🎯 Target reached', detail: `Now ${fmtPct(movePct)} since the call — hit the predicted high.`, tone: 'good' };
        }
        if (predictedLow != null && livePrice <= predictedLow) {
            return { key: 'stopped', label: '⚠ Stopped out', detail: `Dropped to the predicted low (${fmtPct(movePct)}). The setup didn't hold.`, tone: 'bad' };
        }
        if (movePct <= -1) return { key: 'reversed', label: '↘ Moving against the call', detail: `Down ${fmtPct(movePct)} since the call — watch closely.`, tone: 'bad' };
        if (movePct >= 0.3) return { key: 'on-track', label: '↗ On track', detail: `Up ${fmtPct(movePct)} toward the target.`, tone: 'good' };
        return { key: 'flat', label: '● Holding', detail: `${fmtPct(movePct)} since the call — little movement yet.`, tone: 'neutral' };
    }
    if (signal === 'SELL') {
        if (predictedLow != null && livePrice <= predictedLow) {
            return { key: 'target-reached', label: '🎯 Target reached', detail: `Now ${fmtPct(movePct)} since the call — hit the predicted low.`, tone: 'good' };
        }
        if (predictedHigh != null && livePrice >= predictedHigh) {
            return { key: 'stopped', label: '⚠ Stopped out', detail: `Rose to the predicted high (${fmtPct(movePct)}). The short setup didn't hold.`, tone: 'bad' };
        }
        if (movePct >= 1) return { key: 'reversed', label: '↗ Moving against the call', detail: `Up ${fmtPct(movePct)} since the call — watch closely.`, tone: 'bad' };
        if (movePct <= -0.3) return { key: 'on-track', label: '↘ On track', detail: `Down ${fmtPct(movePct)} toward the target.`, tone: 'good' };
        return { key: 'flat', label: '● Holding', detail: `${fmtPct(movePct)} since the call — little movement yet.`, tone: 'neutral' };
    }
    // NEUTRAL / NO_TRADE — no directional target; just report drift.
    return { key: 'flat', label: '● No directional call', detail: `${fmtPct(movePct)} since open — engine sat this one out today.`, tone: 'neutral' };
}
