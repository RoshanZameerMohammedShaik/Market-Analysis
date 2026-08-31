/**
 * Verify Mia 2.0's desk in a real browser: open the Portfolio panel, read the rendered
 * DOM, interact with a timeline entry, and screenshot it in every theme.
 *
 * Exists because "the module has no syntax errors" is not verification. The desk is ~500
 * lines of generated HTML reading a JSON slice; the failures that matter are a token that
 * does not exist in one theme, a value that renders as "NaN" or "undefined", a collapsed
 * grid at 420px, and an expander that does not expand. None of those show up in node
 * --check, and all of them are obvious in a screenshot plus a DOM read.
 *
 * Usage:
 *   node tools/desk_check.mjs                      all themes
 *   node tools/desk_check.mjs --themes dark,light  subset
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'tools', '_shots');
const PORT = 8141;

const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const THEMES = flag('themes', 'dark,light,aurora,midnight,ember,forest').split(',').filter(Boolean);

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
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(body);
    } catch {
        // 404 as a real 404, NOT as index.html. Cloudflare Pages' SPA fallback serves
        // index.html with HTTP 200 for a missing file, and the desk has an explicit
        // content-type guard for exactly that. Mimicking the fallback here would hide
        // whether the guard works.
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
});
await new Promise(r => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const PASS = [], FAIL = [];
const check = (name, cond, detail = '') => {
    (cond ? PASS : FAIL).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${detail}` : ''}`);
};

const browser = await chromium.launch();
let firstRun = true;

for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    await page.addInitScript(t => {
        try { localStorage.setItem('ma-theme', t); } catch {}
        document.documentElement.setAttribute('data-theme', t);
    }, theme);

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);

    // Open the Portfolio panel, where the desk lives.
    await page.waitForSelector('#portfolio-launcher', { timeout: 30000 });
    await page.click('#portfolio-launcher');
    await page.waitForSelector('#mia-desk .desk-hero', { timeout: 30000 });
    await page.waitForTimeout(400);   // let the slide-in settle before capturing

    console.log(`\n=== ${theme} ===`);

    if (firstRun) {
        // Read what is actually on screen once. The remaining themes only need to prove
        // they render without a broken token, so re-asserting the same numbers six times
        // would add runtime and no information.
        const d = await page.evaluate(() => {
            const q = s => document.querySelector(s);
            const txt = s => (q(s)?.textContent || '').trim().replace(/\s+/g, ' ');
            const entries = [...document.querySelectorAll('.desk-entry')];
            return {
                equity: txt('.desk-hero-value'),
                pnl: txt('.desk-hero-pnl'),
                pills: [...document.querySelectorAll('.desk-pill')].map(p => p.textContent.trim().replace(/\s+/g, ' ')),
                heartbeat: txt('.desk-heartbeat'),
                board: [...document.querySelectorAll('.desk-board-row')].map(r => ({
                    name: r.querySelector('.desk-board-name')?.textContent.trim().replace(/\s+/g, ' '),
                    val: r.querySelector('.desk-board-val')?.textContent.trim(),
                })),
                combined: [...document.querySelectorAll('.desk-combined-row')].map(r => r.textContent.trim().replace(/\s+/g, ' ')),
                entryCount: entries.length,
                first: entries[0] ? {
                    act: entries[0].querySelector('.desk-act')?.textContent.trim(),
                    sym: entries[0].querySelector('.desk-sym')?.textContent.trim(),
                    notional: entries[0].querySelector('.desk-notional')?.textContent.trim(),
                    why: entries[0].querySelector('.desk-why')?.textContent.trim(),
                    chips: [...entries[0].querySelectorAll('.desk-chip')].map(c => c.textContent.trim()),
                } : null,
                bodyText: document.querySelector('#mia-desk')?.innerText || '',
            };
        });

        console.log(`  equity     ${d.equity}   pnl ${d.pnl}`);
        console.log(`  heartbeat  ${d.heartbeat}`);
        console.log(`  pills      ${d.pills.join(' | ')}`);
        console.log(`  combined   ${d.combined.join(' | ')}`);
        d.board.forEach(b => console.log(`  sleeve     ${String(b.name).padEnd(42)} ${b.val}`));
        console.log(`  entries    ${d.entryCount}`);
        if (d.first) {
            console.log(`  first      ${d.first.act} ${d.first.sym} ${d.first.notional}  [${d.first.chips.join('] [')}]`);
            console.log(`  why        ${d.first.why}`);
        }

        check('equity renders a dollar figure', /^\$[\d,]+\.\d\d$/.test(d.equity), d.equity);
        check('P/L renders with a sign', /^[+−]\$/.test(d.pnl), d.pnl);
        check('all six pills render', d.pills.length === 6, String(d.pills.length));
        check('heartbeat reports a last run', /Last run/.test(d.heartbeat), d.heartbeat);
        check('leaderboard has four sleeves', d.board.length === 4, String(d.board.length));
        check('the benchmark sleeve is labelled',
              d.board.some(b => /benchmark/i.test(b.name || '')), JSON.stringify(d.board.map(b => b.name)));
        check('combined shows three lines', d.combined.length === 3, String(d.combined.length));
        check('practice portfolio reads "not loaded" with no portfolio',
              d.combined.some(c => /not loaded/.test(c)), d.combined.join(' | '));
        check('timeline rendered entries', d.entryCount > 0, String(d.entryCount));
        check('first entry has an action badge', ['BUY', 'SELL'].includes(d.first?.act), d.first?.act);
        check('first entry names a strategy chip', (d.first?.chips || []).length >= 2,
              JSON.stringify(d.first?.chips));
        check('first entry explains itself', (d.first?.why || '').length > 20, d.first?.why);

        // The failure mode that actually bites: a missing field formatted into the string.
        for (const bad of ['NaN', 'undefined', 'null', 'Infinity', '[object Object]']) {
            check(`no "${bad}" anywhere in the desk`, !d.bodyText.includes(bad),
                  d.bodyText.split('\n').find(l => l.includes(bad)) || '');
        }
        check('no em-dash in the rendered desk', !d.bodyText.includes('—'),
              d.bodyText.split('\n').find(l => l.includes('—')) || '');

        // INTERACTION. A details panel that never opens is the single most likely bug here,
        // and no static check would catch it.
        const before = await page.evaluate(() =>
            getComputedStyle(document.querySelector('.desk-entry .desk-entry-body')).display);
        await page.click('.desk-entry .desk-entry-head');
        await page.waitForTimeout(250);
        const after = await page.evaluate(() => {
            const b = document.querySelector('.desk-entry .desk-entry-body');
            return {
                display: getComputedStyle(b).display,
                rows: b.querySelectorAll('.desk-kv dt').length,
                evidence: b.querySelectorAll('.desk-ev-k').length,
                text: b.innerText,
                expanded: document.querySelector('.desk-entry .desk-entry-head').getAttribute('aria-expanded'),
            };
        });
        check('detail is collapsed before the click', before === 'none', before);
        check('detail expands on click', after.display === 'block', after.display);
        check('aria-expanded flips', after.expanded === 'true', String(after.expanded));
        check('detail lists the cost breakdown', after.rows >= 10, String(after.rows));
        check('detail shows the decision basis', after.evidence >= 2, String(after.evidence));

        // The control sleeve records only basketSize and priceUSD, so whichever entry the
        // harness lands on first proves little. Explicitly expand a NON-control fill, whose
        // evidence carries the score, signal, confidence, RSI and threshold, to prove the
        // generic renderer handles a rich basis and not just a two-key one.
        const rich = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('.desk-entry')];
            const i = cards.findIndex(c => !/control/.test(
                c.querySelector('.desk-chip.subtle')?.textContent || 'control'));
            if (i < 0) return null;
            cards[i].querySelector('.desk-entry-head').click();
            const b = cards[i].querySelector('.desk-entry-body');
            return {
                strategy: cards[i].querySelector('.desk-chip.subtle')?.textContent.trim(),
                keys: [...b.querySelectorAll('.desk-ev-k')].map(e => e.textContent.trim()),
                vals: [...b.querySelectorAll('.desk-ev-v')].map(e => e.textContent.trim()),
            };
        });
        check('a rich strategy basis renders every key', !!rich && rich.keys.length >= 4,
              rich ? `${rich.strategy}: ${rich.keys.join(', ')}` : 'no non-control entry found');
        check('basis values are all formatted',
              !!rich && rich.vals.length === rich.keys.length && rich.vals.every(v => v && v !== '—'),
              rich ? rich.vals.join(', ') : '');
        if (rich) {
            console.log(`  basis      ${rich.strategy}: `
                + rich.keys.map((k, i) => `${k}=${rich.vals[i]}`).join('  '));
        }

        // The badge must not fire on day-one cost noise: every sleeve starts down by roughly
        // the round trip, and awarding "beats benchmark" for a 0.001pp lead is noise dressed
        // as a finding.
        const badges = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('.desk-board-row')];
            const pct = r => parseFloat((r.querySelector('.desk-board-val')?.textContent || '')
                .replace('−', '-').replace('%', ''));
            const ctrl = rows.find(r => r.classList.contains('is-control'));
            const c = ctrl ? pct(ctrl) : 0;
            return rows.filter(r => r.querySelector('.desk-board-tag.win'))
                       .map(r => +(pct(r) - c).toFixed(4));
        });
        check('no "beats benchmark" badge inside cost noise',
              badges.every(m => Math.abs(m) >= 0.25), JSON.stringify(badges));
        check('expanded detail has no NaN', !/NaN|undefined/.test(after.text),
              after.text.split('\n').find(l => /NaN|undefined/.test(l)) || '');
        console.log('  expanded   ' + after.text.replace(/\n/g, ' | ').slice(0, 260));

        firstRun = false;
    } else {
        await page.click('.desk-entry .desk-entry-head');
        await page.waitForTimeout(200);
    }

    // Contrast sanity per theme: the one bug that only appears in some themes is text that
    // matches its own background, which a screenshot shows but a DOM read does not.
    const colours = await page.evaluate(() => {
        const g = (s, p) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : null; };
        return {
            deskBg: g('#mia-desk', 'backgroundColor'),
            heroBg: g('.desk-hero', 'backgroundColor'),
            valueColour: g('.desk-hero-value', 'color'),
            subColour: g('.desk-title-sub', 'color'),
            subFill: g('.desk-title-sub', 'webkitTextFillColor'),
            whyColour: g('.desk-why', 'color'),
        };
    });
    const parse = c => (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = parse(c); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const contrast = Math.abs(lum(colours.valueColour) - lum(colours.heroBg));
    check(`${theme}: equity text contrasts its card`, contrast > 0.25, `delta ${contrast.toFixed(3)} ${JSON.stringify(colours)}`);
    // The gradient-clipped title sets -webkit-text-fill-color: transparent, which INHERITS.
    // The subtitle must reset it or it renders invisible.
    check(`${theme}: subtitle is not transparent`,
          !/transparent|rgba\(0, 0, 0, 0\)/.test(String(colours.subFill)), String(colours.subFill));

    const el = await page.$('#portfolio-panel');
    // TWO shots: the top of the desk (hero, pills, heartbeat, combined) and the timeline.
    // One shot only ever captured whichever part the click had scrolled into view, which is
    // how the leaderboard's invisible bars survived a full round of "verification".
    await page.evaluate(() => document.getElementById('mia-desk')
        ?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(200);
    const top = join(OUT, `desk-${theme}-top.png`);
    await el.screenshot({ path: top });

    await page.evaluate(() => document.querySelector('.desk-timeline')
        ?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(200);
    const f = join(OUT, `desk-${theme}-timeline.png`);
    await el.screenshot({ path: f });
    console.log(`  shots      desk-${theme}-top.png + desk-${theme}-timeline.png`);

    if (consoleErrors.length) {
        // Favicon and third-party quote failures are expected offline and are not the desk's
        // problem. Anything mentioning the desk or its slice is.
        const relevant = consoleErrors.filter(e => /desk|timeline\.json|mia-desk/i.test(e));
        check(`${theme}: no console errors from the desk`, relevant.length === 0, relevant.join(' ; '));
    }

    await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${FAIL.length ? 'DESK CHECK FAIL' : 'DESK CHECK PASS'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log('  failed: ' + FAIL.join('; '));
process.exit(FAIL.length ? 1 : 0);
