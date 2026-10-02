// Which day of the 7-session band an earnings announcement lands on. Browser mirror of
// earnings_calendar.py; read model/earnings.json, published by tools/write_earnings_slice.py.
//
// The band's z values are fitted separately for windows that contain an earnings reaction,
// because those windows move 1.5-2.7x further (held out on the app's own calibration sample, the
// 80% band covered 55.5% of earnings windows against 80.9% of the rest). This module answers the
// one question that selects between the two families.
//
// THREE STATES, and the difference matters:
//   null  unknown  -> no entry for this symbol; the band uses the pooled z it always used.
//   0     known    -> nothing reacts inside the band. Ordinary-week z.
//   1..7           -> the first band day an announcement moves. Earnings z from there on.
//
// A reaction day is not an announcement date: before the close moves that session, after the
// close moves the next one. Exchange-local, via Intl, so DST needs no table.

const SLICE_URL = 'model/earnings.json';
import { isSession } from './market-sessions.js';

export const BAND_SESSIONS = 7;

// Exchange close times and trading days. MIRRORS bot/sessions.py MARKETS, which is the one table.
const MARKETS = {
    NYSE:  { tz: 'America/New_York', close: [16, 0],  days: [1, 2, 3, 4, 5] },
    LSE:   { tz: 'Europe/London',    close: [16, 30], days: [1, 2, 3, 4, 5] },
    XETRA: { tz: 'Europe/Berlin',    close: [17, 30], days: [1, 2, 3, 4, 5] },
    NSE:   { tz: 'Asia/Kolkata',     close: [15, 30], days: [1, 2, 3, 4, 5] },
    HKEX:  { tz: 'Asia/Hong_Kong',   close: [16, 0],  days: [1, 2, 3, 4, 5] },
    TYO:   { tz: 'Asia/Tokyo',       close: [15, 30], days: [1, 2, 3, 4, 5] },
    ASX:   { tz: 'Australia/Sydney', close: [16, 0],  days: [1, 2, 3, 4, 5] },
};

let _slice = null;
let _slicePromise = null;

/** Load (and memoise) the published slice. Resolves to null when it is not deployed. */
export async function loadEarningsSlice() {
    if (_slice !== null) return _slice;
    if (_slicePromise) return _slicePromise;
    _slicePromise = (async () => {
        try {
            const r = await fetch(SLICE_URL, { cache: 'no-cache' });
            // Cloudflare Pages answers a MISSING file with 200 + index.html, so the content type
            // is the only honest test (the same trap that once broke the daily lock).
            if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('not json');
            const j = await r.json();
            _slice = (j && j.symbols && typeof j.symbols === 'object') ? j : false;
        } catch (_) {
            _slice = false;
        }
        return _slice;
    })();
    return _slicePromise;
}

/** Y-M-D in an exchange's own timezone, as a comparable string. */
function localParts(epochMs, tz) {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(new Date(epochMs));
    const g = (t) => p.find(x => x.type === t)?.value || '';
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        date: `${g('year')}-${g('month')}-${g('day')}`,
        hour: Number(g('hour')) % 24,
        minute: Number(g('minute')),
        weekday: WD[g('weekday')],
    };
}

const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

/** Exchange-local date of the session an announcement first moves. */
export function reactionDate(epochSec, region) {
    const m = MARKETS[String(region || '').toUpperCase()];
    if (!m || !Number.isFinite(epochSec)) return null;
    const { date, hour, minute, weekday } = localParts(epochSec * 1000, m.tz);
    let d = date;
    const beforeClose = hour * 60 + minute < m.close[0] * 60 + m.close[1];
    // Holidays count as closed (js/market-sessions.js), so a pre-market release on a holiday
    // moves the next session, not the closed one.
    if (!(isSession(region, d, m.days) && beforeClose)) d = addDays(d, 1);
    while (!isSession(region, d, m.days)) d = addDays(d, 1);
    return d;
}

/**
 * Exchange-LOCAL date of the session in progress (or most recent) at `epochMs`.
 *
 * Not the UTC date. ASX opens at 23:00 UTC, so a Sydney session's UTC date is the day before its
 * own; reading the earnings day off the UTC date would shift the whole band by one session.
 */
export function sessionDateFor(region, epochMs = Date.now()) {
    const m = MARKETS[String(region || '').toUpperCase()];
    if (!m) return null;
    let { date } = localParts(epochMs, m.tz);
    while (!isSession(region, date, m.days)) date = addDays(date, -1);
    return date;
}

/** Exchange-local calendar date (ISO) at `epochMs`, whether or not the market trades that day. */
export function exchangeToday(region, epochMs = Date.now()) {
    const m = MARKETS[String(region || '').toUpperCase()];
    return m ? localParts(epochMs, m.tz).date : null;
}

/**
 * The next n sessions strictly AFTER the exchange-local date at `epochMs`, holidays skipped.
 * For labels: row 2 of the band is the first of these.
 */
export function nextSessionDates(region, n, epochMs = Date.now()) {
    const m = MARKETS[String(region || '').toUpperCase()];
    if (!m) return [];
    let d = localParts(epochMs, m.tz).date;
    const out = [];
    while (out.length < n) {
        d = addDays(d, 1);
        if (isSession(region, d, m.days)) out.push(d);
    }
    return out;
}

/** The n session dates the band's rows describe, day 1 = sessionDate. */
export function bandDates(sessionDate, region, n = BAND_SESSIONS) {
    const m = MARKETS[String(region || '').toUpperCase()];
    if (!m || !sessionDate) return [];
    const out = [];
    let d = sessionDate;
    while (!isSession(region, d, m.days)) d = addDays(d, 1);
    while (out.length < n) {
        if (isSession(region, d, m.days)) out.push(d);
        d = addDays(d, 1);
    }
    return out;
}

/**
 * null | 0 | 1..n for a symbol's band. Pure, so it is testable; callers await loadEarningsSlice().
 * @param sessionDate exchange-local ISO date of band day 1
 */
export function earningsDayFor(symbol, region, sessionDate, slice, n = BAND_SESSIONS) {
    const reg = String(region || '').toUpperCase();
    if (reg === 'CRYPTO') return 0;                  // no earnings, ever
    if (!slice || !MARKETS[reg] || !sessionDate) return null;
    const entry = slice.symbols?.[String(symbol).toUpperCase()];
    if (!Array.isArray(entry)) return null;          // never asked: unknown
    const dates = bandDates(sessionDate, reg, n);
    if (!dates.length) return null;
    let first = 0;
    for (const t of entry) {
        const rd = reactionDate(t, reg);
        // An announcement that already moved an earlier session is priced in by now.
        if (!rd || rd < dates[0] || rd > dates[dates.length - 1]) continue;
        const idx = dates.indexOf(rd);
        if (idx >= 0 && (first === 0 || idx + 1 < first)) first = idx + 1;
    }
    return first;
}
