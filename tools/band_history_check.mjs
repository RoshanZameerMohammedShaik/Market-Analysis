/**
 * Verify the scored past-sessions table in the forecast panel.
 *
 * WHAT MUST NOT BREAK
 * -------------------
 * This table is an accuracy CLAIM about the app's own forecast, printed next to prices. The
 * failure modes are all quiet ones:
 *
 *   * Lookahead. If the replayed band is anchored on a session's CLOSE, or its sigma includes
 *     that session's own bar, the band gets to see the move it is being scored against and
 *     coverage looks far better than it is. This project has already shipped one number
 *     inflated exactly that way (71.6% that was really 51.5%, from a resolver that graded
 *     against the wrong bar).
 *   * Scoring the in-progress session. Its high and low are still forming, so it would count
 *     as a hold simply because the day is not over.
 *   * Blurring 'locked' with 'modelled'. One is a commitment the cron actually made, the other
 *     is a reconstruction. Presenting a replay as a locked promise overstates the record.
 *   * Containment without fill. A band wide enough never to break holds 100% of the time and
 *     says nothing. Coverage has to be readable next to how much of the range was used.
 *
 * Run: node tools/band_history_check.mjs
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(resolve(REPO, rel)).href);

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};

const { buildBandHistory, describeBandHistory } = await imp('js/ui/band-history.js');

// A deterministic series: 60 daily bars, gentle drift, fixed 1% intraday range. Real epochs
// on a weekday grid so the dates the table prints are plausible.
const DAY = 86400;
const START = 1786060200;   // 2026-05-06 13:30Z, a Wednesday NYSE open
function series(n, { rangePct = 0.01, drift = 0.001, spikeAt = null, spikePct = 0.12 } = {}) {
    const out = [];
    let px = 100;
    for (let i = 0; i < n; i++) {
        px = px * (1 + drift);
        const r = (spikeAt === i) ? spikePct : rangePct;
        const open = px;
        const high = px * (1 + r / 2);
        const low = px * (1 - r / 2);
        out.push({ time: START + i * DAY, open, high, low, close: px * (1 + r / 10), volume: 1e6 });
    }
    return out;
}

console.log('=== the table scores completed sessions only ===');
const c = series(60);
const h = buildBandHistory({ candles: c, sessions: 7 });
check('history is produced', h !== null && h.rows.length === 7, JSON.stringify(h && h.rows.length));
const lastBarDate = new Date(c[c.length - 1].time * 1000).toISOString().slice(0, 10);
check('the CURRENT (last) session is excluded',
      !h.rows.some(r => r.date === lastBarDate),
      `last bar ${lastBarDate} appears in ${JSON.stringify(h.rows.map(r => r.date))}`);
const secondLast = new Date(c[c.length - 2].time * 1000).toISOString().slice(0, 10);
check('the most recent COMPLETED session is the newest row',
      h.rows[h.rows.length - 1].date === secondLast,
      `${h.rows[h.rows.length - 1].date} vs ${secondLast}`);
check('rows are chronological', h.rows.every((r, i) => i === 0 || r.date > h.rows[i - 1].date));

console.log();
console.log('=== no lookahead: a session cannot inform its own band ===');
// The proof: change ONLY the session being scored (blow its range wide open) and the predicted
// band must not move. If sigma or the anchor saw that bar, the band would widen with it.
const target = c.length - 3;
const tampered = c.map((b, i) => (i === target
    ? { ...b, high: b.open * 1.30, low: b.open * 0.70 }   // same open, huge range
    : b));
const h2 = buildBandHistory({ candles: tampered, sessions: 7 });
const before = h.rows.find(r => r.date === new Date(c[target].time * 1000).toISOString().slice(0, 10));
const after = h2.rows.find(r => r.date === before.date);
check('the predicted band is IDENTICAL after widening only that session',
      Math.abs(after.predLow - before.predLow) < 1e-9 && Math.abs(after.predHigh - before.predHigh) < 1e-9,
      `pred moved: ${before.predLow}/${before.predHigh} -> ${after.predLow}/${after.predHigh}`);
check('but the OUTCOME changes (a 30% day now breaks the band)',
      before.met === true && after.met === false,
      `before.met=${before.met} after.met=${after.met}`);
check('and the break is reported on both sides', after.brokeSide === 'both', after.brokeSide);

console.log();
console.log('=== the band is anchored on the OPEN, not the close ===');
// Shift only the CLOSE of the scored session. An open-anchored band must not budge.
const closeShift = c.map((b, i) => (i === target ? { ...b, close: b.open * 1.005 } : b));
const h3 = buildBandHistory({ candles: closeShift, sessions: 7 });
const after3 = h3.rows.find(r => r.date === before.date);
check('moving that session’s CLOSE does not move its band',
      Math.abs(after3.predLow - before.predLow) < 1e-9 && Math.abs(after3.predHigh - before.predHigh) < 1e-9,
      `${before.predLow}/${before.predHigh} -> ${after3.predLow}/${after3.predHigh}`);
check('the anchor recorded IS the session open',
      Math.abs(before.anchor - c[target].open) < 1e-9, `${before.anchor} vs ${c[target].open}`);

console.log();
console.log('=== "met" means BOTH edges held, not one ===');
// Break only the high: same open, high above the band, low well inside.
const oneSide = c.map((b, i) => (i === target ? { ...b, high: b.open * 1.25 } : b));
const h4 = buildBandHistory({ candles: oneSide, sessions: 7 });
const after4 = h4.rows.find(r => r.date === before.date);
check('breaking only the high is a MISS, not a half-credit',
      after4.met === false && after4.lowHeld === true && after4.highHeld === false,
      JSON.stringify({ met: after4.met, low: after4.lowHeld, high: after4.highHeld }));
check('and the side is named', after4.brokeSide === 'high', after4.brokeSide);
check('missPct is reported as a % of the anchor', after4.missPct > 0, String(after4.missPct));
check('a held session reports no miss', before.missPct === null, String(before.missPct));

console.log();
console.log('=== fill % separates a tight band from an absurdly wide one ===');
const calm = buildBandHistory({ candles: series(60, { rangePct: 0.002 }), sessions: 7 });
const wild = buildBandHistory({ candles: series(60, { rangePct: 0.05 }), sessions: 7 });
check('fill is present on every row', h.rows.every(r => Number.isFinite(r.fillPct)));
// Fill is SCALE-INVARIANT on a constant-range series, and that is correct rather than a bug:
// sigma is derived from the ranges, so a uniformly wider series gets a proportionally wider
// band and uses the same fraction of it. My first version of this check asserted the opposite
// and failed; the code was right. Pinning the real property so nobody "fixes" it later.
check('a uniformly wider series fills the SAME fraction (band scales with sigma)',
      wild.medianFillPct === calm.medianFillPct,
      `wild=${wild.medianFillPct} calm=${calm.medianFillPct}`);
// What fill actually detects is volatility CHANGING after the band was set -- the exact case
// the panel's caveat warns about. Spike one session's range against a calm history.
const spiked = series(60, { rangePct: 0.01, spikeAt: target, spikePct: 0.12 });
const hspike = buildBandHistory({ candles: spiked, sessions: 7 });
const srow = hspike.rows.find(r => r.date === before.date);
check('a volatility spike AFTER the band is set shows fill far above 100%',
      srow.fillPct > 200, `fillPct=${srow.fillPct}`);
check('and that session breaks the band', srow.met === false, JSON.stringify(srow.met));
check('while the untouched sessions around it still hold',
      hspike.rows.filter(r => r.date !== before.date).every(r => r.met === true));

console.log();
console.log('=== locked ledger rows override the replay, and are labelled ===');
const dTarget = before.date;
const locked = buildBandHistory({
    candles: c,
    sessions: 7,
    lockedRows: [{
        symbol: 'X', date: dTarget, entry: 100,
        forecastBand: { confidence: 80, calibrated: true, days: [{ day: 1, low: 1, high: 999 }] },
    }],
});
const lrow = locked.rows.find(r => r.date === dTarget);
check('the stored band is used verbatim', lrow.predLow === 1 && lrow.predHigh === 999,
      JSON.stringify({ low: lrow.predLow, high: lrow.predHigh }));
check('and is marked source=locked', lrow.source === 'locked', lrow.source);
check('other sessions stay modelled',
      locked.rows.filter(r => r.date !== dTarget).every(r => r.source === 'modelled'));
check('lockedCount reports how much of the table is a real commitment',
      locked.lockedCount === 1, String(locked.lockedCount));
// A row with no usable band must NOT silently become a locked row.
const junk = buildBandHistory({
    candles: c, sessions: 7,
    lockedRows: [{ symbol: 'X', date: dTarget, entry: 100, forecastBand: { days: [{ day: 1, low: null, high: null }] } }],
});
check('a ledger row with an unusable band falls back to the replay',
      junk.rows.find(r => r.date === dTarget).source === 'modelled');

console.log();
console.log('=== refuses to score what it cannot ===');
check('too few bars -> null', buildBandHistory({ candles: series(20), sessions: 7 }) === null);
check('no candles -> null', buildBandHistory({ candles: null }) === null);
check('empty -> null', buildBandHistory({ candles: [] }) === null);
// Yahoo's pre-open placeholder bar (close=null) must not be scored as a session.
const withPlaceholder = [...series(59), { time: START + 59 * DAY, open: 105, high: null, low: null, close: null, volume: 0 }];
const hp = buildBandHistory({ candles: withPlaceholder, sessions: 7 });
check('a placeholder bar is not scored',
      hp !== null && hp.rows.every(r => Number.isFinite(r.actualHigh) && Number.isFinite(r.actualLow)),
      JSON.stringify(hp && hp.rows.map(r => r.actualHigh)));

console.log();
console.log('=== the summary refuses to call 7 sessions evidence ===');
const text = describeBandHistory(h);
console.log(`     "${text}"`);
check('it states the count and the coverage',
      text.includes(`${h.metCount} of ${h.scored}`) && text.includes(`${h.coveragePct}%`), text);
check('it names the claimed figure', /claimed/.test(text), text);
check('it warns the sample is too small to judge',
      /too few|±15|noise/i.test(text), text);
check('coverage is metCount/scored', h.coveragePct === Math.round(h.metCount / h.scored * 100));
check('empty history describes as empty', describeBandHistory(null) === '');

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'BAND HISTORY CHECK PASS' : 'BAND HISTORY CHECK FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (!ok && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=band_history::${FAIL.slice(0, 6).join('; ')}`);
}
process.exitCode = ok ? 0 : 1;
