// US market calendar of high-noise events. On these days, mean-reversion
// blows up and trends fail because flow is dominated by macro releases
// and OPEX positioning, not signal-driven moves.
//
// Approach: cap confidence to 55 on event days, regardless of signal strength.
// This is defensive hygiene — it doesn't make signals smarter, it stops us
// from claiming high confidence when the market itself is in coin-flip mode.
//
// All dates are NYC market days. UTC handling done at call site.

// FOMC meeting dates 2026 (8 meetings/year, scheduled in advance).
// Source: federalreserve.gov calendar. Update annually.
const FOMC_2026 = [
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16',
];

// CPI release schedule 2026 (BLS, second Tuesday/Wednesday of each month).
const CPI_2026 = [
    '2026-01-13', '2026-02-11', '2026-03-11', '2026-04-14',
    '2026-05-13', '2026-06-11', '2026-07-15', '2026-08-12',
    '2026-09-10', '2026-10-15', '2026-11-12', '2026-12-10',
];

const PPI_2026 = [
    '2026-01-14', '2026-02-12', '2026-03-12', '2026-04-15',
    '2026-05-14', '2026-06-12', '2026-07-16', '2026-08-13',
    '2026-09-11', '2026-10-16', '2026-11-13', '2026-12-11',
];

const FOMC = new Set(FOMC_2026);
const CPI  = new Set(CPI_2026);
const PPI  = new Set(PPI_2026);

function iso(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function isThirdFriday(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    if (d.getUTCDay() !== 5) return false; // Friday
    return d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

function isQuadWitching(date) {
    if (!isThirdFriday(date)) return false;
    const d = (date instanceof Date) ? date : new Date(date);
    const m = d.getUTCMonth(); // 0-11
    return m === 2 || m === 5 || m === 8 || m === 11; // Mar/Jun/Sep/Dec
}

/**
 * Returns the dominant calendar event for a date, or null. When multiple
 * events stack (e.g. CPI on a Fed week), the highest-noise one wins.
 */
export function getCalendarEvent(date = new Date()) {
    const key = iso(date);
    if (FOMC.has(key)) return { kind: 'fomc', name: 'FOMC decision day', capConfidence: 55 };
    if (CPI.has(key))  return { kind: 'cpi',  name: 'CPI release',       capConfidence: 55 };
    if (PPI.has(key))  return { kind: 'ppi',  name: 'PPI release',       capConfidence: 58 };
    if (isQuadWitching(date)) return { kind: 'quad-witching', name: 'Quadruple witching', capConfidence: 55 };
    if (isThirdFriday(date))   return { kind: 'opex',          name: 'Monthly OPEX',       capConfidence: 60 };
    return null;
}

/**
 * Apply the cap. Returns { cap, reason } shape mirroring earningsCap.
 */
export function calendarCap(date = new Date()) {
    const ev = getCalendarEvent(date);
    if (!ev) return { cap: 100, reason: null };
    return { cap: ev.capConfidence, reason: `${ev.name} — confidence capped at ${ev.capConfidence} (macro flow dominates)` };
}
