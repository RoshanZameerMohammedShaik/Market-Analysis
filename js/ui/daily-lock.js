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
import { sessionAnchorFromCandles, minutesAfterOpen, isAtOpen } from './market-session.js';

const LS_KEY = 'ma-daily-locks-v1';

// WHY THE KEY IS THE SESSION DATE, NOT THE UTC DATE
// -------------------------------------------------
// This used to key and expire locks on `new Date().toISOString().slice(0,10)`, the
// UTC calendar date. That is the wrong clock for every market on earth: it rolls
// over at 00:00 UTC, which is 8pm in New York (mid-session-gap), 5:30am in Mumbai
// (pre-open) and 9am in Tokyo (exactly at the open, by luck). So a NYSE lock
// silently expired in the middle of the evening and a fresh one was taken against
// whatever price was showing.
//
// Roshan's requirement is that the lock resets at the MARKET's open, which differs
// per region. The session anchor (ui/market-session.js) reads that open straight
// off the daily bar, so keying on anchor.sessionDate makes the lock roll over
// exactly when the market opens, per market, with holidays and DST handled by the
// data rather than by a calendar we would have to maintain.
//
// When no anchor is available (an intraday-only series, a failed fetch) we fall
// back to the UTC date. That keeps the old behaviour for the one case where we
// genuinely cannot know the session, instead of refusing to lock at all.
function fallbackDate() { return new Date().toISOString().slice(0, 10); }
function sessionKeyOf(anchor) { return anchor?.sessionDate || fallbackDate(); }

function loadAll() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
}
function saveAll(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (_) {}
}

// Drop locks that don't belong to the symbol's CURRENT session so the store
// doesn't grow unbounded. Each symbol carries its own session date now (NYSE and
// Tokyo roll over hours apart), so a single global "today" can't decide this --
// pruning only ever removes records older than the newest session seen for that
// symbol, plus anything older than two calendar days as a hard backstop.
function prune(map) {
    const cutoff = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    let changed = false;
    for (const k of Object.keys(map)) {
        if (!map[k]?.date || map[k].date < cutoff) { delete map[k]; changed = true; }
    }
    if (changed) saveAll(map);
    return map;
}

function keyFor(symbol) { return String(symbol || '').toUpperCase(); }

// Return the locked call for a symbol's current session, or null.
// `anchor` decides which session that is; without one we fall back to UTC date.
export function getLockedCall(symbol, anchor = null) {
    if (!symbol) return null;
    const map = prune(loadAll());
    const rec = map[keyFor(symbol)];
    return rec && rec.date === sessionKeyOf(anchor) ? rec : null;
}

// Lock the call for a symbol the FIRST time it's computed in the current SESSION.
// If a lock already exists for that session this is a no-op (the call holds).
//
// The record keeps two timestamps on purpose, because they answer different
// questions and collapsing them into one is what produced the "locked 11:58 AM
// when you opened it" complaint:
//
//   openedAt -- when this market's session opened. The baseline everyone shares.
//   calledAt -- when this browser actually computed the call. Ours alone.
//
// `entry` is the session's OPENING price when we know it, not the price at the
// moment of the visit, so the percentage moves the card reports are measured from
// the same place for every viewer. The predicted band is re-centred onto that open
// price, preserving the engine's predicted MOVE (its width) while moving its
// anchor -- a band centred on the 11:58 price but labelled against the open entry
// would make computeStatus compare two different baselines.
export function lockCall(symbol, prediction, anchor = null) {
    if (!symbol || !prediction || !prediction.signal) return null;
    const map = prune(loadAll());
    const k = keyFor(symbol);
    const sessionDate = sessionKeyOf(anchor);
    if (map[k] && map[k].date === sessionDate) return map[k];   // already locked this session

    const t = prediction.priceTargets || {};
    const visitPrice = Number.isFinite(t.currentPrice) ? t.currentPrice : null;
    const openPrice = Number.isFinite(anchor?.openPrice) ? anchor.openPrice : null;
    const entry = openPrice ?? visitPrice;

    // Shift = how far to slide the band so it sits on the open instead of the
    // visit price. Zero when we have no open price (nothing to re-centre onto).
    const shift = (openPrice != null && visitPrice != null) ? (openPrice - visitPrice) : 0;
    const slide = (v) => (Number.isFinite(v) ? +(v + shift).toFixed(6) : null);

    map[k] = {
        date: sessionDate,
        // lockedAt is what the UI displays as the baseline moment. It is the
        // session open when we know it, which is the whole point of the fix.
        lockedAt: anchor?.openedAt || new Date().toISOString(),
        openedAt: anchor?.openedAt || null,
        calledAt: new Date().toISOString(),
        openAnchored: openPrice != null,
        signal: prediction.signal,
        confidence: prediction.confidence,
        entry,
        predictedHigh: slide(t.predictedHigh),
        predictedLow: slide(t.predictedLow),
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
    // The session anchor comes from the daily bar the engine already fetched, so
    // this costs nothing. It decides which session we are in (and therefore when
    // the lock resets) and supplies the open price both paths measure from.
    const anchor = livePrediction?.sessionAnchor
        || sessionAnchorFromCandles(livePrediction?.candles)
        || null;
    try {
        const led = await readTodayLock(symbol, anchor);
        if (led) {
            // Ledger has no currency column; inherit it from the live view so
            // the card formats the locked prices in the symbol's native unit.
            led.currency = (livePrediction && livePrediction.currency) || led.currency || 'USD';
            // Attach the anchor and how late the cron actually was. The row's own
            // predictedAt stays untouched -- it is the truth about when the call
            // was made, and overwriting it with the open would be a fresh lie
            // (the row's entry and features are both from the moment it ran, so
            // claiming the open as its timestamp would misdescribe the baseline).
            // The UI uses lateMinutes to say which of the two it is looking at.
            led.openedAt = anchor?.openedAt || null;
            led.openPrice = Number.isFinite(anchor?.openPrice) ? anchor.openPrice : null;
            led.lateMinutes = minutesAfterOpen(led.lockedAt, anchor);
            led.atOpen = isAtOpen(led.lockedAt, anchor);
            return led;
        }
    } catch (_) { /* fall through to the local session lock */ }
    // Fallback: this browser's own first call of the session. Now anchored to the
    // session open price and timestamp rather than the moment of the page visit.
    if (livePrediction && livePrediction.signal) lockCall(symbol, livePrediction, anchor);
    const local = getLockedCall(symbol, anchor);
    if (local && !local.source) local.source = 'local';
    if (local) {
        local.openPrice = Number.isFinite(anchor?.openPrice) ? anchor.openPrice : null;
        // A local lock is open-anchored in its BASELINE (entry + timestamp) but the
        // signal itself was computed whenever this browser first looked. atOpen
        // describes the baseline; the UI must not present the call as the engine's
        // pre-session commitment, which is what `source: 'local'` is for.
        local.atOpen = !!local.openAnchored;
        local.lateMinutes = minutesAfterOpen(local.calledAt, anchor);
    }
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
