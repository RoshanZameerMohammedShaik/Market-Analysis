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
console.log('=== reach %: how much of the predicted MOVE happened, per direction ===');
// Hand-computable case. Anchor the band on a known open and place the day's high and low at
// exact fractions of the predicted distances.
{
    const base = series(60);
    const i = base.length - 2;                       // the newest COMPLETE session
    const probe = buildBandHistory({ candles: base, sessions: 1 });
    const p = probe.rows[0];
    const anchor = p.anchor;
    const upDist = p.predHigh - anchor;
    const downDist = anchor - p.predLow;
    check('the anchor is the session open', Math.abs(anchor - base[i].open) < 1e-9);
    check('predicted distances are positive', upDist > 0 && downDist > 0);

    // Rebuild with the high at exactly 50% of the predicted upside and the low at 25% of the
    // predicted downside. Only bar i changes, so the band itself is untouched.
    const shaped = base.map((b, k) => (k === i
        ? { ...b, high: anchor + upDist * 0.5, low: anchor - downDist * 0.25 }
        : b));
    const h5 = buildBandHistory({ candles: shaped, sessions: 1 });
    const r5 = h5.rows[0];
    check('50% of the predicted upside reads as 50%', r5.reachHighPct === 50, String(r5.reachHighPct));
    check('25% of the predicted downside reads as 25%', r5.reachLowPct === 25, String(r5.reachLowPct));
    check('and neither side counts as broken', r5.met === true);

    // THE TRAP this metric exists to avoid: dividing raw PRICES instead of moves. On a $100
    // stock a band expecting 3% would score 100*(1.0)/103 = 97% for a day that never moved,
    // because the shared anchor dominates the ratio. Reach must report ~0 there.
    const flat = base.map((b, k) => (k === i ? { ...b, high: anchor, low: anchor } : b));
    const h6 = buildBandHistory({ candles: flat, sessions: 1 });
    check('a session that never moved reaches 0%, not ~97%',
          h6.rows[0].reachHighPct === 0 && h6.rows[0].reachLowPct === 0,
          JSON.stringify([h6.rows[0].reachHighPct, h6.rows[0].reachLowPct]));

    // Exactly touching the edge: 100%, and by the band's own claim that side no longer held.
    const touch = base.map((b, k) => (k === i ? { ...b, high: p.predHigh, low: anchor } : b));
    const h7 = buildBandHistory({ candles: touch, sessions: 1 });
    check('touching the predicted high reads 100%', h7.rows[0].reachHighPct === 100, String(h7.rows[0].reachHighPct));
    // The bound is INCLUSIVE: high <= predHigh. So exactly touching the edge is 100% reach AND
    // still a hold. Only PASSING it breaks containment. Worth pinning, because the tooltip and
    // the bar styling both key off this distinction and my first version of them got it wrong.
    check('touching the edge exactly still HOLDS (inclusive bound)',
          h7.rows[0].highHeld === true, `highHeld=${h7.rows[0].highHeld}`);

    // Blowing past it: UNCAPPED in the data, so 100 and 140 stay distinguishable. Clamping at
    // source would erase the difference the display needs to show a breach.
    const over = base.map((b, k) => (k === i ? { ...b, high: anchor + upDist * 1.4, low: anchor } : b));
    const h8 = buildBandHistory({ candles: over, sessions: 1 });
    check('overshooting reports >100% rather than clamping to 100',
          h8.rows[0].reachHighPct === 140, String(h8.rows[0].reachHighPct));
    check('and that session is a miss', h8.rows[0].met === false && h8.rows[0].highHeld === false);

    // A high BELOW the anchor delivered none of the predicted upside. Must floor at 0, not
    // report a negative percentage along an axis that only has one direction.
    const below = base.map((b, k) => (k === i
        ? { ...b, high: anchor - upDist * 0.2, low: anchor - downDist * 0.5 } : b));
    const h9 = buildBandHistory({ candles: below, sessions: 1 });
    check('a high below the anchor floors at 0%, never negative',
          h9.rows[0].reachHighPct === 0, String(h9.rows[0].reachHighPct));
    check('while the downside still reports its real 50%',
          h9.rows[0].reachLowPct === 50, String(h9.rows[0].reachLowPct));
}
check('every row carries both reach figures',
      h.rows.every(r => Number.isFinite(r.reachHighPct) && Number.isFinite(r.reachLowPct)));

console.log();
console.log('=== SESSION START anchors both sides, for locked rows too ===');
// Roshan's worked example, verbatim: a stock opens at 100, the band predicts 110 / 90. A spike
// to 109 covered 9 of the 10 predicted upside -> 90%. A dip to 91 covered 9 of the 10 predicted
// downside -> 90%. One formula, both directions.
{
    const base = series(60);
    const i = base.length - 2;
    const date = new Date(base[i].time * 1000).toISOString().slice(0, 10);
    const shaped = base.map((b, k) => (k === i
        ? { ...b, open: 100, high: 109, low: 91, close: 105 } : b));
    // A locked row fixes the predicted edges at exactly 110 / 90. Its `entry` is deliberately
    // set to 123 -- a nonsense mid-session anchor -- to prove the reach ignores it and uses the
    // session open. Before this change that entry produced completely different percentages.
    const locked = [{
        symbol: 'X', date, entry: 123,
        predictedAt: `${date}T18:00:00Z`,
        forecastBand: { confidence: 80, calibrated: true, days: [{ day: 1, low: 90, high: 110 }] },
    }];
    const hh = buildBandHistory({ candles: shaped, lockedRows: locked, sessions: 1 });
    const row = hh.rows[0];
    check('sessionStart is the session OPEN', row.sessionStart === 100, String(row.sessionStart));
    check('a spike to 109 against a predicted 110 reads 90%',
          row.reachHighPct === 90, String(row.reachHighPct));
    check('a dip to 91 against a predicted 90 reads 90%',
          row.reachLowPct === 90, String(row.reachLowPct));
    check('the row is still sourced from the LOCKED band', row.source === 'locked', row.source);
    check('the locked row’s mid-session entry does NOT anchor the reach',
          row.reachHighPct !== 0 && row.sessionStart !== 123,
          `sessionStart=${row.sessionStart} reachHigh=${row.reachHighPct}`);
    check('both sides are Hit at 90% (>=50, edge not reached)',
          row.hitHigh === 'hit' && row.hitLow === 'hit',
          `${row.hitHigh}/${row.hitLow}`);
}

console.log();
console.log('=== hit tiers ===');
{
    const base = series(60);
    const i = base.length - 2;
    const date = new Date(base[i].time * 1000).toISOString().slice(0, 10);
    const lock = (low, high) => ([{
        symbol: 'X', date, entry: 100,
        forecastBand: { confidence: 80, calibrated: true, days: [{ day: 1, low, high }] },
    }]);
    const at = (high, low) => {
        const c = base.map((b, k) => (k === i ? { ...b, open: 100, high, low, close: 100 } : b));
        return buildBandHistory({ candles: c, lockedRows: lock(90, 110), sessions: 1 }).rows[0];
    };
    check('actual high EXACTLY the predicted high -> Strong Hit', at(110, 100).hitHigh === 'strong', at(110, 100).hitHigh);
    check('actual high ABOVE the predicted high -> Strong Hit', at(115, 100).hitHigh === 'strong', at(115, 100).hitHigh);
    check('reach 50% -> Hit (the boundary is inclusive)', at(105, 100).hitHigh === 'hit', `${at(105, 100).reachHighPct}% -> ${at(105, 100).hitHigh}`);
    check('reach just under 50% -> Partial Hit', at(104.9, 100).hitHigh === 'partial', `${at(104.9, 100).reachHighPct}% -> ${at(104.9, 100).hitHigh}`);
    check('never traded above session start -> No Move', at(100, 95).hitHigh === 'none', at(100, 95).hitHigh);
    // The low side mirrors it exactly.
    check('actual low EXACTLY the predicted low -> Strong Hit', at(100, 90).hitLow === 'strong', at(100, 90).hitLow);
    check('actual low BELOW the predicted low -> Strong Hit', at(100, 85).hitLow === 'strong', at(100, 85).hitLow);
    check('low reach 50% -> Hit', at(100, 95).hitLow === 'hit', `${at(100, 95).reachLowPct}% -> ${at(100, 95).hitLow}`);
    check('low reach under 50% -> Partial Hit', at(100, 96).hitLow === 'partial', `${at(100, 96).reachLowPct}% -> ${at(100, 96).hitLow}`);
    check('never traded below session start -> No Move', at(105, 100).hitLow === 'none', at(100, 100).hitLow);

    // A late band can put its predicted edge on the WRONG side of the open: if the day opened at
    // 100 but a mid-session band predicted a high of 98, the ratio is undefined. Strong Hit is a
    // direct comparison, so it must still work -- price at 105 clearly passed 98.
    const weird = base.map((b, k) => (k === i ? { ...b, open: 100, high: 105, low: 99, close: 100 } : b));
    const wrow = buildBandHistory({ candles: weird, lockedRows: lock(102, 98), sessions: 1 }).rows[0];
    check('an edge on the wrong side of the open still resolves as Strong Hit',
          wrow.hitHigh === 'strong' && wrow.hitLow === 'strong',
          `${wrow.hitHigh}/${wrow.hitLow} reach=${wrow.reachHighPct}/${wrow.reachLowPct}`);
    check('and the undefined ratio reports null rather than a fabricated number',
          wrow.reachHighPct === null && wrow.reachLowPct === null,
          `${wrow.reachHighPct}/${wrow.reachLowPct}`);
}

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
