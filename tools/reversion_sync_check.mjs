// JS half of tools/reversion_sync_check.py. Usage: node tools/reversion_sync_check.mjs <in.json> <repo>
// Must live inside the repo (Git Bash turns /tmp into a path native node cannot find).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [inputPath, repoRoot] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const tg = await load('js/trend-gate.js');
const rv = await load('js/reversion-setup.js');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const out = {};
// A fixed instant after the New York close, so `forming` cannot differ with the wall clock.
const AFTER_CLOSE = Date.parse('2026-09-29T21:30:00Z');
for (const [name, bars] of Object.entries(input.cases)) {
    const state = tg.trendState(bars);
    const setup = {};
    for (const [k, v] of Object.entries(input.vixes)) {
        const r = rv.evaluateReversionSetup({ history: bars, region: 'NYSE', vix: v, cal: input.cal, nowMs: AFTER_CLOSE });
        setup[k] = r === null ? null : {
            eligible: r.eligible, active: r.active, reliable: !!r.reliable, tier: r.tier,
            vixBand: r.vixBand, rsi2: r.rsi2, trigger: r.trigger,
        };
    }
    out[name] = { gate: { BUY: tg.trendGate('BUY', state, 'NYSE'), SELL: tg.trendGate('SELL', state, 'NYSE') }, setup };
}
process.stdout.write(JSON.stringify(out));
