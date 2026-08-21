// Invariant tests for js/risk.js.
//
// Risk code is not checked by comparing numbers to a fixture. It is checked by
// asserting the properties that must never break, because a sizing bug does not
// throw, it just quietly oversizes and shows up as a drawdown months later.
//
// Usage: node tools/risk_check.mjs
// Exits non-zero on any failed invariant.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

globalThis.fetch = async (u) => {
    const p = path.isAbsolute(u) ? u : path.join(REPO, u);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

const fb = await import(pathToFileURL(path.join(REPO, 'js/forecast-band.js')).href);
const risk = await import(pathToFileURL(path.join(REPO, 'js/risk.js')).href);
const cal = await fb.loadBandCalibration();

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

// Deterministic OHLC at a chosen volatility, so tier is controllable.
function synth(spread, n = 40, base = 100) {
    let s = 42, px = base;
    const nxt = () => { s = (1103515245 * s + 12345) % 2 ** 31; return s / 2 ** 31; };
    const out = [];
    for (let i = 0; i < n; i++) {
        px *= Math.exp((nxt() - 0.5) * spread);
        const rng = px * spread * (0.4 + nxt());
        out.push({ high: px + rng / 2, low: Math.max(px - rng / 2, px * 0.5), close: px });
    }
    return out;
}

console.log('=== calibration ===');
check('calibration loaded (not fallback)', !cal._fallback);
check('stopZ present', !!cal.stopZ, JSON.stringify(Object.keys(cal)).slice(0, 120));

const EQ = 10000;
const candles = synth(0.022);
const price = candles.at(-1).close;

console.log('\n=== stop from calibration ===');
const st = risk.stopFromCalibration({ candles, price, horizonDays: 5, survival: 0.90, cal });
check('stop returned', !!st && !st.error);
check('stop strictly below entry', st.stop < price, `stop ${st.stop} vs price ${price.toFixed(2)}`);
check('stop distance positive and sane (<50%)', st.stopDistPct > 0 && st.stopDistPct < 50, `${st.stopDistPct}%`);
const st70 = risk.stopFromCalibration({ candles, price, horizonDays: 5, survival: 0.70, cal });
check('higher survival = wider stop', st.stopDistPct > st70.stopDistPct,
      `90%: ${st.stopDistPct}%  70%: ${st70.stopDistPct}%`);
const st1 = risk.stopFromCalibration({ candles, price, horizonDays: 1, survival: 0.90, cal });
check('longer horizon = wider stop', st.stopDistPct > st1.stopDistPct,
      `5d: ${st.stopDistPct}%  1d: ${st1.stopDistPct}%`);

console.log('\n=== fixed-fractional sizing ===');
const sz = risk.sizePosition({ equity: EQ, entry: price, stop: st.stop, riskPctPerTrade: 1 });
check('sizing returned shares', sz && sz.shares > 0, JSON.stringify(sz));
check('actual risk never exceeds requested', sz.riskPctActual <= 1.0 + 1e-9, `${sz.riskPctActual}%`);
check('notional within maxPositionPct', sz.positionPct <= risk.DEFAULTS.maxPositionPct + 1e-9, `${sz.positionPct}%`);
const tight = risk.sizePosition({ equity: EQ, entry: 100, stop: 99, riskPctPerTrade: 1 });
check('tight stop is capped, not absurd', tight.cappedByMaxPosition && tight.positionPct <= 25 + 1e-9,
      `${tight.positionPct}% capped=${tight.cappedByMaxPosition}`);
const wide = risk.sizePosition({ equity: EQ, entry: 100, stop: 50, riskPctPerTrade: 1 });
check('tighter stop yields more shares than wider', tight.shares > wide.shares,
      `tight ${tight.shares} vs wide ${wide.shares}`);
check('rejects stop above entry', risk.sizePosition({ equity: EQ, entry: 100, stop: 101 }) === null);
check('rejects zero equity', risk.sizePosition({ equity: 0, entry: 100, stop: 90 }) === null);

// Regression: BTC at ~$77k on $10k equity floored to 0 whole units, which
// silently blocked every crypto position, and the zero-size return was missing
// fields so it rendered as "$undefined".
console.log('\n=== fractional units (crypto) ===');
const btcWhole = risk.sizePosition({ equity: EQ, entry: 76908, stop: 70430, riskPctPerTrade: 1 });
const btcFrac = risk.sizePosition({ equity: EQ, entry: 76908, stop: 70430, riskPctPerTrade: 1, fractional: true });
check('whole-share mode yields 0 units on a $77k asset', btcWhole.shares === 0);
check('zero-size return still has every field (no undefined)',
      ['notional', 'dollarRisk', 'riskPctActual', 'positionPct'].every(k => typeof btcWhole[k] === 'number'),
      JSON.stringify(btcWhole));
check('zero-size return explains itself', typeof btcWhole.reason === 'string' && /fractional/.test(btcWhole.reason));
check('fractional mode sizes a real position', btcFrac.shares > 0 && btcFrac.notional > 0,
      `${btcFrac.shares} units = $${btcFrac.notional}`);
check('fractional risk still honours the 1% budget', Math.abs(btcFrac.riskPctActual - 1) < 0.01,
      `${btcFrac.riskPctActual}%`);
check('fractional respects a coarser minUnit',
      risk.sizePosition({ equity: EQ, entry: 76908, stop: 70430, fractional: true, minUnit: 0.001 }).shares
      === Math.floor(btcFrac.shares / 0.001) * 0.001,
      'quantization to 0.001');

console.log('\n=== volatility targeting ===');
// The cap must be lifted to test the SIZING MATH, otherwise both cases clamp to
// 25% and the comparison asserts nothing. The cap itself is tested separately.
const uncapped = { maxPositionPct: 1000, cal };
const calm = risk.sizeByVolTarget({ equity: EQ, price: synth(0.008).at(-1).close, candles: synth(0.008), ...uncapped });
const wild = risk.sizeByVolTarget({ equity: EQ, price: synth(0.070).at(-1).close, candles: synth(0.070), ...uncapped });
check('higher asset vol yields smaller position %', wild.positionPct < calm.positionPct,
      `calm ${calm.positionPct}% (vol ${calm.assetAnnualVol}%) vs wild ${wild.positionPct}% (vol ${wild.assetAnnualVol}%)`);
const capped = risk.sizeByVolTarget({ equity: EQ, price: synth(0.008).at(-1).close, candles: synth(0.008), cal });
check('cap binds when the vol target would exceed it',
      capped.cappedByMaxPosition && capped.positionPct <= 25 + 1e-9,
      `${capped.positionPct}% capped=${capped.cappedByMaxPosition}`);

console.log('\n=== portfolio heat ===');
const heat = risk.portfolioHeat({ equity: EQ, positions: [
    { shares: 10, entry: 100, stop: 95 }, { shares: 20, entry: 50, stop: 47 },
]});
check('heat computed', heat && heat.dollarRisk === 110, JSON.stringify(heat));
check('heat under cap not flagged', !heat.overHeat, `${heat.heatPct}%`);
const hot = risk.portfolioHeat({ equity: EQ, positions: [{ shares: 200, entry: 100, stop: 95 }] });
check('heat over cap IS flagged', hot.overHeat, `${hot.heatPct}%`);
check('remaining budget floors at zero', hot.remainingRiskBudget === 0, `${hot.remainingRiskBudget}`);

console.log('\n=== kill switch ===');
check('halts at threshold', risk.killSwitch({ peakEquity: 100, currentEquity: 80 }).halted);
check('does not halt above threshold', !risk.killSwitch({ peakEquity: 100, currentEquity: 90 }).halted);

console.log('\n=== Kelly, gated on statistical power ===');
const kSmall = risk.kellyFraction({ winRate: 0.53, payoffRatio: 1, n: 40 });
check('refuses 53% on 40 trades', kSmall.fractionOfEquity === 0 && /sample too small/.test(kSmall.reason),
      kSmall.reason);
check('states the trades required', kSmall.tradesRequired > 1000, `${kSmall.tradesRequired}`);
const kBig = risk.kellyFraction({ winRate: 0.53, payoffRatio: 1, n: 5000 });
check('allows 53% on 5000 trades', kBig.fractionOfEquity > 0, JSON.stringify(kBig));
check('returns FRACTIONAL not full Kelly', kBig.fractionOfEquity < kBig.fullKelly, `${kBig.fractionOfEquity} < ${kBig.fullKelly}`);
check('coin flip sizes to zero', risk.kellyFraction({ winRate: 0.5, payoffRatio: 1, n: 1e6 }).fractionOfEquity === 0);
const kNeg = risk.kellyFraction({ winRate: 0.45, payoffRatio: 1, n: 1e6 });
check('losing edge sizes to zero', kNeg.fractionOfEquity === 0, kNeg.reason);

console.log('\n=== the volatility-drag lesson this module exists to prevent ===');
// Exactly 50% wins, strictly alternating, so this isolates PURE drag with zero
// luck. Each win/loss pair multiplies balance by (1 + f*m)(1 - f*m) = 1 - f^2*m^2,
// so the damage scales with the SQUARE of position size. Move size is set to 10%,
// which is a normal day in the penny universe this app scans; at large-cap 2%
// moves the drag is real but mild, which is why the effect must be tested at the
// volatility the app actually trades.
function drag(frac, trades = 2000, move = 0.10) {
    let bal = 1;
    for (let i = 0; i < trades; i++) bal *= 1 + frac * (i % 2 === 0 ? move : -move);
    return bal;
}
const full = drag(1.0), quarter = drag(0.25), twoPct = drag(0.02);
console.log(`  100% of balance per trade : ${full.toExponential(2)}x  (this is the -99.6% artifact)`);
console.log(`   25% of balance per trade : ${quarter.toFixed(3)}x`);
console.log(`    2% of balance per trade : ${twoPct.toFixed(3)}x`);
check('full-balance sizing destroys a 50% win-rate series', full < 0.001, `${full.toExponential(2)}x`);
check('quarter sizing survives, degraded', quarter > 0.4 && quarter < 1, `${quarter.toFixed(3)}x`);
check('small fractional sizing is nearly unharmed', twoPct > 0.99, `${twoPct.toFixed(3)}x`);
check('drag scales with the SQUARE of size', Math.abs((1 - quarter) / (1 - twoPct)) > 50,
      `1-quarter=${(1 - quarter).toFixed(4)} vs 1-twoPct=${(1 - twoPct).toFixed(6)}`);

console.log('\n=== assessPosition gates ===');
const okA = await risk.assessPosition({ equity: EQ, price, candles, horizonDays: 5 });
check('clean case allowed', okA.allowed, JSON.stringify(okA.blockedBy));
const halted = await risk.assessPosition({ equity: 7000, price, candles, peakEquity: 10000 });
check('blocked by kill switch', !halted.allowed && halted.blockedBy.some(b => /kill switch/.test(b)),
      JSON.stringify(halted.blockedBy));
const overheat = await risk.assessPosition({ equity: EQ, price, candles,
    openPositions: [{ shares: 300, entry: 100, stop: 95 }] });
check('blocked by portfolio heat', !overheat.allowed && overheat.blockedBy.some(b => /heat/.test(b)),
      JSON.stringify(overheat.blockedBy));

console.log(`\n${fail === 0 ? 'RISK CHECK PASS' : 'RISK CHECK FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
