/**
 * One day, one range: every block on the prediction card that shows a day's range must show the
 * SAME range for it, for every symbol shape.
 *
 * WHY
 * ---
 * Roshan found INTC with two different expected highs for the same day in two blocks, and was
 * right that checking three US large caps afterwards proved nothing about the universe. The blocks
 * have changed since (2026-10-14: the call card's big bar, This week and Next week, and the "Last 7
 * sessions" record below them) but the promise is the same, so this checks it on the current page:
 *
 *   1. the big bar's range is the range of the day it names, in the week cards
 *   2. each day in the record table carries the same range as that day in the week cards
 *   3. no day in the week cards is listed without a range
 *   4. every price on the card is in one currency (no native mixed with converted)
 *
 * The categories matter more than the count: calibrated US, low-priced, crypto (no session, its
 * own calendar), and Mumbai, London, Tokyo, Hong Kong and Frankfurt sessions.
 *
 * Network failures are WARNINGS: a symbol Yahoo will not serve today is an outage, not a bug.
 *
 * Usage:
 *   node tools/band_agreement_check.mjs
 *   node tools/band_agreement_check.mjs --symbols AAPL,7203.T
 *   node tools/band_agreement_check.mjs --live      (run against the deployed site)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const ROOT = process.argv.includes('--dist') ? resolve(REPO, 'dist') : REPO;
const PORT = 8161;
const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const LIVE = args.includes('--live');
const DEFAULT_SYMBOLS = ['AAPL', 'NVDA', 'PLUG', 'BTC-USD', 'RELIANCE.NS', 'BP.L', '7203.T', '0700.HK', 'SAP.DE'];
const SYMBOLS = flag('symbols', '') ? flag('symbols', '').split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SYMBOLS;

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

const PASS = [], FAIL = [], WARN = [];
const ok = (n) => { PASS.push(n); };
const bad = (n, d) => { FAIL.push(n); console.log(`  FAIL  ${n}  -> ${d}`); };
const warn = (n, d) => { WARN.push(n); console.log(`  WARN  ${n}  -> ${d}`); };
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

const browser = await chromium.launch();
const CRYPTO_RE = /-USD$/i;

async function readSymbol(page, sym) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(LIVE ? 3800 : 2400);
    const isCrypto = CRYPTO_RE.test(sym);
    if (isCrypto) {
        await page.click('[data-tab="crypto"]').catch(() => null);
        await page.waitForTimeout(1800);
    }
    await page.fill('#search-input', isCrypto ? sym.replace(/-USD$/i, '') : sym);
    await page.waitForTimeout(2600);
    // The result list re-renders as results stream in, so it is clicked from inside the page
    // rather than through a locator that waits for it to hold still.
    const clicked = await page.evaluate(() => {
        const el = document.querySelector('#search-results .search-result-item, #search-results > *');
        if (el) { el.click(); return true; }
        return false;
    });
    if (!clicked) await page.press('#search-input', 'Enter');
    await page.waitForSelector('#signal-section .fc-signal', { timeout: 75_000 }).catch(() => null);
    await page.waitForTimeout(1500);
    return page.evaluate(() => {
        const sec = document.getElementById('signal-section');
        if (!sec || !sec.querySelector('.fc-signal')) return null;
        const num = (v) => (v === '' || v == null ? null : Number(v));
        const big = sec.querySelector('.fc-bigbar');
        return {
            big: big ? { date: big.dataset.date || null, low: num(big.dataset.low), high: num(big.dataset.high) } : null,
            days: [...sec.querySelectorAll('details.fc-day')].map(d => ({ date: d.dataset.date, kind: d.dataset.kind, low: num(d.dataset.low), high: num(d.dataset.high) })),
            record: [...sec.querySelectorAll('.fc-record .bh-row')].map(r => ({ date: r.dataset.date, low: num(r.dataset.low), high: num(r.dataset.high) })),
            currencies: [...new Set([...sec.querySelectorAll('[data-usd]')].map(e => e.getAttribute('data-src') || 'USD'))],
        };
    });
}

console.log(`=== one day, one range (${LIVE ? 'LIVE' : 'local'}) ===`);
const page = await browser.newPage();
for (const sym of SYMBOLS) {
    let r = null;
    try { r = await readSymbol(page, sym); } catch (e) { r = null; }
    if (!r) { warn(`${sym}: card rendered`, 'no prediction card (data source unavailable?)'); continue; }
    if (!r.big) { bad(`${sym}: the call card has its range bar`, 'no .fc-bigbar'); continue; }
    if (!(r.big.low < r.big.high)) bad(`${sym}: the bar's low is under its high`, JSON.stringify(r.big)); else ok(`${sym} bar`);

    const byDate = new Map(r.days.map(d => [d.date, d]));
    const row = byDate.get(r.big.date);
    if (!row) {
        // A band without a start date (old rows) has no week cards to compare with.
        if (r.days.length) bad(`${sym}: the bar's day is in the week cards`, `bar ${r.big.date}, days ${r.days.map(d => d.date).join(' ')}`);
        else warn(`${sym}: week cards`, 'none rendered');
    } else if (!same(row.low, r.big.low) || !same(row.high, r.big.high)) {
        bad(`${sym}: the bar and ${r.big.date} in the week cards agree`, `bar ${r.big.low}-${r.big.high}, row ${row.low}-${row.high}`);
    } else ok(`${sym} bar = row`);

    const empty = r.days.filter(d => d.kind !== 'past' && !(Number.isFinite(d.low) && Number.isFinite(d.high)));
    if (empty.length) bad(`${sym}: every day in the week cards has a range`, empty.map(d => d.date).join(', ')); else ok(`${sym} rows`);

    for (const rec of r.record) {
        const d = byDate.get(rec.date);
        if (!d || d.kind !== 'past') continue;           // older than this week: only in the record
        if (!same(d.low, rec.low) || !same(d.high, rec.high)) {
            bad(`${sym}: ${rec.date} reads the same in the record and the week card`, `record ${rec.low}-${rec.high}, week ${d.low}-${d.high}`);
        } else ok(`${sym} ${rec.date}`);
    }

    if (r.currencies.length > 1) bad(`${sym}: one currency across the card`, r.currencies.join(', ')); else ok(`${sym} currency`);
    console.log(`  ${sym}: bar ${r.big.date} ${r.big.low}-${r.big.high}, ${r.days.length} days, ${r.record.length} in the record, ${r.currencies.join('/') || 'no prices'}`);
}
await browser.close();
if (server) server.close();
console.log(`\n${FAIL.length ? 'BAND AGREEMENT CHECK FAIL' : 'BAND AGREEMENT CHECK PASS'}: ${PASS.length} passed, ${FAIL.length} failed, ${WARN.length} warnings`);
process.exit(FAIL.length ? 1 : 0);
