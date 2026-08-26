/**
 * DOM/CSS probe. Reports computed styles for selectors so a layout question is
 * answered by the engine rather than by reading CSS and hoping.
 *
 * Usage: node tools/probe.mjs ".chart-container" "#tradingview-widget" ...
 *        node tools/probe.mjs --theme light ".search-input"
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 8139;
const args = process.argv.slice(2);
const ti = args.indexOf('--theme');
const THEME = ti >= 0 ? args[ti + 1] : 'dark';
// ti is -1 when --theme is absent, so `i !== ti + 1` was dropping argv[0]:
// the first selector silently vanished from every report.
const SELECTORS = args.filter((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };

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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 950 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
await page.addInitScript((t) => {
    try { localStorage.setItem('ma-theme', t); } catch {}
}, THEME);
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2600);

const out = await page.evaluate((sels) => {
    const r = {};
    // Does the engine support :has() at all? A false here explains any
    // :has()-based rule silently doing nothing.
    r.__supports_has = CSS.supports('selector(:has(*))');
    for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { r[s] = 'NOT FOUND'; continue; }
        const c = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        r[s] = {
            box: `${Math.round(b.width)}x${Math.round(b.height)}`,
            height: c.height, minHeight: c.minHeight,
            display: c.display, position: c.position,
            bg: c.backgroundColor,
            color: c.color,
            font: `${c.fontFamily.split(',')[0]} ${c.fontSize}/${c.fontWeight}`,
            border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor,
            radius: c.borderTopLeftRadius,
            children: el.children.length,
            classes: el.className && String(el.className).slice(0, 90),
        };
    }
    return r;
}, SELECTORS);

console.log(`theme=${THEME}  :has() supported=${out.__supports_has}\n`);
delete out.__supports_has;
for (const [k, v] of Object.entries(out)) {
    console.log(`  ${k}`);
    if (typeof v === 'string') { console.log(`      ${v}`); continue; }
    for (const [p, val] of Object.entries(v)) console.log(`      ${p.padEnd(11)} ${val}`);
    console.log('');
}

await browser.close();
server.close();
