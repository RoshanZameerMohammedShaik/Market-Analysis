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
check('...worded as trades that were profitable, not "recovered"', /were profitable/.test(c.line) && !/closed back above/.test(c.line), c.line);
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

console.log(`\n${fail ? 'FORECAST CARDS CHECK FAIL' : 'FORECAST CARDS CHECK PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
