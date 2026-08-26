/**
 * Screenshot harness for UI work. Serves the app locally and captures each
 * theme at desktop and mobile widths.
 *
 * Exists because "the CSS looks right" is not verification. A redesign touches
 * every surface, and the only way to know a token change did not wreck the
 * hot-picks grid or invert a contrast pair is to look at the rendered pixels.
 *
 * The app fetches live market data, which is slow and can fail. We wait for the
 * splash to clear and the first real layout, then shoot regardless of whether
 * remote quotes arrived: the chrome is what is under test, not the data.
 *
 * Usage:
 *   node tools/shoot.mjs                          all themes, both widths
 *   node tools/shoot.mjs --themes dark,light      subset
 *   node tools/shoot.mjs --tag before             filename prefix
 *   node tools/shoot.mjs --full                   full-page, not just viewport
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'tools', '_shots');
const PORT = 8137;

const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const THEMES = flag('themes', 'dark,light,aurora,midnight,ember,forest').split(',').filter(Boolean);
const TAG = flag('tag', 'shot');
const FULL = has('full');
const ONLY = flag('viewport', '');
// --page lets the harness shoot ui-preview.html (the static style reference)
// instead of the live app, so component surfaces can be checked without
// waiting on a 70-symbol network scan.
const PAGE = flag('page', 'index.html');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/' || p.endsWith('/')) p += 'index.html';
        const file = join(REPO, p);
        if (!file.startsWith(REPO)) { res.writeHead(403).end(); return; }
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const VIEWPORTS = (ONLY ? [ONLY] : ['desktop', 'mobile']).map((n) =>
    n === 'mobile'
        ? { name: 'mobile', width: 414, height: 896, isMobile: true, deviceScaleFactor: 2 }
        : { name: 'desktop', width: 1512, height: 950, deviceScaleFactor: 2 });

const browser = await chromium.launch();
const consoleErrors = [];

for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: !!vp.isMobile,
        hasTouch: !!vp.isMobile,
        colorScheme: 'dark',
        reducedMotion: 'reduce',   // freeze animations so shots are comparable
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`[${vp.name}] ${m.text().slice(0, 240)}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`[${vp.name}] PAGEERROR ${e.message.slice(0, 240)}`));

    for (const theme of THEMES) {
        // Set the theme BEFORE load so first paint is already correct, mirroring
        // how a returning user with a saved preference experiences it.
        await ctx.addInitScript((t) => {
            try { localStorage.setItem('ma-theme', t); } catch {}
            document.documentElement.setAttribute('data-theme', t);
        }, theme);

        await page.goto(`http://127.0.0.1:${PORT}/${PAGE}`, {
            waitUntil: 'domcontentloaded', timeout: 45000,
        });
        // Splash hides itself once the app boots; don't fail the shot if the
        // network stalls, just proceed and capture whatever rendered.
        await page.waitForFunction(() => {
            const s = document.getElementById('splash-overlay');
            return !s || s.dataset.done === '1' || getComputedStyle(s).opacity === '0'
                || s.style.display === 'none';
        }, { timeout: 12000 }).catch(() => {});
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        // --wait lets a run hold for real data. The hot-picks scan analyses 70
        // symbols sequentially and takes tens of seconds, so the default short
        // wait only ever captures skeletons. Designing the card surfaces requires
        // seeing them populated.
        const waitMs = Number(flag('wait', '2200'));
        if (waitMs > 6000) {
            await page.waitForFunction(() => {
                const g = document.getElementById('hotpicks-grid');
                return g && !g.querySelector('.hp-skel-grid, .loading') && g.children.length > 2;
            }, { timeout: waitMs }).catch(() => {});
            await page.waitForTimeout(1200);
        } else {
            await page.waitForTimeout(waitMs);
        }

        // style.css sets `overflow-x: hidden` on html AND body, which makes
        // overflow-y compute to auto and turns BODY into the scroll container.
        // Playwright's fullPage capture only paints the document scroller, so a
        // full-page shot came back as one viewport of content followed by a tall
        // blank canvas. Restoring document scrolling just for the capture fixes it
        // without touching the app.
        let undoScroll = null;
        if (FULL) {
            undoScroll = await page.addStyleTag({ content:
                'html,body{overflow:visible !important;max-width:none !important;height:auto !important}' });
            await page.waitForTimeout(250);
        }

        const f = join(OUT, `${TAG}-${theme}-${vp.name}.png`);
        await page.screenshot({ path: f, fullPage: FULL });
        if (undoScroll) await undoScroll.evaluate((el) => el.remove());
        console.log(`  ${theme.padEnd(9)} ${vp.name.padEnd(8)} -> ${f.replace(REPO + '\\', '')}`);
    }
    await ctx.close();
}

await browser.close();
server.close();

if (consoleErrors.length) {
    const uniq = [...new Set(consoleErrors)];
    await writeFile(join(OUT, `${TAG}-console.txt`), uniq.join('\n'), 'utf8');
    console.log(`\n  ${uniq.length} console error(s) — see tools/_shots/${TAG}-console.txt`);
    for (const e of uniq.slice(0, 8)) console.log('   ! ' + e);
} else {
    console.log('\n  no console errors');
}
