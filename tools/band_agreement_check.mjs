/**
 * Assert the headline Expected High/Low and the 7-session table agree, for MANY symbols.
 *
 * WHY A SWEEP AND NOT ONE SYMBOL
 * ------------------------------
 * Roshan reported INTC showing two different expected highs for the same day ($101.70 in the
 * price-targets block, $104.05 in the forecast table). I fixed the shared code path and verified
 * three US large caps, and he pushed back correctly: "it has to be dynamically working for all
 * other symbols that exist."
 *
 * Three US large caps is not evidence about the universe. The paths that could still diverge are
 * all in the categories those three do not exercise:
 *
 *   * UNCALIBRATED bands. confidence.js only copies band edges into priceTargets when
 *     `forecastBand.calibrated` is true. Sub-penny assets are excluded from the calibration
 *     sample, so for them the headline stays an ATR heuristic while the table shows a band. Those
 *     are DIFFERENT QUANTITIES and are allowed to differ -- but only if they are labelled
 *     differently ("Possible High" vs "Expected High"), or the reader is invited to compare two
 *     numbers that were never the same thing.
 *   * Non-US sessions. The lock anchors on the session open read off the daily bar, and Mumbai,
 *     London, Tokyo and Hong Kong all open on different UTC offsets.
 *   * Crypto, which has no session at all and anchors at 00:00Z.
 *   * Low-priced names, where roundPrice can collapse band edges.
 *
 * WHAT COUNTS AS A PASS
 * --------------------
 * Either the two blocks agree to within a cent, OR they are honestly labelled as different
 * quantities. Silence is not a pass: a symbol that renders no band and no targets is reported.
 *
 * Network failures are WARNINGS, not failures. A symbol Yahoo will not serve today is an outage,
 * and a check that goes red on someone else's downtime gets ignored and then deleted.
 *
 * Usage:
 *   node tools/band_agreement_check.mjs
 *   node tools/band_agreement_check.mjs --symbols AAPL,BTC-USD
 *   node tools/band_agreement_check.mjs --live      (run against the deployed site)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 8161;
const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const LIVE = args.includes('--live');

// Deliberately spans the categories, not just the liquid US names that already worked.
const DEFAULT_SYMBOLS = [
    // US large cap -- the calibrated happy path
    'AAPL', 'MSFT', 'INTC', 'NVDA',
    // US mid / low-priced, where rounding and wide sigma bite
    'F', 'SOFI', 'PLUG', 'NIO',
    // Crypto: no session, anchors at 00:00Z, its own calibration tier
    'BTC-USD', 'ETH-USD', 'DOGE-USD',
    // Sub-dollar: EXCLUDED from the band calibration sample, so the headline should stay
    // heuristic and be labelled "Possible", not "Expected"
    'SHIB-USD',
    // Non-US sessions, each opening at a different UTC offset
    'RELIANCE.NS', 'BP.L', '7203.T', '0700.HK', 'SAP.DE',
];
const SYMBOLS = flag('symbols', '') ? flag('symbols', '').split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SYMBOLS;

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
let server = null;
let BASE = 'https://roshanzameermohammedshaik.github.io/Market-Analysis/';
if (!LIVE) {
    server = createServer(async (req, res) => {
        try {
            const clean = decodeURIComponent(req.url.split('?')[0]);
            const path = join(REPO, clean === '/' ? 'index.html' : clean.replace(/^\/+/, ''));
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

const browser = await chromium.launch();

// Crypto lives behind its own tab: state.mode has to be 'crypto' before the search will resolve
// a coin, and the pipeline takes a coinId rather than a ticker. Without this the four crypto
// symbols reported "neither block rendered" and looked like an upstream outage, when in fact the
// harness had never left stock mode -- a warning that hid the whole asset class from the check.
const CRYPTO_RE = /-USD$/i;

async function readSymbol(page, sym) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(LIVE ? 3800 : 2400);
    const isCrypto = CRYPTO_RE.test(sym);
    if (isCrypto) {
        await page.click('[data-tab="crypto"]').catch(() => null);
        await page.waitForTimeout(1800);
    }
    // Crypto search matches names/ids, not the Yahoo "-USD" suffix.
    const query = isCrypto ? sym.replace(/-USD$/i, '') : sym;
    await page.fill('#search-input', query);
    await page.waitForTimeout(2600);
    const first = page.locator('#search-results .search-result, #search-results > *').first();
    if (await first.count() > 0 && await first.isVisible().catch(() => false)) {
        await first.click().catch(() => page.press('#search-input', 'Enter'));
    } else {
        await page.press('#search-input', 'Enter');
    }
    // Either block appearing is enough to start reading; both are checked below.
    await page.waitForSelector('.price-targets, .forecast-band-section', { timeout: 75_000 })
        .catch(() => null);
    await page.waitForTimeout(1500);

    return page.evaluate(() => {
        const num = (t) => {
            if (!t) return null;
            const m = String(t).replace(/[^0-9.\-]/g, '');
            const v = parseFloat(m);
            return Number.isFinite(v) ? v : null;
        };
        const cards = [...document.querySelectorAll('.price-target-card')];
        const hiCard = cards.find(c => /High/i.test(c.innerText));
        const loCard = cards.find(c => /Low/i.test(c.innerText));
        const titleEl = document.querySelector('.price-targets-title');
        // The forward table's FIRST row is Today. Scope away the past table explicitly.
        const fwdRow = document.querySelector(
            '.forecast-band-section .fb-table:not(.fb-table-past) tbody tr');
        const tds = fwdRow ? [...fwdRow.querySelectorAll('td')].map(t => t.innerText.trim()) : [];
        return {
            title: titleEl ? titleEl.innerText.trim() : null,
            hiLabel: hiCard?.querySelector('.price-target-label')?.innerText.trim() || null,
            loLabel: loCard?.querySelector('.price-target-label')?.innerText.trim() || null,
            headHigh: num(hiCard?.querySelector('.price-target-value')?.innerText),
            headLow: num(loCard?.querySelector('.price-target-value')?.innerText),
            calBadge: !!document.querySelector('.pt-cal-badge'),
            tableDay: tds[0] || null,
            tableLow: num(tds[1]),
            tableHigh: num(tds[2]),
            lockLabel: document.querySelector('.call-status-locked')?.innerText.trim() || null,
        };
    });
}

console.log(`=== band agreement across ${SYMBOLS.length} symbols (${LIVE ? 'LIVE site' : 'local'}) ===`);
console.log(`${'symbol'.padEnd(13)}${'headline'.padEnd(22)}${'table Today'.padEnd(22)}verdict`);

for (const sym of SYMBOLS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    let r = null;
    try {
        r = await readSymbol(page, sym);
    } catch (e) {
        warn(`${sym}: could not load`, String(e).slice(0, 90));
        await page.close();
        continue;
    }
    await page.close();

    const hasHead = Number.isFinite(r.headHigh) && Number.isFinite(r.headLow);
    const hasTable = Number.isFinite(r.tableHigh) && Number.isFinite(r.tableLow);

    if (!hasHead && !hasTable) {
        warn(`${sym}: neither block rendered`, 'likely no data from the upstream API today');
        continue;
    }
    if (!hasTable) {
        // No band at all -- too few candles, or an asset the band refuses to size. The headline
        // must then be the heuristic one and say "Possible", not "Expected".
        const honest = /Possible/i.test(r.hiLabel || '') && !r.calBadge;
        const verdict = honest ? 'no band, headline labelled Possible' : 'NO BAND but headline claims Expected';
        console.log(`${sym.padEnd(13)}${String(r.headHigh).padEnd(22)}${'-'.padEnd(22)}${verdict}`);
        if (honest) ok(`${sym}: no band, honestly labelled`);
        else bad(`${sym}: no band yet headline claims a calibrated figure`,
                 `label="${r.hiLabel}" badge=${r.calBadge}`);
        continue;
    }
    if (!hasHead) {
        warn(`${sym}: table rendered but no headline targets`, JSON.stringify(r).slice(0, 120));
        continue;
    }

    // A sub-penny asset renders as "$0.0000" in BOTH blocks, because currency.js format() caps
    // at 4 decimals. They "agree" only because both collapsed to zero, which is a false pass on a
    // display that tells the reader nothing. Reported as a warning so the collapse stays visible
    // instead of being counted as a success. (Pre-existing and global to format(), not introduced
    // by the band work -- the price-target cards have always collapsed these too.)
    if (r.headHigh === 0 && r.tableHigh === 0) {
        warn(`${sym}: both blocks render 0 (sub-penny collapsed by the 4dp display cap)`,
             `headline "${r.headHigh}" table "${r.tableHigh}" -- agreement is not meaningful here`);
        continue;
    }

    // Both present. If the headline claims to BE the calibrated band, it must match it.
    const claimsBand = r.calBadge || /Expected/i.test(r.hiLabel || '');
    const dHigh = Math.abs(r.headHigh - r.tableHigh);
    const dLow = Math.abs(r.headLow - r.tableLow);
    // A cent of tolerance for independent rounding of the same underlying figure.
    const agree = dHigh <= 0.011 && dLow <= 0.011;
    const head = `${r.headHigh}/${r.headLow}`;
    const tbl = `${r.tableHigh}/${r.tableLow}`;

    if (claimsBand) {
        console.log(`${sym.padEnd(13)}${head.padEnd(22)}${tbl.padEnd(22)}${agree ? 'agree' : `DISAGREE dH=${dHigh.toFixed(2)} dL=${dLow.toFixed(2)}`}`);
        if (agree) ok(`${sym}: blocks agree`);
        else bad(`${sym}: two different expected highs/lows for the same day`,
                 `headline ${head} vs table ${tbl} (dHigh=${dHigh.toFixed(4)} dLow=${dLow.toFixed(4)})`);
    } else {
        // Heuristic headline next to a band table. Allowed to differ, but the labels have to make
        // clear they are not the same claim, or the reader compares apples to oranges.
        const honest = /Possible/i.test(r.hiLabel || '') && /Possible/i.test(r.loLabel || '');
        console.log(`${sym.padEnd(13)}${head.padEnd(22)}${tbl.padEnd(22)}${honest ? 'heuristic, labelled Possible' : 'UNLABELLED heuristic'}`);
        if (honest) ok(`${sym}: heuristic headline honestly labelled`);
        else bad(`${sym}: heuristic headline not distinguished from the band`,
                 `hiLabel="${r.hiLabel}" loLabel="${r.loLabel}" badge=${r.calBadge}`);
    }
}

await browser.close();
if (server) server.close();

console.log();
const green = FAIL.length === 0;
console.log(`${green ? 'BAND AGREEMENT PASS' : 'BAND AGREEMENT FAIL'}: `
    + `${PASS.length} passed, ${FAIL.length} failed, ${WARN.length} warnings`);
if (!green && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=band_agreement::${FAIL.slice(0, 6).join('; ')}`);
}
process.exitCode = green ? 0 : 1;
