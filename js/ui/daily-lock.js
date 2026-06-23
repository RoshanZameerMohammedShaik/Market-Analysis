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

import { readTodayLock } from '../ledger-reader.js';

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

// The AUTHORITATIVE daily lock, ledger-first.
//
// The day's locked call should be the engine's OPEN-of-market commitment —
// the row the Python cron wrote at market open with the OPEN price as entry.
// That's what makes "did today's prediction reach its target by close?" an
// honest question: the baseline is the morning open, identical for everyone,
// regardless of when (or whether) the user opened this symbol's page.
//
// Order:
//   1. ledger row for symbol+today (readTodayLock) — open-locked entry,
//      signal, confidence, derived target band. PRIMARY.
//   2. else → the browser visit-time lock (lockCall below). FALLBACK, only
//      for symbols outside the cron universe or before the cron has run for
//      that market today.
//
// `livePrediction` is the current engine output; we use it ONLY on the
// fallback path (to create/read the local visit-lock) and to tag currency on
// the ledger lock (the ledger row doesn't store currency). Returns the same
// record shape from both paths, plus `source` ∈ 'ledger' | 'local'.
export async function getEffectiveLock(symbol, livePrediction) {
    if (!symbol) return null;
    try {
        const led = await readTodayLock(symbol);
        if (led) {
            // Ledger has no currency column; inherit it from the live view so
            // the card formats the locked prices in the symbol's native unit.
            led.currency = (livePrediction && livePrediction.currency) || led.currency || 'USD';
            return led;
        }
    } catch (_) { /* fall through to local visit-lock */ }
    // Fallback: visit-time local lock (the legacy behavior), tagged as such.
    if (livePrediction && livePrediction.signal) lockCall(symbol, livePrediction);
    const local = getLockedCall(symbol);
    if (local && !local.source) local.source = 'local';
    return local;
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
