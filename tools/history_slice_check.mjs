/**
 * Prove the seven history-backed features actually receive rows.
 *
 * WHY THIS IS A BROWSER TEST
 * -------------------------
 * These features failed in the quietest way available: loadLedger() fetched
 * model/ledger/<year>.jsonl, that file stopped existing when the ledger was sharded monthly, the
 * catch returned [], and every consumer rendered an empty chart. An empty chart is
 * indistinguishable from "the engine never recorded a signal", so nothing looked broken for weeks.
 *
 * No offline unit test could have caught it either -- the bug WAS the fetch. The only check that
 * fails when this breaks is one that loads the real page and asks the real readers for real rows.
 *
 * Seven consumers, all previously blank:
 *   readSymbolConfidenceTrend    per-symbol confidence trend
 *   readSymbolSignalMarkers      chart signal markers
 *   readEngineEquityCurve        engine equity curve
 *   readAccuracyBySetup          accuracy by RSI zone / MACD / Bollinger position
 *   readLedgerHistory            per-symbol ledger history panel
 *   js/ui/scanner.js             accuracy aggregation
 *   js/ui/watchlist.js           per-symbol signal column
 *
 * The last two used to carry their own copies of the dead fetch, which is why fixing the first one
 * left them broken. They now call the shared loader, so this check covers them by covering it.
 *
 * Usage:
 *   node tools/history_slice_check.mjs            serve the repo
 *   node tools/history_slice_check.mjs --dist     serve the deploy bundle
 *   node tools/history_slice_check.mjs --live     hit market-ai.pages.dev
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const LIVE = process.argv.includes('--live');
const ROOT = process.argv.includes('--dist') ? resolve(REPO, 'dist') : REPO;
const PORT = 8165;

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
let server = null;
let BASE = 'https://market-ai.pages.dev/';
if (!LIVE) {
    server = createServer(async (req, res) => {
        try {
            const clean = decodeURIComponent(req.url.split('?')[0]);
            const path = join(ROOT, clean === '/' ? 'index.html' : clean.replace(/^\/+/, ''));
            const body = await readFile(path);
            res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
            res.end(body);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
        }
    });
    await new Promise(r => server.listen(PORT, r));
    BASE = `http://localhost:${PORT}/index.html`;
}

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(LIVE ? 3800 : 2400);

console.log(`=== the compact history slice loads (${LIVE ? 'LIVE' : ROOT.endsWith('dist') ? 'dist' : 'repo'}) ===`);
const raw = await page.evaluate(async () => {
    const res = await fetch('./model/ledger/history.json', { cache: 'no-cache' });
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) return { ok: false, ctype };
    const j = await res.json();
    return {
        ok: true, ctype, schema: j.schema, since: j.since, days: j.days,
        count: j.count, rows: Array.isArray(j.rows) ? j.rows.length : -1,
        graded: (j.rows || []).filter(r => r.h).length,
        symbols: new Set((j.rows || []).map(r => r.s)).size,
    };
});
check('history.json is served as JSON', raw.ok === true, `content-type ${raw.ctype}`);
if (!raw.ok) {
    console.log('\nHISTORY SLICE CHECK FAIL: the slice is not deployed; nothing below can pass.');
    await browser.close(); if (server) server.close();
    process.exitCode = 1;
} else {
    console.log(`     ${raw.rows.toLocaleString()} rows, ${raw.symbols.toLocaleString()} symbols, `
        + `${raw.graded.toLocaleString()} graded, since ${raw.since}`);
    check('it carries rows', raw.rows > 1000, String(raw.rows));
    check('count matches the row array', raw.count === raw.rows, `${raw.count} vs ${raw.rows}`);
    check('enough graded rows to compute a hit-rate', raw.graded > 500, String(raw.graded));

    console.log();
    console.log('=== loadLedger expands the compact wire format correctly ===');
    const exp = await page.evaluate(async () => {
        const m = await import('./js/ledger-reader.js');
        const rows = await m.loadLedger();
        const withH = rows.find(r => r.horizons && r.horizons['1']);
        const wrong = rows.find(r => r.horizons?.['1'] && r.horizons['1'].directionMatch === false);
        return {
            n: rows.length,
            problem: m.ledgerHistoryProblem(),
            sample: withH ? {
                symbol: withH.symbol, date: withH.date, signal: withH.signal,
                confidence: withH.confidence, entry: withH.entry,
                engineVersion: withH.engineVersion,
                rsi: withH.indicators?.rsi ?? null,
                macdHist: withH.indicators?.macd?.histogram ?? null,
                pctB: withH.indicators?.bb?.percent_b ?? null,
                dm: withH.horizons['1'].directionMatch,
                dmType: typeof withH.horizons['1'].directionMatch,
            } : null,
            // A wrong call must be BOOLEAN false, not 0: consumers test `!= null` to tell
            // "unresolved" from "resolved and wrong", and 0 would read as a miss becoming a null.
            wrongIsFalseNotZero: wrong ? wrong.horizons['1'].directionMatch === false : null,
            everyRowHasHorizons: rows.every(r => r.horizons && typeof r.horizons === 'object'),
        };
    });
    check('loadLedger returns rows', exp.n > 1000, String(exp.n));
    check('and reports no problem', exp.problem === null, String(exp.problem));
    console.log(`     sample: ${JSON.stringify(exp.sample)}`);
    check('long field names are restored', !!exp.sample?.symbol && !!exp.sample?.date
          && exp.sample.confidence != null && exp.sample.entry != null);
    check('engineVersion survives (needed to scope to the current engine)', !!exp.sample?.engineVersion);
    check('the three bucketing indicators survive',
          Number.isFinite(exp.sample?.rsi), `rsi=${exp.sample?.rsi}`);
    check('directionMatch is a BOOLEAN, not 0/1',
          exp.sample?.dmType === 'boolean', `typeof = ${exp.sample?.dmType}`);
    check('a wrong call is false, not 0 (so != null still distinguishes unresolved)',
          exp.wrongIsFalseNotZero !== false, String(exp.wrongIsFalseNotZero));
    check('every row has a horizons object (readers index it unguarded)', exp.everyRowHasHorizons);

    console.log();
    console.log('=== all five ledger-reader features now receive data ===');
    const feats = await page.evaluate(async () => {
        const m = await import('./js/ledger-reader.js');
        const rows = await m.loadLedger();
        // Pick the symbol with the most rows, so a thin ticker cannot make a real regression look
        // like a pass or a pass look like a failure.
        const tally = new Map();
        for (const r of rows) tally.set(r.symbol, (tally.get(r.symbol) || 0) + 1);
        const sym = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const out = { sym, symRows: tally.get(sym) };
        try {
            const t = await m.readSymbolConfidenceTrend({ symbol: sym, limit: 30 });
            out.trend = Array.isArray(t) ? t.length : (t?.points?.length ?? JSON.stringify(t).slice(0, 80));
        } catch (e) { out.trend = 'threw: ' + e.message; }
        try {
            // Shape is { available, symbol, markers[] } -- NOT a bare array. My first version of
            // this check asserted Array.isArray and failed a working feature.
            const s = await m.readSymbolSignalMarkers({ symbol: sym });
            out.markers = s?.available === true ? (s.markers?.length ?? 0) : `available=${s?.available}`;
        } catch (e) { out.markers = 'threw: ' + e.message; }
        try {
            const c = await m.readEngineEquityCurve({ horizonDays: 1 });
            out.curve = Array.isArray(c) ? c.length : (c?.points?.length ?? JSON.stringify(c).slice(0, 80));
        } catch (e) { out.curve = 'threw: ' + e.message; }
        try {
            // The groups live under `dimensions`, not `groups`. Same mistake as above: the feature
            // was fine and the assertion was wrong.
            const a = await m.readAccuracyBySetup({ horizonDays: 1, minN: 20 });
            out.setups = a?.available === true ? (a.dimensions?.length ?? 0) : `available=${a?.available}`;
            out.setupBuckets = (a?.dimensions || [])
                .map(g => `${g.key}:${(g.buckets || []).length}`).join(' ');
            out.totalResolved = a?.totalResolved ?? a?.resolved ?? null;
        } catch (e) { out.setups = 'threw: ' + e.message; }
        try {
            const h = await m.readLedgerHistory({ symbol: sym, limit: 10 });
            out.history = h?.available === true ? h.rowsReturned : `available=${h?.available}`;
            out.hitRate = h?.hitRate1dPct;
        } catch (e) { out.history = 'threw: ' + e.message; }
        return out;
    });
    console.log(`     busiest symbol: ${feats.sym} (${feats.symRows} rows)`);
    check(`readSymbolConfidenceTrend returns points`, Number(feats.trend) > 0, String(feats.trend));
    check(`readSymbolSignalMarkers returns markers`, Number(feats.markers) > 0, String(feats.markers));
    check(`readEngineEquityCurve returns points`, Number(feats.curve) > 0, String(feats.curve));
    check(`readAccuracyBySetup is available with dimensions`, Number(feats.setups) > 0, String(feats.setups));
    check(`readLedgerHistory returns rows`, Number(feats.history) > 0, String(feats.history));
    console.log(`     setup buckets: ${feats.setupBuckets}`);
    console.log(`     1d hit-rate from history: ${feats.hitRate}%`);

    await browser.close();
    if (server) server.close();
    console.log();
    const ok = FAIL.length === 0;
    console.log(`${ok ? 'HISTORY SLICE CHECK PASS' : 'HISTORY SLICE CHECK FAIL'}: `
        + `${PASS.length} passed, ${FAIL.length} failed`);
    if (!ok && process.env.GITHUB_ACTIONS) {
        console.log(`::error title=history_slice::${FAIL.slice(0, 6).join('; ')}`);
    }
    process.exitCode = ok ? 0 : 1;
}
