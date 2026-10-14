// The prediction card's call (js/ui/forecast-cards.js): every state, and nothing that is not
// measured. Synthetic inputs, no network.
//
// Run: node tools/forecast_cards_check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const imp = (p) => import(pathToFileURL(path.join(repo, p)).href);
const sessions = await imp('js/market-sessions.js');
sessions.setMarketSessions(JSON.parse(fs.readFileSync(path.join(repo, 'model', 'market_sessions.json'), 'utf8')));
const fc = await imp('js/ui/forecast-cards.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};

const cell = { hitRate: 0.6765, n: 15693, netBps: 16.2, positiveYears: 8, years: 11 };
console.log('=== the call comes only from measured patterns ===');
let c = fc.decideCall({ rs: null, owned: false });
check('nothing measured -> DON\'T BUY, no confidence', c.kind === 'DONT_BUY' && c.confidence === null, JSON.stringify(c));
c = fc.decideCall({ rs: null, owned: true });
check('nothing measured, owned -> HOLD, no confidence', c.kind === 'HOLD' && c.confidence === null);
c = fc.decideCall({ rs: { active: true, reliable: true, cell }, owned: false });
check('a live setup -> BUY at its measured profitability', c.kind === 'BUY' && c.confidence === cell.hitRate);
check('...worded as trades that sold above their entry, not "recovered"', /sold above their entry/.test(c.line) && !/recovered|closed back above/.test(c.line), c.line);
c = fc.decideCall({ rs: { active: true, reliable: false, cell }, owned: false });
check('an unreliable cell never makes a BUY', c.kind === 'DONT_BUY');
const rec = (status, extra = {}) => ({ record: { symbol: [{ status, session: '2026-10-12', entryDate: '2026-10-13', hitRate: 0.67, expNetBps: 25, ...extra }] } });
check('pending entry, not owned -> BUY', fc.decideCall({ rs: rec('pending'), owned: false }).kind === 'BUY');
check('pending entry, owned -> HOLD', fc.decideCall({ rs: rec('pending'), owned: true }).kind === 'HOLD');
check('exit fired, owned -> SELL', fc.decideCall({ rs: rec('exiting'), owned: true }).kind === 'SELL');
check('exit fired, not owned -> DON\'T BUY', fc.decideCall({ rs: rec('exiting'), owned: false }).kind === 'DONT_BUY');
check('older open trade, not owned -> DON\'T BUY (buying later is not the trade)', fc.decideCall({ rs: rec('open'), owned: false }).kind === 'DONT_BUY');

console.log('\n=== the gap rule: only on a real gap, in session, liquid, earnings known and clear ===');
const gapRec = JSON.parse(fs.readFileSync(path.join(repo, 'model', 'gap_fade.json'), 'utf8'));
const band = { anchor: { session: '2026-10-12', price: 100, day1: '2026-10-13' }, sigmaDaily: 1.5, earningsDay: 0 };
const midSession = Date.parse('2026-10-13T16:00:00Z');   // 12:00 New York
const big = { open: 103.5, high: 104, low: 102 };          // +3.4% against a 1.5% sigma
const small = { open: 101.0, high: 101.5, low: 100.5 };
check('a 2.3-sigma gap fires', !!fc.gapSignal({ rec: gapRec, band, todayBar: big, liquid: true, region: 'NYSE', nowMs: midSession }));
check('a small gap does not', !fc.gapSignal({ rec: gapRec, band, todayBar: small, liquid: true, region: 'NYSE', nowMs: midSession }));
check('not liquid: no', !fc.gapSignal({ rec: gapRec, band, todayBar: big, liquid: false, region: 'NYSE', nowMs: midSession }));
check('earnings today: no', !fc.gapSignal({ rec: gapRec, band: { ...band, earningsDay: 1 }, todayBar: big, liquid: true, region: 'NYSE', nowMs: midSession }));
check('earnings calendar unknown: no', !fc.gapSignal({ rec: gapRec, band: { ...band, earningsDay: null }, todayBar: big, liquid: true, region: 'NYSE', nowMs: midSession }));
check('after the close: no', !fc.gapSignal({ rec: gapRec, band, todayBar: big, liquid: true, region: 'NYSE', nowMs: Date.parse('2026-10-13T21:00:00Z') }));
check('not a US listing: no', !fc.gapSignal({ rec: gapRec, band, todayBar: big, liquid: true, region: 'LSE', nowMs: midSession }));
const g = fc.gapSignal({ rec: gapRec, band, todayBar: big, liquid: true, region: 'NYSE', nowMs: midSession });
c = fc.decideCall({ rs: null, owned: false, gap: g });
check('gap, not owned -> DON\'T BUY at the measured rate', c.kind === 'DONT_BUY' && c.confidence === gapRec.closedBelowOpen, JSON.stringify(c).slice(0, 200));
check('gap, owned -> HOLD, never SELL', fc.decideCall({ rs: null, owned: true, gap: g }).kind === 'HOLD');
check('a live setup outranks the gap note', fc.decideCall({ rs: { active: true, reliable: true, cell }, owned: false, gap: g }).kind === 'BUY');

console.log('\n=== Hot Picks and the card read one range for today (headlineRange) ===');
// DOCN on 2026-10-14: locked at the 10-13 close of $128.21, then down 14% to $110 by midday.
const intraday = JSON.parse(fs.readFileSync(path.join(repo, 'model', 'band_intraday.json'), 'utf8'));
const docn = { confidence: 80, sigmaDaily: 3.4, volTier: 'active',
    anchor: { session: '2026-10-13', price: 128.21, day1: '2026-10-14' },
    days: [{ day: 1, low: 119.99, high: 136.99 }, { day: 2, low: 116.4, high: 141.2 }, { day: 3, low: 114.1, high: 144.0 }] };
const traded = { high: 127.6, low: 109.5, open: 127.02 };
const noon = Date.parse('2026-10-14T17:00:00Z');                    // 13:00 New York
const r = fc.headlineRange({ band: docn, price: 110.16, region: 'NYSE', todayBar: traded, intraday, nowMs: noon });
check('a stock that fell out of its locked band: the range follows the session', r && r.low < 109.5 && r.high >= 127.6, JSON.stringify(r && { low: r.low, high: r.high }));
check('...so its low is never above the live price', r && r.low < 110.16);
check('...and it is marked live', r && r.liveF != null && r.date === '2026-10-14');
const pre = fc.headlineRange({ band: docn, price: 128.21, region: 'NYSE', todayBar: null, intraday, nowMs: Date.parse('2026-10-14T12:00:00Z') });
check('before the open: the locked band itself', pre && pre.low === 119.99 && pre.high === 136.99 && pre.liveF == null, JSON.stringify(pre && { low: pre.low, high: pre.high }));
const nxt = fc.headlineRange({ band: docn, price: 110.16, region: 'NYSE', todayBar: traded, intraday, nowMs: noon, next: true });
check('the Tomorrow view reads the next session, started from the live price', nxt && nxt.date === '2026-10-15'
    && nxt.low < 110.16 && nxt.high > 110.16, JSON.stringify(nxt && { date: nxt.date, low: nxt.low, high: nxt.high }));
const day2 = r.rows.thisWeek.find(x => x.date === '2026-10-15');
check('...keeping the band it replaced, to show', day2 && day2.morningLow === 116.4 && day2.fromPrice === 110.16);
// Variance interpolation is exact at the ends: f = 1 gives the original width around the price.
const atOpen = fc.weekRows({ band: docn, history: null, region: 'NYSE', cryptoMode: false, todayBar: traded,
    live: { low: 100, high: 130, f: 1, confidence: 80 }, price: 128.21, nowMs: noon });
const o2 = atOpen.thisWeek.find(x => x.date === '2026-10-15');
check('with the whole session left, day 2 is the locked band', o2 && Math.abs(o2.low - 116.4) < 1e-6 && Math.abs(o2.high - 141.2) < 1e-6, JSON.stringify(o2 && { low: o2.low, high: o2.high }));

// DOCN again: RSI(2) 6.2 in an uptrend is the setup, but its cell (wild volatility, VIX under 20)
// has lost money. The card must say why there is no BUY instead of listing the conditions as met.
const wildLow = { n: 691, hitRate: 0.5687, netBps: -69.5, netBpsLo95: -158.6 };
const html = fc.renderForecastCards({ symbol: 'DOCN', band: docn, price: 110.16, region: 'NYSE', owned: false,
    rs: { active: true, eligible: true, reliable: false, forming: true, rsi2: 6.2, tier: 'wild', vixBand: 'low',
          cell: wildLow, price: 110.16, ma200: 108.64 } });
check('an unreliable setup cell: DON\'T BUY, and the card says it has not paid there', /DON'T BUY/.test(html)
    && /not where it has paid/.test(html) && /-0\.(69|70)%/.test(html), html.match(/So the dip[^<]*/)?.[0] || 'missing');

const quirk = fc.todayPartialBar([{ time: Date.parse('2026-10-14T13:30:00Z') / 1000, open: 127.02, high: 126.19, low: 108.08, close: 110.19 }], 'NYSE', noon);
check("Yahoo's live bar with a high under its open: the open still counts as traded", quirk && quirk.high === 127.02 && quirk.low === 108.08, JSON.stringify(quirk));

console.log(`\n${fail ? 'FORECAST CARDS CHECK FAIL' : 'FORECAST CARDS CHECK PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
