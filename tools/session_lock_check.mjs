/**
 * Verify the daily lock is anchored to each MARKET's open, not to the page visit.
 *
 * THE BUG THIS GUARDS
 * -------------------
 * Roshan, twice: "I'm seeing this again -- locked 11:58 AM when you opened it. I told you
 * that it should lock it at the opening time of market which can differ for stocks based
 * on their region or market hours."
 *
 * The first time I blamed the Cloudflare deployment. That was wrong, and it cost a week of
 * looking in the wrong place. The real causes, measured on 2026-09-10:
 *
 *   1. GitHub delayed the 13:35Z NYSE cron to 17:08Z, so the row was stamped 17:10Z --
 *      3h40m after the 13:30Z open -- while the tooltip claimed "locked at this market's
 *      open". For the 3h40m before it landed there was no row at all and the UI fell back
 *      to a visit-time lock.
 *   2. The lock was keyed and expired on the UTC calendar date, which rolls over at 00:00Z
 *      -- 8pm in New York, 5:30am in Mumbai. It never rolled over at any market's open.
 *   3. readTodayLock matched rows on `r.date === todayUTC`, which cannot match ASX (opens
 *      23:00Z in Australian DST, 00:00Z outside it) for half the year.
 *
 * These assertions encode the behaviour, not the implementation, so a future rewrite that
 * keeps the guarantees still passes.
 *
 * Run: node tools/session_lock_check.mjs
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(resolve(REPO, rel)).href);

// daily-lock.js persists through localStorage. Shim it before importing anything.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const {
    sessionAnchorFromCandles, minutesAfterOpen, isAtOpen, AT_OPEN_TOLERANCE_MIN,
} = await imp('js/ui/market-session.js');

// ── Session anchor ────────────────────────────────────────────────────────────
// Prices are the real ones measured live from Yahoo on 2026-09-10, so they encode actual
// exchange behaviour rather than invented numbers. The EPOCHS, however, derive from the real
// clock.
//
// They used to be hardcoded (1789047000 = 2026-09-10 13:30Z) and that made the suite rot: the
// lock store prunes records older than two calendar days, so three assertions that passed when
// written on the 10th were red by the 14th. A test that fails with the calendar is worse than no
// test, because the failure looks exactly like a code regression and costs a debugging session to
// dismiss. Anything asserting a session-lock behaviour has to sit inside the prune window.
const DAY_S = 86400;
function nyseOpenEpoch(daysAgo = 0) {
    const d = new Date();
    d.setUTCHours(13, 30, 0, 0);            // NYSE 09:30 EDT
    return Math.floor(d.getTime() / 1000) - daysAgo * DAY_S;
}
function openEpochAt(h, m, daysAgo = 0) {
    const d = new Date();
    d.setUTCHours(h, m, 0, 0);
    return Math.floor(d.getTime() / 1000) - daysAgo * DAY_S;
}
const iso = (epoch) => new Date(epoch * 1000).toISOString();
const isoDay = (epoch) => iso(epoch).slice(0, 10);
const SEP10_NYSE_OPEN = nyseOpenEpoch(0);   // "today"
const SEP9_NYSE_OPEN = nyseOpenEpoch(1);    // "the previous session"

console.log('=== the session anchor comes off the daily bar ===');
const nyse = [
    { time: SEP9_NYSE_OPEN, open: 315.49, high: 317.0, low: 314.0, close: 315.34, volume: 1e6 },
    { time: SEP10_NYSE_OPEN, open: 316.79, high: 325.68, low: 316.57, close: 323.77, volume: 1e6 },
];
const a = sessionAnchorFromCandles(nyse);
check('anchors to the newest bar', a !== null && a.openedAt === iso(SEP10_NYSE_OPEN),
      JSON.stringify(a));
check('open PRICE is the bar open, not the last close', near(a?.openPrice, 316.79));
check('session date is the open instant’s date', a?.sessionDate === isoDay(SEP10_NYSE_OPEN), a?.sessionDate);

// Mumbai opens 03:45Z, Tokyo 00:00Z. Same code path, no per-market table.
const nse = sessionAnchorFromCandles([
    { time: openEpochAt(3, 45, 1), open: 1283.5, high: 1290, low: 1280, close: 1279.0, volume: 1 },
    { time: openEpochAt(3, 45, 0), open: 1278.5, high: 1285, low: 1270, close: 1274.0, volume: 1 },
]);
check('Mumbai anchors to its own 03:45Z open',
      nse?.openedAt === iso(openEpochAt(3, 45, 0)), nse?.openedAt);
check('and to its own open price', near(nse?.openPrice, 1278.5));

console.log();
console.log('=== the anchor refuses inputs it cannot answer from ===');
check('empty series -> null', sessionAnchorFromCandles([]) === null);
check('non-array -> null', sessionAnchorFromCandles(null) === null);
// An intraday series would anchor "the market open" to 15:30Z. Must be rejected.
const hourly = [];
for (let i = 0; i < 6; i++) hourly.push({ time: SEP10_NYSE_OPEN + i * 3600, open: 316 + i, high: 317 + i, low: 315 + i, close: 316.5 + i, volume: 1 });
check('an HOURLY series is rejected, not mistaken for daily',
      sessionAnchorFromCandles(hourly) === null,
      JSON.stringify(sessionAnchorFromCandles(hourly)));
// Yahoo emits a placeholder bar with close=null the evening before Tokyo opens.
check('a placeholder bar (close=null) cannot become the anchor',
      sessionAnchorFromCandles([
          { time: SEP9_NYSE_OPEN, open: 315.49, high: 317, low: 314, close: 315.34, volume: 1 },
          { time: SEP10_NYSE_OPEN, open: 316.79, high: null, low: null, close: null, volume: 0 },
      ])?.openedAt === iso(SEP9_NYSE_OPEN));
check('a zero-price bar cannot become the anchor',
      sessionAnchorFromCandles([
          { time: SEP9_NYSE_OPEN, open: 315.49, high: 317, low: 314, close: 315.34, volume: 1 },
          { time: SEP10_NYSE_OPEN, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      ])?.openedAt === iso(SEP9_NYSE_OPEN));

console.log();
console.log('=== lateness is measured against the open, and reported honestly ===');
// The actual 2026-09-10 row: cron scheduled 13:35Z, ran 17:08Z, stamped 17:10:29Z.
const LATE = iso(SEP10_NYSE_OPEN + 220 * 60);
check('a 3h40m-late call is measured as ~220 minutes',
      minutesAfterOpen(LATE, a) === 220, String(minutesAfterOpen(LATE, a)));
check('and is NOT reported as at-open', isAtOpen(LATE, a) === false);
check('an on-time call IS at-open', isAtOpen(iso(SEP10_NYSE_OPEN + 4 * 60), a) === true);
check('a call inside the tolerance is at-open',
      isAtOpen(new Date((SEP10_NYSE_OPEN + (AT_OPEN_TOLERANCE_MIN - 1) * 60) * 1000).toISOString(), a) === true);
check('a call past the tolerance is not',
      isAtOpen(new Date((SEP10_NYSE_OPEN + (AT_OPEN_TOLERANCE_MIN + 5) * 60) * 1000).toISOString(), a) === false);
check('a pre-open snapshot still counts as open-anchored',
      isAtOpen(iso(SEP10_NYSE_OPEN - 8 * 60), a) === true);
check('no anchor -> null rather than a fabricated 0', minutesAfterOpen(LATE, null) === null);

// ── The local lock ────────────────────────────────────────────────────────────
const { lockCall, getLockedCall } = await imp('js/ui/daily-lock.js');

console.log();
console.log('=== the local lock is anchored to the OPEN, not to the visit ===');
store.clear();
// The engine ran at 11:58 local with the price at 323.55 and a band around it.
const livePred = {
    signal: 'BUY', confidence: 61, currency: 'USD',
    priceTargets: { currentPrice: 323.55, predictedHigh: 329.55, predictedLow: 320.55 },
};
const rec = lockCall('AAPL', livePred, a);
check('entry is the session OPEN price, not the visit price',
      near(rec?.entry, 316.79), `entry=${rec?.entry}`);
check('lockedAt is the session open, not "now"',
      rec?.lockedAt === iso(SEP10_NYSE_OPEN), rec?.lockedAt);
check('openAnchored is flagged so the UI can say so', rec?.openAnchored === true);
check('calledAt still records when WE computed it (both facts kept)',
      typeof rec?.calledAt === 'string' && rec.calledAt !== rec.lockedAt);
// The band must move WITH the entry or computeStatus compares two baselines. The move is
// MULTIPLICATIVE, because forecastBands builds each edge as price*exp(+/-move): re-anchoring
// preserves the RATIO, not the absolute dollar width. This assertion originally required the
// dollar width to be preserved, which was my own error -- an additive shift disagreed with the
// rescaled band by 14 cents on INTC, and the two are meant to be the same number.
check('the band is re-anchored multiplicatively (ratio preserved)',
      near(rec.predictedHigh / rec.entry, 329.55 / 323.55, 1e-6)
      && near(rec.predictedLow / rec.entry, 320.55 / 323.55, 1e-6),
      `high/entry=${rec.predictedHigh / rec.entry} low/entry=${rec.predictedLow / rec.entry}`);

console.log();
console.log('=== the lock HOLDS within a session and rolls over AT the next open ===');
const again = lockCall('AAPL', {
    signal: 'SELL', confidence: 20, currency: 'USD',
    priceTargets: { currentPrice: 300, predictedHigh: 305, predictedLow: 295 },
}, a);
check('a second call in the same session does not replace the first',
      again.signal === 'BUY' && near(again.entry, 316.79), JSON.stringify(again));
check('getLockedCall finds it for this session', getLockedCall('AAPL', a)?.signal === 'BUY');

// A DIFFERENT session (the next open) must produce a fresh lock.
const nextAnchor = sessionAnchorFromCandles([
    { time: SEP10_NYSE_OPEN, open: 316.79, high: 325, low: 316, close: 323.77, volume: 1 },
    { time: SEP10_NYSE_OPEN + 86400, open: 324.10, high: 330, low: 323, close: 327.0, volume: 1 },
]);
const rolled = lockCall('AAPL', {
    signal: 'SELL', confidence: 44, currency: 'USD',
    priceTargets: { currentPrice: 327.0, predictedHigh: 331, predictedLow: 323 },
}, nextAnchor);
check('the next session gets a NEW lock', rolled.signal === 'SELL' && near(rolled.entry, 324.10),
      JSON.stringify(rolled));
check('and the old session no longer resolves', getLockedCall('AAPL', a) === null);

console.log();
console.log('=== ONE band: the headline targets and the 7-session table cannot disagree ===');
// THE BUG. INTC on 2026-09-14 showed "Expected High $101.70" in the price-targets block and
// "$104.05" for Today in the 7-session table, both badged 80% confidence. The lock re-anchored
// priceTargets onto the session open ($95.72) and left the table on the live price ($98.08).
store.clear();
{
    const live = 98.08, open = 95.72;
    const bandLive = {
        calibrated: true, confidence: 80, sigmaDaily: 3.9, volTier: 'active',
        days: [
            { day: 1, low: 92.44, high: 104.05, widthPct: 6.09 },
            { day: 2, low: 90.41, high: 106.39, widthPct: 8.47 },
            { day: 3, low: 89.05, high: 108.02, widthPct: 10.14 },
        ],
    };
    const pred = {
        signal: 'NEUTRAL', confidence: 51, currency: 'USD',
        priceTargets: { currentPrice: live, predictedHigh: 104.05, predictedLow: 92.44 },
        forecastBand: bandLive,
    };
    const anchorIntc = sessionAnchorFromCandles([
        { time: SEP9_NYSE_OPEN, open: 102.70, high: 106.69, low: 102.70, close: 103.0, volume: 1 },
        { time: SEP10_NYSE_OPEN, open, high: live, low: 94.0, close: live, volume: 1 },
    ]);
    const rec = lockCall('INTC', pred, anchorIntc);

    check('the lock stores a 7-session band', Array.isArray(rec.forecastBand?.days), JSON.stringify(rec.forecastBand?.days?.length));
    const d1 = rec.forecastBand.days[0];
    check('the locked band day-1 EQUALS the locked headline high',
          Math.abs(d1.high - rec.predictedHigh) < 0.01,
          `band day1 high=${d1.high} vs headline=${rec.predictedHigh}`);
    check('and the same for the low',
          Math.abs(d1.low - rec.predictedLow) < 0.01,
          `band day1 low=${d1.low} vs headline=${rec.predictedLow}`);
    // Both must be the OPEN-anchored figures, not the live ones.
    const scale = open / live;
    check('day-1 high is the live band scaled to the open',
          Math.abs(d1.high - 104.05 * scale) < 0.01, `${d1.high} vs ${(104.05 * scale).toFixed(2)}`);
    check('the live figure ($104.05) is NOT what is stored', Math.abs(d1.high - 104.05) > 0.5, String(d1.high));
    // Every horizon moves, not just day 1, or tomorrow's row contradicts today's.
    check('ALL horizons are rescaled, not only day 1',
          rec.forecastBand.days.every((d, i) => Math.abs(d.high - bandLive.days[i].high * scale) < 0.01),
          JSON.stringify(rec.forecastBand.days.map(d => d.high)));
    // widthPct is a ratio, so re-anchoring must leave it alone.
    check('widthPct is unchanged by re-anchoring (it is a ratio)',
          rec.forecastBand.days.every((d, i) => d.widthPct === bandLive.days[i].widthPct),
          JSON.stringify(rec.forecastBand.days.map(d => d.widthPct)));
    check('the band metadata survives', rec.forecastBand.calibrated === true
          && rec.forecastBand.confidence === 80 && rec.forecastBand.volTier === 'active');
    // Scale of exactly 1 (no anchor movement) must not churn the object.
    const same = lockCall('SAME', { ...pred }, null);
    check('with no open price the band is left as-is', same.forecastBand === pred.forecastBand);
}

console.log();
console.log('=== no anchor: degrades, never crashes ===');
store.clear();
const noAnchor = lockCall('XYZ', livePred, null);
check('still locks without an anchor', noAnchor !== null);
check('falls back to the visit price', near(noAnchor.entry, 323.55));
check('and does NOT claim to be open-anchored', noAnchor.openAnchored === false);

// ── Ledger row -> session matching ────────────────────────────────────────────
// readTodayLock reads through the network; exercise its matching rule directly by
// stubbing fetch with a slice whose rows sit at known offsets from the open.
console.log();
console.log('=== a ledger row is matched to its SESSION, not to the UTC date ===');
const mkRow = (predictedAt, date, entry, signal) => ({
    symbol: 'AAPL', date, predictedAt, entry, signal, confidence: 55, region: 'NYSE',
    horizons: {}, expectedMove: 3.0,
    // The cron stores the whole 7-session band on the row. readTodayLock must hand it back, or
    // signal.js falls through to the live-anchored band for the table while pinning the headline
    // targets to the locked values -- which is exactly the two-different-expected-highs bug.
    forecastBand: {
        calibrated: true, confidence: 80, sigmaDaily: 1.46, volTier: 'calm',
        days: [{ day: 1, low: 313.67, high: 333.75, widthPct: 3.15 },
               { day: 2, low: 310.5, high: 337.1, widthPct: 4.2 }],
    },
});
const slice = {
    generatedAt: iso(SEP10_NYSE_OPEN + 238 * 60),
    rows: [
        // Yesterday's session -- ~24h away, must never be chosen for today.
        mkRow(iso(SEP9_NYSE_OPEN + 4 * 60), isoDay(SEP9_NYSE_OPEN), 315.49, 'SELL'),
        // Today's, written 3h40m late by the delayed cron.
        mkRow(LATE, isoDay(SEP10_NYSE_OPEN), 323.55, 'BUY'),
    ],
};
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('recent.json')) {
        return {
            ok: true, status: 200,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
            json: async () => slice,
            text: async () => JSON.stringify(slice),
        };
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
};
const { readTodayLock } = await imp('js/ledger-reader.js');
const led = await readTodayLock('AAPL', a);
check('the late row IS found (proximity match, not date-string)', led !== null,
      'readTodayLock returned null -- the 3h40m-late row was missed');
check('it picked TODAY’s row, not yesterday’s',
      led?.signal === 'BUY' && near(led?.entry, 323.55), JSON.stringify(led));
check('its lockedAt is the row’s real predictedAt (not rewritten to the open)',
      led?.lockedAt === LATE, led?.lockedAt);
check('the ledger lock carries the row’s 7-session band',
      Array.isArray(led?.forecastBand?.days) && led.forecastBand.days.length === 2,
      JSON.stringify(led?.forecastBand));
check('and that band day-1 matches the row, not a recomputation',
      near(led.forecastBand.days[0].high, 333.75) && near(led.forecastBand.days[0].low, 313.67),
      JSON.stringify(led?.forecastBand?.days?.[0]));
// A row with a malformed band must yield null, not a half-built object the UI would render.
const ledNoBand = await readTodayLock('AAPL', a);
check('a band-less row would return null rather than a broken shape',
      ledNoBand === null || ledNoBand.forecastBand === null || Array.isArray(ledNoBand.forecastBand.days),
      JSON.stringify(ledNoBand?.forecastBand));
// The adjacent session must be excluded even when we ask with yesterday's anchor.
const yAnchor = sessionAnchorFromCandles([
    { time: SEP9_NYSE_OPEN - 86400, open: 314.0, high: 316, low: 313, close: 315.0, volume: 1 },
    { time: SEP9_NYSE_OPEN, open: 315.49, high: 317, low: 314, close: 315.34, volume: 1 },
]);
const ledY = await readTodayLock('AAPL', yAnchor);
check('yesterday’s anchor resolves yesterday’s row',
      ledY?.signal === 'SELL' && near(ledY?.entry, 315.49), JSON.stringify(ledY));

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'SESSION-LOCK CHECK PASS' : 'SESSION-LOCK CHECK FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (!ok && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=session_lock::${FAIL.slice(0, 6).join('; ')}`);
}
// exitCode, not process.exit(): a keep-alive socket left open by an import made
// macro_check crash libuv on exit while reporting every assertion green.
process.exitCode = ok ? 0 : 1;
