/**
 * Assert that every ensemble source is ALIVE in a real browser.
 *
 * THE DEFECT CLASS THIS CATCHES
 * -----------------------------
 * The engine blends four sources (ai, technical, sentiment, market). A source that silently
 * returns a constant contributes nothing to a cross-sectional ranking, but the engine still
 * prints a confident number, so the failure is invisible from the outside. It has now
 * happened twice:
 *
 *   * sentiment returned a neutral 50 with no news and no `available` flag, so half the
 *     score was a constant for months.
 *   * macro/market died in the BROWSER only. fred.stlouisfed.org sends no CORS header, our
 *     Worker allowlists just the two Yahoo hosts, and the public proxies fail on FRED too.
 *     Measured 2026-09-10: `available:false` with all four components null in Chromium,
 *     while tools/macro_check.mjs scored 28/28 because it runs in NODE, which has no CORS.
 *
 * That second one is the reason this file has to drive a browser. Every offline check we own
 * runs in Node, and Node cannot reproduce a CORS failure -- the single most likely way a
 * browser-side data source dies. A green Node suite is not evidence about the browser.
 *
 * Usage:
 *   node tools/browser_sources_check.mjs
 *   node tools/browser_sources_check.mjs --symbol RELIANCE.NS
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 8153;
const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SYMBOL = flag('symbol', 'AAPL');

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (req, res) => {
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

const PASS = [], FAIL = [], WARN = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};
const warn = (name, detail) => { WARN.push(name); console.log(`  WARN  ${name}  -> ${detail}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const corsErrors = [];
page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && /CORS policy|Access-Control-Allow-Origin/i.test(t)) corsErrors.push(t);
});

console.log('=== macro reads its published slice, in a browser ===');
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const macro = await page.evaluate(async () => {
    const m = await import('/js/macro.js');
    try { return await m.getMacroScore(); } catch (e) { return { error: String(e) }; }
});
check('macro is AVAILABLE in the browser', macro?.available === true,
      `available=${macro?.available} score=${macro?.score} -- FRED is CORS-blocked, so this `
      + 'means model/macro.json is missing, stale or not deployed. Run: node tools/write_macro_slice.mjs');
if (macro?.available) {
    const comps = macro.components || {};
    for (const [k, v] of Object.entries(comps)) {
        check(`  macro component "${k}" resolved`, v !== null && Number.isFinite(v?.score),
              JSON.stringify(v));
    }
    check('the macro score is not the neutral placeholder', macro.score !== 50,
          `score=${macro.score} (50 is what an unavailable macro returns)`);
}

console.log();
console.log(`=== the full ensemble on ${SYMBOL} ===`);
await page.fill('#search-input', SYMBOL);
await page.waitForTimeout(2500);
const firstResult = page.locator('#search-results .search-result, #search-results > *').first();
if (await firstResult.count() > 0 && await firstResult.isVisible().catch(() => false)) {
    await firstResult.click().catch(() => page.press('#search-input', 'Enter'));
} else {
    await page.press('#search-input', 'Enter');
}
await page.waitForFunction(() => window.__miaLatestSignal?.breakdown, null, { timeout: 90_000 })
    .catch(() => null);
await page.waitForTimeout(1000);

const sig = await page.evaluate(() => {
    const s = window.__miaLatestSignal;
    if (!s) return null;
    return { breakdown: s.breakdown, confidence: s.confidence, signal: s.signal };
});
// The macro assertions above are strict: they read a COMMITTED file off a local server, so
// they are deterministic and a failure is always our bug. This half needs live Yahoo, and a
// check that goes red on someone else's outage gets ignored and then deleted. So no signal
// at all is a warning; a signal with a DEAD source is a failure.
if (!sig?.breakdown) {
    warn('the engine produced no signal', sig
        ? 'a signal arrived with no breakdown'
        : `no signal for ${SYMBOL} -- most likely the upstream quote API is unreachable from `
          + 'this network, which is an outage rather than a defect');
} else {
    check('the engine produced a signal with a breakdown', true);
}

if (sig?.breakdown) {
    for (const [name, b] of Object.entries(sig.breakdown)) {
        const scoreOk = Number.isFinite(b?.score);
        // `technical` has no `available` flag -- it is computed from the candles we already
        // have and cannot be "unavailable" without the whole analysis failing.
        const avail = name === 'technical' ? scoreOk : b?.available === true;
        if (avail) {
            console.log(`  PASS  source "${name}" live  (score ${b.score}, weight ${Math.round(b.weight)}%)`);
            PASS.push(`source ${name}`);
        } else if (name === 'sentiment') {
            // A symbol can legitimately have no news right now. That is an honest abstention,
            // not a broken source, so it warns rather than fails -- but it must still be
            // FLAGGED unavailable rather than quietly scoring 50.
            warn(`source "${name}" abstained`,
                 `available=${b?.available} score=${b?.score} -- no news for ${SYMBOL} is plausible; `
                 + 'the important part is that it declared itself unavailable');
            check(`  "${name}" abstains honestly rather than scoring a silent 50`,
                  b?.available === false, JSON.stringify(b));
        } else {
            check(`source "${name}" is live`, false,
                  `available=${b?.available} score=${b?.score} weight=${b?.weight}`);
        }
    }
}

if (corsErrors.length) {
    warn(`${corsErrors.length} CORS error(s) logged`, corsErrors[0].slice(0, 140));
}

await browser.close();
server.close();

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'BROWSER SOURCES CHECK PASS' : 'BROWSER SOURCES CHECK FAIL'}: `
    + `${PASS.length} passed, ${FAIL.length} failed, ${WARN.length} warnings`);
if (!ok && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=browser_sources::${FAIL.slice(0, 6).join('; ')}`);
}
process.exitCode = ok ? 0 : 1;
