/**
 * Assert the macro/beta layer works, and specifically that `market` is per-symbol.
 *
 * The bug this guards against is subtle because nothing throws: getMarketConditionsScore
 * takes the MODE, not the symbol, so it returned the same number for every name (measured at
 * 67 for 40 of 41 in a live scan). A constant cannot change a cross-sectional ranking, so a
 * quarter of the engine's weight was being spent on a term that was mathematically incapable
 * of affecting selection -- while still compressing the range the score could span.
 *
 * The load-bearing assertion here is therefore that two symbols with DIFFERENT betas get
 * different market scores from the same market-wide reading.
 *
 * Network assertions are tolerant: FRED being unreachable in CI is not a code defect, and a
 * check that fails on someone else's outage gets ignored and then removed. Those cases print
 * SKIP. The pure math is asserted unconditionally.
 *
 * Run: node tools/macro_check.mjs
 */
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const macro = await import(pathToFileURL(join(REPO, 'js', 'macro.js')).href);

const PASS = [], FAIL = [], SKIP = [];
const ck = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};
const skip = (name, why) => { SKIP.push(name); console.log(`  SKIP  ${name}  (${why})`); };

console.log('=== FRED CSV parsing ===');
const csv = [
    'observation_date,T10Y2Y',
    '2026-08-27,0.38',
    '2026-08-28,.',          // FRED uses '.' for a missing observation
    '2026-08-31,0.41',
].join('\n');
const rows = macro.parseFredCsv(csv);
ck('parses dated rows and skips the header', rows.length === 2, JSON.stringify(rows));
// Coercing '.' to 0 would read as a yield curve of exactly zero, i.e. an inversion scare.
ck("drops '.' rather than reading it as 0", rows.every(r => r.value !== 0), JSON.stringify(rows));
ck('keeps values in order', rows[0].date < rows[1].date);
ck('garbage in gives nothing out, not a throw', macro.parseFredCsv('nonsense').length === 0);
ck('empty input is handled', macro.parseFredCsv('').length === 0);

console.log('');
console.log('=== beta ===');
const bench = Array.from({ length: 140 }, (_, i) => 100 * Math.exp(0.001 * i + 0.01 * Math.sin(i)));
const lever = (k) => {
    const out = [100];
    for (let i = 1; i < bench.length; i++) out.push(out[i - 1] * (1 + k * (bench[i] / bench[i - 1] - 1)));
    return out;
};
ck('identical series has beta 1', Math.abs(macro.computeBeta(bench.slice(), bench) - 1) < 1e-6);
ck('2x levered series has beta 2', Math.abs(macro.computeBeta(lever(2), bench) - 2) < 1e-6);
ck('inverse series has negative beta', macro.computeBeta(lever(-1), bench) < 0);
// A fabricated default of 1.0 would silently reinstate the very constant this module removes.
ck('too little overlap returns null, not a default',
   macro.computeBeta(bench.slice(0, 10), bench) === null);
ck('non-array input returns null', macro.computeBeta(null, bench) === null);
ck('beta is clamped to a plausible range',
   macro.computeBeta(lever(40), bench) <= 3.0, String(macro.computeBeta(lever(40), bench)));

console.log('');
console.log('=== the tilt is what makes market PER-SYMBOL ===');
const hi = macro.betaAdjustedMarketScore(70, 1.6);
const lo = macro.betaAdjustedMarketScore(70, 0.3);
ck('same market reading gives DIFFERENT scores for different betas', hi !== lo, `${hi} vs ${lo}`);
ck('high beta amplifies a strong tape', hi > 70, String(hi));
ck('low beta is pulled toward neutral', lo < 70 && lo > 50, String(lo));
ck('high beta is punished harder by a weak tape',
   macro.betaAdjustedMarketScore(30, 1.6) < 30, String(macro.betaAdjustedMarketScore(30, 1.6)));
ck('beta 1 leaves the reading unchanged', macro.betaAdjustedMarketScore(64, 1) === 64);
ck('a neutral market stays neutral at any beta',
   macro.betaAdjustedMarketScore(50, 2.5) === 50);
ck('output stays inside 0-100', macro.betaAdjustedMarketScore(100, 3) <= 100
   && macro.betaAdjustedMarketScore(0, 3) >= 0);
// Without beta the honest thing is to pass the market reading through unchanged, NOT to
// invent a sensitivity.
ck('missing beta passes the reading through', macro.betaAdjustedMarketScore(64, null) === 64);

console.log('');
console.log('=== blending mood with regime ===');
const blended = macro.marketScoreForSymbol(
    { score: 80, available: true }, { score: 40, available: true }, 1);
ck('mood and regime are equally weighted', blended.score === 60, JSON.stringify(blended));
ck('an unavailable input is dropped, not counted as 50',
   macro.marketScoreForSymbol({ score: 80, available: true },
                              { score: 50, available: false }, 1).score === 80);
ck('nothing available means the source abstains',
   macro.marketScoreForSymbol({ available: false }, { available: false }, 1).available === false);
ck('beta is reported for the audit trail', blended.beta === 1);
ck('the untilted market-wide value is also reported', blended.marketWide === 60);

console.log('');
console.log('=== live FRED (tolerant: an outage is not a code defect) ===');
try {
    const m = await macro.getMacroScore();
    if (!m.available) {
        skip('FRED reachable', 'no series resolved');
    } else {
        ck('FRED needs no API key and returns a usable score',
           m.score >= 0 && m.score <= 100, JSON.stringify(m.score));
        ck('at least two series resolved', (m.componentsUsed || 0) >= 2, String(m.componentsUsed));
        const dated = Object.values(m.components).filter(Boolean);
        ck('every component carries an asOf date', dated.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.asOf)),
           JSON.stringify(dated.map(c => c.asOf)));
        ck('it explains itself in words', (m.reasons || []).length >= 2);
        console.log(`    score ${m.score} from ${m.componentsUsed} series: `
            + Object.entries(m.components).filter(([, v]) => v)
                .map(([k, v]) => `${k}=${v.score}`).join(' '));
    }
} catch (e) {
    skip('FRED reachable', e.message.slice(0, 60));
}

console.log('');
console.log(`${FAIL.length ? 'MACRO CHECK FAIL' : 'MACRO CHECK PASS'}: `
    + `${PASS.length} passed, ${FAIL.length} failed, ${SKIP.length} skipped`);
if (FAIL.length && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=macro_check::${FAIL.slice(0, 6).join('; ')}`);
}
// process.exitCode, NOT process.exit(). Calling process.exit() while a keep-alive fetch
// socket is still open crashes libuv on Windows:
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\winsync.c, line 76
// The 28 assertions had all passed and the harness still reported a nonzero exit, which is
// the worst kind of test failure: one that says "broken" about working code. Setting the
// code and letting Node drain its handles exits cleanly on every platform.
process.exitCode = FAIL.length ? 1 : 0;
