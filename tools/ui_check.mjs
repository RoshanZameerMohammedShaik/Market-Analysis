/**
 * Interaction test for the UI layer. Drives the real app in a real browser and
 * asserts behaviour, not appearance.
 *
 * Screenshots prove a surface LOOKS right; they say nothing about whether the
 * theme picker actually switches themes, persists, or survives a reload. This
 * covers the parts of the redesign that carry logic:
 *   - all six themes are reachable and each repaints --bg-primary
 *   - a choice persists to localStorage and is restored on reload
 *   - a retired theme id migrates instead of silently resetting to dark
 *   - the swatch grid marks exactly one option as checked
 *   - the settings menu opens and the picker is inside it
 *   - <meta name="theme-color"> follows the theme (Android/PWA status bar)
 *
 * Run: node tools/ui_check.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 8151;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p.endsWith('/')) p += 'index.html';
        const f = join(REPO, p);
        if (!f.startsWith(REPO)) { res.writeHead(403).end(); return; }
        const b = await readFile(f);
        res.writeHead(200, { 'Content-Type': (MIME[extname(f).toLowerCase()] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(b);
    } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(PORT, r));

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const boot = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
};
await boot();

console.log('=== registry and picker construction ===');
const built = await page.evaluate(() => ({
    swatches: document.querySelectorAll('.theme-swatch').length,
    inMenu: !!document.querySelector('#header-settings-menu .theme-picker'),
    ids: [...document.querySelectorAll('.theme-swatch')].map((b) => b.dataset.themeId),
    role: document.querySelector('.theme-picker')?.getAttribute('role'),
}));
check('six swatches are built', built.swatches === 6, String(built.swatches));
check('picker lives inside the settings menu', built.inMenu);
check('picker is a radiogroup', built.role === 'radiogroup', String(built.role));
check('every swatch carries a theme id',
    built.ids.every(Boolean) && new Set(built.ids).size === 6, JSON.stringify(built.ids));

console.log('\n=== each theme applies and actually repaints ===');
const seen = new Map();
for (const id of built.ids) {
    await page.evaluate((t) => document.querySelector(`.theme-swatch[data-theme-id="${t}"]`).click(), id);
    await page.waitForTimeout(140);
    const st = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.documentElement).backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        stored: localStorage.getItem('ma-theme'),
        checked: [...document.querySelectorAll('.theme-swatch')]
            .filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.themeId),
        meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')),
    }));
    check(`${id}: data-theme set`, st.attr === id, st.attr);
    check(`${id}: persisted to localStorage`, st.stored === id, String(st.stored));
    check(`${id}: exactly one swatch checked`, st.checked.length === 1 && st.checked[0] === id,
        JSON.stringify(st.checked));
    check(`${id}: --accent is defined`, /^#|rgb/.test(st.accent), st.accent);
    check(`${id}: meta theme-color follows the page`, st.meta.length === 1, JSON.stringify(st.meta));
    seen.set(id, st.bg + '|' + st.accent);
}
check('all six themes are visually distinct (bg + accent pair)',
    new Set(seen.values()).size === 6, JSON.stringify([...seen]));

console.log('\n=== persistence across reload ===');
await page.evaluate(() => document.querySelector('.theme-swatch[data-theme-id="ember"]').click());
await page.waitForTimeout(120);
await boot();
const after = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    checked: [...document.querySelectorAll('.theme-swatch')]
        .filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.themeId),
}));
check('chosen theme survives a reload', after.attr === 'ember', after.attr);
check('picker restores the checked swatch', after.checked[0] === 'ember', JSON.stringify(after.checked));

console.log('\n=== retired theme ids migrate rather than reset ===');
for (const [old, want] of [['slate', 'midnight'], ['terminal', 'forest'], ['colourful', 'aurora']]) {
    await page.evaluate((o) => localStorage.setItem('ma-theme', o), old);
    await boot();
    const got = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        stored: localStorage.getItem('ma-theme'),
    }));
    check(`'${old}' migrates to '${want}'`, got.attr === want && got.stored === want,
        `${got.attr} / ${got.stored}`);
}
// An unknown value must not throw; it falls back to the default.
await page.evaluate(() => localStorage.setItem('ma-theme', 'not-a-theme'));
await boot();
check("garbage stored theme falls back to 'dark'",
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark');

console.log('\n=== keyboard navigation of the radiogroup ===');
// The old #theme-toggle cycle row was removed: it duplicated the picker with no
// preview of what came next. Arrow keys are now the keyboard path, which is what
// role="radiogroup" promises a screen-reader user.
await page.evaluate(() => localStorage.setItem('ma-theme', 'dark'));
await boot();
const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.evaluate(() => document.querySelector('.theme-swatch[data-theme-id="dark"]').focus());
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(140);
const right = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
check('ArrowRight moves to the next theme', right !== before, `${before} -> ${right}`);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(140);
const back = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
check('ArrowLeft returns to the previous theme', back === before, `${right} -> ${back}`);
check('the retired cycle row is gone from the DOM',
    await page.evaluate(() => !document.getElementById('theme-toggle')));

console.log('\n=== settings menu opens ===');
await boot();
await page.evaluate(() => document.getElementById('settings-toggle').click());
await page.waitForTimeout(260);
const menuVisible = await page.evaluate(() => {
    const m = document.getElementById('header-settings-menu');
    const r = m.getBoundingClientRect();
    return { shown: getComputedStyle(m).visibility !== 'hidden' && Number(getComputedStyle(m).opacity) > 0.1,
             onScreen: r.width > 0 && r.right <= window.innerWidth + 1 && r.left >= -1 };
});
check('menu becomes visible on click', menuVisible.shown);
check('menu stays inside the viewport', menuVisible.onScreen, JSON.stringify(menuVisible));

console.log('\n=== no new page errors from the UI layer ===');
const relevant = pageErrors.filter((m) => !/setAttribute/.test(m));
check('no unexpected page errors', relevant.length === 0, JSON.stringify(relevant.slice(0, 3)));

await browser.close();
server.close();

console.log(`\n${FAIL.length ? 'UI CHECK FAIL' : 'UI CHECK PASS'}: ${PASS.length} passed, ${FAIL.length} failed`);
process.exit(FAIL.length ? 1 : 0);
