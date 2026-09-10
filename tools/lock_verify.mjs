/**
 * Load a real symbol in a real browser and read what the lock badge actually says.
 *
 * WHY THIS AND NOT JUST THE ASSERTIONS
 * ------------------------------------
 * tools/session_lock_check.mjs proves the lock LOGIC with 33 offline assertions. It cannot
 * prove the lock RENDERS: the anchor now travels from confidence.js through the analysis
 * cache into signal.js, and a broken import or a field dropped by the cache would leave
 * every assertion green while the badge on screen still read "locked 11:58 AM when you
 * opened it". That exact class of failure has already happened here -- a mid-file import
 * passed `node --check` and silently killed the whole desk panel in the browser.
 *
 * So this drives the real UI: search a symbol, wait for the signal card, read the badge
 * text and its tooltip out of the DOM, and screenshot it. It also fails on any console
 * error, because a thrown module error is exactly what this is looking for.
 *
 * Usage:
 *   node tools/lock_verify.mjs                     AAPL
 *   node tools/lock_verify.mjs --symbol RELIANCE.NS
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'tools', '_shots');
const PORT = 8151;
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
await mkdir(OUT, { recursive: true });

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

console.log(`=== loading ${SYMBOL} in a real browser ===`);
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);   // splash + boot

await page.fill('#search-input', SYMBOL);
await page.waitForTimeout(2500);   // debounced search + remote results
// Click the first search result if the dropdown opened; otherwise press Enter.
const firstResult = page.locator('#search-results .search-result, #search-results > *').first();
if (await firstResult.count() > 0 && await firstResult.isVisible().catch(() => false)) {
    await firstResult.click().catch(() => page.press('#search-input', 'Enter'));
} else {
    await page.press('#search-input', 'Enter');
}

// The signal card is the thing under test; give the full pipeline time to land.
await page.waitForSelector('.call-status-locked', { timeout: 90_000 }).catch(() => null);
await page.waitForTimeout(1500);

const badge = await page.evaluate(() => {
    const el = document.querySelector('.call-status-locked');
    if (!el) return null;
    return {
        text: el.textContent.trim(),
        title: el.getAttribute('title') || '',
        isVisitLock: el.classList.contains('is-visit-lock'),
    };
});

// Read the lock record the app actually persisted, plus the anchor it derived.
const internals = await page.evaluate(() => {
    let locks = null;
    try { locks = JSON.parse(localStorage.getItem('ma-daily-locks-v1') || 'null'); } catch (_) {}
    return { locks, latest: window.__latestSignal?.sessionAnchor ?? null };
});

console.log();
check('the lock badge rendered at all', badge !== null,
      badge ? '' : 'no .call-status-locked in the DOM');
if (badge) {
    console.log(`     badge text : "${badge.text}"`);
    console.log(`     tooltip    : "${badge.title.slice(0, 150)}${badge.title.length > 150 ? '...' : ''}"`);
    // THE regression. This phrasing is only correct when we genuinely have no session
    // anchor; with a normal daily fetch it means the fix did not take effect.
    check('it does NOT say "when you opened it"',
          !/when you opened it/i.test(badge.text), badge.text);
    check('it names an open baseline or an honest lateness',
          /open|after the open/i.test(badge.text), badge.text);
}

const storedKeys = internals.locks ? Object.keys(internals.locks) : [];
const rec = storedKeys.length ? internals.locks[storedKeys[0]] : null;
if (rec) {
    console.log(`     stored lock: ${JSON.stringify(rec)}`);
    check('the stored lock carries a session open timestamp', !!rec.openedAt, String(rec.openedAt));
    check('and records the call time separately', !!rec.calledAt);
    check('lockedAt is the OPEN, not the call time', rec.lockedAt === rec.openedAt,
          `lockedAt=${rec.lockedAt} openedAt=${rec.openedAt}`);
    check('it is flagged open-anchored', rec.openAnchored === true, String(rec.openAnchored));
} else if (badge && !badge.isVisitLock) {
    // A ledger-sourced lock stores nothing locally, which is correct.
    console.log('     (no local lock stored -- the badge came from the ledger row)');
}

// Module-level breakage shows up here and nowhere else.
const real = errors.filter(e => !/favicon|net::ERR_|404|Failed to load resource/i.test(e));
check('no console errors from the app', real.length === 0, real.slice(0, 3).join(' | '));

const shot = join(OUT, `lock-${SYMBOL.replace(/[^\w.-]/g, '_')}.png`);
await page.locator('#signal-section').screenshot({ path: shot }).catch(async () => {
    await page.screenshot({ path: shot, fullPage: false });
});
console.log(`     screenshot : ${shot}`);

await browser.close();
server.close();

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'LOCK VERIFY PASS' : 'LOCK VERIFY FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
process.exitCode = ok ? 0 : 1;
