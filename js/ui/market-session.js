// Which trading session are we in, and when did it open?
//
// THE BUG THIS EXISTS TO FIX
// -------------------------
// The daily lock is supposed to be the engine's ONE committed call per session,
// anchored to the market open so every viewer sees the same baseline. It wasn't.
// Two things were wrong and both produced the same visible symptom -- a lock
// stamped with the time the user happened to open the page:
//
//   1. The ledger row's `lockedAt` was `predictedAt`, i.e. the moment the GitHub
//      cron got around to running. On 2026-09-10 the NYSE cron was scheduled for
//      13:35Z, ran at 17:08Z, and stamped the row 17:10Z -- 3h40m after the 13:30Z
//      open. The tooltip still claimed "locked at this market's open".
//   2. For those 3h40m there was no row at all, so getEffectiveLock fell back to
//      a visit-time lock: `lockedAt: new Date()`, `entry: price right now`. Two
//      users looking at the same symbol got different baselines.
//
// Roshan's requirement, verbatim: "it should lock it at the opening time of market
// which can differ for stocks based on their region or market hours."
//
// WHY THE DAILY BAR IS THE ANCHOR (AND A CALENDAR IS NOT)
// ------------------------------------------------------
// bot/sessions.py carries a per-market table of open times and resolves DST with
// zoneinfo. Mirroring that table here was the obvious move, and it would be wrong
// in a way that is hard to see: a table knows when a market is SCHEDULED to open,
// not when it actually did. Holidays, half-days, unscheduled closures and Yahoo
// outages all break it, and each one would silently produce a lock anchored to a
// session that never happened.
//
// Yahoo's own daily bar already answers the question exactly. For interval=1d the
// bar's timestamp IS the session open instant and its `open` IS the session open
// price, per instrument, with DST, holidays and regional hours already applied.
// Verified live against four exchanges on 2026-09-10:
//
//   AAPL         bar.time = 13:30Z   open = 316.79    (New York, 09:30 EDT)
//   RELIANCE.NS  bar.time = 03:45Z   open = 1278.50   (Mumbai,   09:15 IST)
//   7203.T       bar.time = 00:00Z   open = 2960.00   (Tokyo,    09:00 JST)
//   BTC-USD      bar.time = 00:00Z   open = 78291.64  (24/7, UTC midnight)
//
// The rollover property falls out for free and is the whole point: Yahoo does not
// create the new daily bar until the session actually opens, so the anchor -- and
// therefore the lock key -- rolls over AT THE OPEN for each market independently.
// No calendar, no timezone table, no holiday list to rot.
//
// One caveat worth stating: this is the open of the session the LAST BAR belongs
// to, which after the close is still that day's session. That is deliberate. The
// day's call stands until the next session opens; it does not evaporate at 4pm.

// data.js drops candles whose close is null, which is how Yahoo represents a bar
// for a session that hasn't traded yet (7203.T shows exactly this the evening
// before Tokyo opens). So a placeholder bar can't become an anchor -- the filter
// upstream already removed it. Re-checking here anyway, because this module must
// not depend on a detail of another module's loop to stay correct.
function isRealBar(c) {
    return c
        && Number.isFinite(c.time) && c.time > 0
        && Number.isFinite(c.open) && c.open > 0
        && Number.isFinite(c.close) && c.close > 0;
}

/**
 * The session anchor for a series of DAILY candles.
 *
 * Returns null rather than guessing when the series can't answer the question --
 * an anchor derived from an intraday series or an empty fetch would be worse than
 * no anchor, because the caller would treat it as authoritative.
 *
 * @param {Array<{time:number,open:number,close:number}>} candles daily bars, oldest first
 * @returns {{openedAtMs:number, openedAt:string, openPrice:number, sessionDate:string}|null}
 */
export function sessionAnchorFromCandles(candles) {
    if (!Array.isArray(candles) || !candles.length) return null;
    // Walk from the end: the newest REAL bar is the current (or most recent) session.
    let bar = null;
    for (let i = candles.length - 1; i >= 0; i--) {
        if (isRealBar(candles[i])) { bar = candles[i]; break; }
    }
    if (!bar) return null;

    // Guard against a non-daily series being passed in. Two consecutive daily bars
    // are >= ~20h apart (Fri->Mon is 72h); 1h or 4h bars are far closer. Without
    // this an intraday series would silently anchor the "market open" to 15:30Z.
    const prev = candles.filter(isRealBar).slice(-2)[0];
    if (prev && prev !== bar) {
        const gapHours = (bar.time - prev.time) / 3600;
        if (gapHours < 20) return null;   // not a daily series
    }

    const openedAtMs = bar.time * 1000;
    return {
        openedAtMs,
        openedAt: new Date(openedAtMs).toISOString(),
        openPrice: bar.open,
        // The UTC date of the open instant. Every market's open lands on its own
        // local calendar day (NYSE 13:30Z, Mumbai 03:45Z, Tokyo 00:00Z all share
        // the local date), so this is a stable per-session key that changes only
        // when a new session opens. It is a KEY, not a date to display.
        sessionDate: new Date(openedAtMs).toISOString().slice(0, 10),
    };
}

/**
 * How far after its session open was this call actually made?
 *
 * The honesty check behind the tooltip. A ledger row written 3h40m late is still
 * a useful call, but presenting it as "locked at the open" is a false claim about
 * a baseline, and this app has already burned its credibility once by pinning a
 * $309.61 figure to an open it wasn't taken at.
 *
 * @returns {number|null} minutes after the open, or null if either side is unknown
 */
export function minutesAfterOpen(lockedAtIso, anchor) {
    if (!anchor || !Number.isFinite(anchor.openedAtMs) || !lockedAtIso) return null;
    const t = Date.parse(lockedAtIso);
    if (!Number.isFinite(t)) return null;
    return Math.round((t - anchor.openedAtMs) / 60000);
}

// Inside this window a call is "at the open" for display purposes. 20 minutes is
// chosen to cover the cron's own runtime: a region run walks hundreds of symbols
// sequentially, so the last symbol's predictedAt is legitimately minutes after
// the first even when the run started on time.
export const AT_OPEN_TOLERANCE_MIN = 20;

/** Was this call taken at (or acceptably near) the session open? */
export function isAtOpen(lockedAtIso, anchor) {
    const m = minutesAfterOpen(lockedAtIso, anchor);
    if (m == null) return false;
    // Negative means the call predates the bar -- a pre-market snapshot. That is
    // still an open-anchored commitment, so allow a little slack on that side.
    return m >= -AT_OPEN_TOLERANCE_MIN && m <= AT_OPEN_TOLERANCE_MIN;
}
