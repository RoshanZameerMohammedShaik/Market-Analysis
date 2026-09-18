/**
 * The page must scroll no matter where the cursor is.
 *
 * THE BUG
 * -------
 * The TradingView embed is a cross-origin iframe, so it consumes the wheel event and zooms the chart
 * with it. The chart is a ~460px slab in the middle of a ~5,400px page, which meant scrolling simply
 * stopped wherever the user happened to rest their cursor. Measured on the live site before the fix:
 *
 *     wheel @ header       -> page scrolled 1200px
 *     wheel @ chart        -> page scrolled    0px
 *     wheel @ left gutter  -> page scrolled 1200px
 *     wheel @ right edge   -> page scrolled 1200px
 *
 * Nothing threw, nothing logged, and the page looked perfectly fine. It just would not move.
 *
 * A shield over the iframe absorbs the wheel; clicking it hands the chart the pointer so the chart
 * stays usable, and leaving the chart re-arms it.
 *
 * Note the scroller is document.body, not the window: css/style.css sets `html, body { height: 100% }`
 * so body owns the overflow. Any assertion here has to read body.scrollTop -- window.scrollY stays 0
 * forever and would make a broken page look fine.
 *
 * Usage: node tools/chart_scroll_check.mjs [--live]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const LIVE = process.argv.includes('--live');
const PORT = 8170;
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json' };
let server = null;
let BASE = 'https://market-ai.pages.dev/';
if (!LIVE) {
    server = createServer(async (rq, rs) => {
        try {
            const c = decodeURIComponent(rq.url.split('?')[0]);
            const p = join(REPO, c === '/' ? 'index.html' : c.replace(/^\/+/, ''));
            const b = await readFile(p);
            rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
            rs.end(b);
        } catch { rs.writeHead(404); rs.end('x'); }
    });
    await new Promise(r => server.listen(PORT, r));
    BASE = `http://localhost:${PORT}/index.html`;
}

const PASS = [], FAIL = [];
const check = (n, c, d = '') => {
    (c ? PASS : FAIL).push(n);
    console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? `  -> ${d}` : ''}`);
};

const br = await chromium.launch();
const pg = await br.newPage({ viewport: { width: 1360, height: 1000 } });
await pg.goto(BASE, { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(LIVE ? 4500 : 3000);
await pg.fill('#search-input', 'AAPL');
await pg.waitForTimeout(2600);
const r = pg.locator('#search-results .search-result, #search-results > *').first();
if (await r.count() && await r.isVisible().catch(() => false)) await r.click().catch(() => pg.press('#search-input', 'Enter'));
else await pg.press('#search-input', 'Enter');
await pg.waitForSelector('#signal-section .signal-box', { timeout: 90_000 }).catch(() => null);
await pg.waitForTimeout(2500);

const reset = () => pg.evaluate(() => { document.body.scrollTop = 0; document.documentElement.scrollTop = 0; });
const pos = () => pg.evaluate(() => Math.max(document.body.scrollTop, document.documentElement.scrollTop, window.scrollY));

// Where is the chart, so the wheel lands on it rather than near it?
const box = await pg.evaluate(() => {
    const el = document.querySelector('.chart-container');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), h: Math.round(b.height), top: Math.round(b.y) };
});
console.log('=== page must scroll from every cursor position ===');
check('the chart container exists and is on screen', !!box && box.h > 100, JSON.stringify(box));

const spots = [['header', 680, 120], ['left gutter', 40, 500], ['right edge', 1340, 500]];
if (box) spots.push(['OVER THE CHART', box.x, Math.max(0, Math.min(980, box.y))]);

for (const [label, x, y] of spots) {
    await reset();
    await pg.mouse.move(x, y);
    await pg.mouse.wheel(0, 1200);
    await pg.waitForTimeout(700);
    const p = await pos();
    check(`wheel over ${label} scrolls the page`, p > 400, `moved ${p}px`);
}

console.log();
console.log('=== the shield does not cost the user the chart ===');
const shield = await pg.evaluate(() => {
    const s = document.querySelector('.chart-shield');
    return s ? { armed: s.dataset.armed, wired: s.dataset.wired, pe: getComputedStyle(s).pointerEvents } : null;
});
check('a shield is present and armed', shield?.armed === '1', JSON.stringify(shield));
check('it is wired exactly once', shield?.wired === '1', JSON.stringify(shield?.wired));
check('while armed it receives pointer events', shield?.pe !== 'none', String(shield?.pe));

if (box) {
    // RECOMPUTE the position. The wheel tests above left the page scrolled, so the coordinates
    // captured before them point somewhere else entirely -- my first run clicked past the chart and
    // read armed="1", which looked like the click handler was broken when the click simply missed.
    await reset();
    await pg.waitForTimeout(400);
    const live = await pg.evaluate(() => {
        const el = document.querySelector('.chart-container');
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    });
    const cx = live.x, cy = Math.max(10, Math.min(980, live.y));
    // Click to activate: the chart must get the pointer back.
    await pg.mouse.click(cx, cy);
    await pg.waitForTimeout(600);
    const afterClick = await pg.evaluate(() => {
        const s = document.querySelector('.chart-shield');
        return { armed: s?.dataset.armed, pe: getComputedStyle(s).pointerEvents };
    });
    check('clicking hands the chart the pointer', afterClick.armed === '0' && afterClick.pe === 'none',
          JSON.stringify(afterClick));

    // Leaving the chart re-arms, so the NEXT scroll past it works without a thought.
    await pg.mouse.move(680, 120);
    await pg.waitForTimeout(600);
    const afterLeave = await pg.evaluate(() => document.querySelector('.chart-shield')?.dataset.armed);
    check('leaving the chart re-arms the shield', afterLeave === '1', String(afterLeave));

    // And prove the re-arm actually restored scrolling.
    await reset();
    await pg.mouse.move(cx, cy);
    await pg.mouse.wheel(0, 1200);
    await pg.waitForTimeout(700);
    check('scrolling over the chart works again after re-arm', (await pos()) > 400, `moved ${await pos()}px`);
}

await br.close();
if (server) server.close();
console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'CHART SCROLL CHECK PASS' : 'CHART SCROLL CHECK FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=chart_scroll::${FAIL.slice(0, 5).join('; ')}`);
process.exitCode = ok ? 0 : 1;
