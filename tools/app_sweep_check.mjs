/**
 * Walk the WHOLE application in a real browser and report what is broken.
 *
 * WHY
 * ---
 * Every bug found in this project recently shared one shape: something rendered, nothing threw, and
 * the output was quietly wrong or quietly empty. "Invalid Date" on five of seven rows. Seven
 * history-backed features drawing blank charts. A dead macro source returning a neutral 50. Two
 * different expected highs for the same day. None of those fail a unit test, and none of them look
 * like an error -- they look like a page.
 *
 * So this opens every surface, exercises every toggle, and asserts on what actually reached the DOM.
 * It is deliberately broad rather than deep: the job is to FIND candidates across the app, and the
 * detectors below are the specific tells this codebase has produced before.
 *
 * WHAT IT FLAGS
 *   * console errors and uncaught page errors
 *   * same-origin requests that 404 (how the ledger slice died)
 *   * literal "NaN", "undefined", "null", "Invalid Date" in visible text
 *   * a price rendered as 0 or $0.0000 (the sub-penny display collapse)
 *   * a panel that opens but renders no content
 *
 * Findings are printed as candidates with the surface they came from. Some are legitimate -- an
 * em-dash placeholder for genuinely-absent data is correct -- so the output is a list to judge, not
 * an automatic verdict. Anything the app cannot explain gets fixed.
 *
 * Usage:
 *   node tools/app_sweep_check.mjs
 *   node tools/app_sweep_check.mjs --live
 *   node tools/app_sweep_check.mjs --symbols AAPL,SHIB-USD
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const LIVE = args.includes('--live');
const ROOT = args.includes('--dist') ? resolve(REPO, 'dist') : REPO;
const PORT = 8166;
const SYMBOLS = flag('symbols', 'AAPL,PLUG,7203.T').split(',').map(s => s.trim()).filter(Boolean);

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
await mkdir(join(REPO, 'tools', '_shots'), { recursive: true });

const findings = [];
const add = (surface, kind, detail) => findings.push({ surface, kind, detail });

// Third-party noise this app cannot fix and does not depend on. CORS blocks on optional enrichment
// sources (stocktwits, reddit, google news) are expected in a browser and are handled by the code.
const IGNORE_CONSOLE = /favicon|net::ERR_|Failed to load resource|stocktwits|reddit\.com|news\.google|tradingview|Content Security Policy|preload/i;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1800 } });

const consoleErrors = [];
const pageErrors = [];
const bad404 = new Set();
page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!IGNORE_CONSOLE.test(t)) consoleErrors.push(t.slice(0, 200));
});
page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));
page.on('response', r => {
    const u = r.url();
    // Only same-origin: a third party 404ing is their problem, ours is asking for a file we ship.
    if (r.status() === 404 && (u.startsWith(BASE.replace(/index\.html$/, '')) || u.includes('localhost:' + PORT))) {
        bad404.add(u.replace(/^https?:\/\/[^/]+\//, ''));
    }
});

// Visible text that indicates a rendering bug rather than a design choice.
const TELLS = [
    [/\bNaN\b/, 'NaN in visible text'],
    [/\bundefined\b/, 'literal "undefined" in visible text'],
    [/Invalid Date/i, 'Invalid Date'],
    [/\[object Object\]/, '[object Object]'],
    [/\$0\.0000\b/, 'price collapsed to $0.0000'],
    [/\bnull\b/, 'literal "null" in visible text'],
];

async function scanText(surface, selector = 'body') {
    const txt = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        // innerText, not textContent: only what a user can actually see.
        return el.innerText || '';
    }, selector).catch(() => null);
    if (txt == null) { add(surface, 'missing', `selector ${selector} not present`); return; }
    for (const [re, label] of TELLS) {
        const m = txt.match(new RegExp(`.{0,60}${re.source}.{0,60}`, re.flags.includes('i') ? 'i' : ''));
        if (m) add(surface, label, m[0].replace(/\s+/g, ' ').trim());
    }
}

async function openPanel(surface, launcher, panel) {
    const l = page.locator(launcher).first();
    if (await l.count() === 0) { add(surface, 'missing', `launcher ${launcher} absent`); return false; }
    await l.click({ timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(1600);
    const shown = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, why: 'panel element absent' };
        const cs = getComputedStyle(el);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetWidth > 0;
        return { ok: vis, len: (el.innerText || '').trim().length };
    }, panel).catch(() => ({ ok: false, why: 'eval failed' }));
    if (!shown.ok) { add(surface, 'panel did not open', `${panel}: ${shown.why || 'hidden'}`); return false; }
    if ((shown.len ?? 0) < 20) add(surface, 'panel opened EMPTY', `${panel}: ${shown.len} chars of text`);
    await scanText(surface, panel);
    return true;
}

console.log(`=== app sweep (${LIVE ? 'LIVE' : ROOT.endsWith('dist') ? 'dist' : 'repo'}) ===`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(LIVE ? 4200 : 2800);
await scanText('boot');

// ── symbols across shapes ────────────────────────────────────────────────────
for (const sym of SYMBOLS) {
    const isCrypto = /-USD$/i.test(sym);
    if (isCrypto) { await page.click('[data-tab="crypto"]').catch(() => null); await page.waitForTimeout(1500); }
    else { await page.click('[data-tab="stock"]').catch(() => null); await page.waitForTimeout(1200); }
    await page.fill('#search-input', isCrypto ? sym.replace(/-USD$/i, '') : sym).catch(() => null);
    await page.waitForTimeout(2600);
    const first = page.locator('#search-results .search-result, #search-results > *').first();
    if (await first.count() > 0 && await first.isVisible().catch(() => false)) {
        await first.click().catch(() => page.press('#search-input', 'Enter'));
    } else await page.press('#search-input', 'Enter').catch(() => null);
    await page.waitForSelector('#signal-section .signal-box, .price-targets', { timeout: 70_000 }).catch(() => null);
    await page.waitForTimeout(1800);
    await scanText(`symbol:${sym}`, '#signal-section');

    // The signal card must not contradict itself: a directional call beside an
    // "indicators are conflicting / no clear direction" blurb is the one Roshan flagged on INTC.
    const contra = await page.evaluate(() => {
        const s = document.querySelector('#signal-section');
        if (!s) return null;
        const t = s.innerText;
        const sig = (t.match(/\b(BUY|SELL|DON'T BUY|AVOID)\b/) || [])[0] || null;
        return {
            signal: sig,
            saysNoDirection: /No clear direction|market is undecided/i.test(t),
            saysConflicting: /conflicting/i.test(t),
        };
    });
    if (contra && (contra.signal === 'BUY' || contra.signal === 'SELL')
        && (contra.saysNoDirection || contra.saysConflicting)) {
        add(`symbol:${sym}`, 'card contradicts itself',
            `headline ${contra.signal} beside "no clear direction / conflicting" text`);
    }

    // Timeframe toggle: Tomorrow re-runs the engine on a different horizon.
    for (const tf of ['Tomorrow', 'Today']) {
        const btn = page.locator(`text="${tf}"`).first();
        if (await btn.count() > 0) {
            await btn.click({ timeout: 6000 }).catch(() => null);
            await page.waitForTimeout(3200);
            await scanText(`symbol:${sym} tf:${tf}`, '#signal-section');
        }
    }
}

// ── panels ───────────────────────────────────────────────────────────────────
console.log('  opening panels…');
await openPanel('panel:portfolio', '#portfolio-launcher', '#portfolio-panel');
await page.keyboard.press('Escape').catch(() => null); await page.waitForTimeout(700);
await openPanel('panel:pl', '#pl-launcher', '#pl-panel');
await page.keyboard.press('Escape').catch(() => null); await page.waitForTimeout(700);
await openPanel('panel:resources', '#about-btn', '#glossary-rail');
await page.keyboard.press('Escape').catch(() => null); await page.waitForTimeout(700);
await openPanel('panel:mia', '#mia-launcher', '#mia-panel');
await page.keyboard.press('Escape').catch(() => null); await page.waitForTimeout(700);

// ── always-on sections ───────────────────────────────────────────────────────
for (const [surface, sel] of [
    ['section:hotpicks', '#hotpicks-grid'],
    ['section:scanner', '#scanner-section'],
    ['section:chart-header', '#chart-header'],
    ['section:accuracy-strip', '#accuracy-strip'],
]) {
    const present = await page.locator(sel).count();
    if (!present) { add(surface, 'missing', `${sel} absent`); continue; }
    await scanText(surface, sel);
}

// ── currency: picking a different currency must actually convert prices ──────
//
// The toggle OPENS A PICKER, it does not cycle. My first version of this check clicked it and
// asserted the label changed, which failed against a perfectly good feature. What matters is
// whether selecting a currency re-renders every [data-usd] price through the FX path.
{
    // #currency-toggle lives INSIDE #header-settings-menu, so it is hidden until settings is
    // opened. Clicking a hidden element does nothing and looked like "the picker is broken".
    await page.click('#settings-toggle').catch(() => null);
    await page.waitForTimeout(900);
    const btn = page.locator('#currency-toggle').first();
    const visible = await btn.isVisible().catch(() => false);
    if (await btn.count() === 0) {
        add('currency', 'missing', '#currency-toggle absent');
    } else if (!visible) {
        add('currency', 'toggle not reachable', 'still hidden after opening #settings-toggle');
    } else {
        const before = await page.evaluate(() =>
            [...document.querySelectorAll('[data-usd]')].slice(0, 12).map(e => e.textContent.trim()));
        await btn.click({ timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(900);
        const item = page.locator('.currency-picker-item[data-code="INR"]').first();
        if (await item.count() === 0) {
            add('currency', 'picker did not open', 'no .currency-picker-item[data-code="INR"] after click');
        } else {
            await item.click({ timeout: 8000 }).catch(() => null);
            await page.waitForTimeout(2600);
            const after = await page.evaluate(() =>
                [...document.querySelectorAll('[data-usd]')].slice(0, 12).map(e => e.textContent.trim()));
            const changed = after.filter((v, i) => v !== before[i]).length;
            if (!before.length) add('currency', 'no prices to convert', 'no [data-usd] elements on the page');
            else if (changed === 0) {
                add('currency', 'selecting INR changed nothing',
                    `${before.length} prices sampled, none re-rendered: ${JSON.stringify(before.slice(0, 3))}`);
            }
            // A converted price must not be the USD number with a rupee sign in front of it.
            const symOnly = after.filter((v, i) => v.replace(/[^0-9.]/g, '') === (before[i] || '').replace(/[^0-9.]/g, '')).length;
            if (before.length && symOnly === after.length) {
                add('currency', 'symbol swapped but value not converted',
                    `every sampled price kept its USD digits: ${JSON.stringify([before[0], after[0]])}`);
            }
            await scanText('currency:INR', 'body');
            // Back to USD so the theme pass below sees the normal state.
            await btn.click({ timeout: 8000 }).catch(() => null);
            await page.waitForTimeout(700);
            await page.locator('.currency-picker-item[data-code="USD"]').first().click({ timeout: 8000 }).catch(() => null);
            await page.waitForTimeout(1600);
        }
    }
}

// ── themes ───────────────────────────────────────────────────────────────────
for (const th of ['dark', 'light', 'aurora', 'midnight', 'ember', 'forest']) {
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), th);
    await page.waitForTimeout(450);
    const unreadable = await page.evaluate(() => {
        // A token that failed to resolve renders as an empty/invalid colour. Sample the surfaces
        // that carry theme tokens and flag any that end up fully transparent.
        const out = [];
        for (const sel of ['.signal-box', '.price-targets', '.fb-table', '#hotpicks-grid']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const cs = getComputedStyle(el);
            if (cs.color === 'rgba(0, 0, 0, 0)') out.push(sel);
        }
        return out;
    });
    if (unreadable.length) add(`theme:${th}`, 'transparent text colour', unreadable.join(', '));
}
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

await page.screenshot({ path: join(REPO, 'tools', '_shots', 'sweep.png'), fullPage: false });
await browser.close();
if (server) server.close();

// ── report ───────────────────────────────────────────────────────────────────
console.log();
if (bad404.size) {
    console.log('SAME-ORIGIN 404s (we asked for a file we do not ship):');
    for (const u of bad404) console.log(`  ${u}`);
    for (const u of bad404) add('network', 'same-origin 404', u);
}
if (pageErrors.length) {
    console.log('\nUNCAUGHT PAGE ERRORS:');
    for (const e of [...new Set(pageErrors)]) { console.log(`  ${e}`); add('js', 'uncaught error', e); }
}
if (consoleErrors.length) {
    console.log('\nCONSOLE ERRORS (third-party noise filtered):');
    for (const e of [...new Set(consoleErrors)].slice(0, 12)) { console.log(`  ${e}`); add('js', 'console error', e); }
}

console.log();
if (!findings.length) {
    console.log('APP SWEEP: no candidates found.');
} else {
    console.log(`APP SWEEP: ${findings.length} candidate(s) to judge\n`);
    const bySurface = new Map();
    for (const f of findings) {
        if (!bySurface.has(f.surface)) bySurface.set(f.surface, []);
        bySurface.get(f.surface).push(f);
    }
    for (const [surface, list] of bySurface) {
        console.log(`  ${surface}`);
        for (const f of list) console.log(`     ${f.kind}: ${f.detail}`);
    }
}
// Deliberately exit 0: this is a FINDING tool, not a gate. Some hits are legitimate placeholders,
// and a sweep that fails the build on an em-dash would be turned off within a week.
process.exitCode = 0;
