/**
 * Assemble the deployable site into dist/ for Cloudflare Pages.
 *
 * WHY A BUNDLE AND NOT `wrangler pages deploy .`
 * ---------------------------------------------
 * Cloudflare Pages rejects any single file over 25 MiB, and this repo tracks four ledger shards
 * that break that outright:
 *
 *     model/ledger/2026-07.jsonl   40.2 MB
 *     model/ledger/2026-06.jsonl   34.4 MB
 *     model/ledger/2026-08.jsonl   33.3 MB
 *     model/ledger/2026-09.jsonl   29.4 MB
 *
 * plus an untracked model/replay_panel.jsonl at 182 MB. Deploying the repo root fails on those,
 * and none of them are needed: the browser reads the 3-day recent.json slice, never a raw shard.
 * (loadLedger() still asks for `model/ledger/2026.jsonl`, which stopped existing when the ledger
 * was sharded monthly, so that fallback has been silently returning [] for weeks. Worth fixing
 * separately -- it is not a reason to ship 137 MB of JSONL to a CDN.)
 *
 * An explicit allowlist also means a new 40 MB artifact landing in model/ can never break a deploy
 * by accident, which an ignore-list would allow.
 *
 * VERIFY, DO NOT TRUST
 * -------------------
 * A missing file here is a silently broken site. So after building, serve dist/ and run the real
 * browser checks against it:
 *
 *     node tools/build_pages_dist.mjs
 *     node tools/band_agreement_check.mjs --dist --symbols AAPL,INTC
 *     node tools/browser_sources_check.mjs --dist
 *
 * If those pass against dist/ the bundle is complete, because they drive the actual app.
 *
 * Run: node tools/build_pages_dist.mjs [--out dist]
 */
import { readFile, writeFile, mkdir, rm, cp, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flagOut = args.indexOf('--out');
const OUT = resolve(REPO, flagOut >= 0 && args[flagOut + 1] ? args[flagOut + 1] : 'dist');

// Cloudflare's hard per-file ceiling is 25 MiB. Refuse a little under it so a file that grows
// between build and deploy does not fail at the edge instead of here.
const MAX_FILE = 24 * 1024 * 1024;

// Whole directories the browser loads from.
const DIRS = ['css', 'js', 'dev'];

// Individual files at the root.
const FILES = [
    'index.html',
    'manifest.webmanifest',
    'sw.js',
    '_headers',          // Cloudflare reads this at deploy time for the edge cache policy
    'ui-preview.html',   // static style reference, tiny, useful when checking a theme
];

// Model artifacts, listed one by one. Every entry here is fetched by name somewhere in js/ --
// verified with `grep -rhoE "model/[a-zA-Z0-9_./-]+" js/`.
// Artifacts the code asks for but which may legitimately not exist yet. ai-model.js registers
// './model/lstm_weights_intraday.json' and falls back to the daily model when the fetch fails --
// that model has never been trained, so the file has never shipped. Listing it as REQUIRED made
// this builder fail a perfectly good bundle. Optional means "copy it if present, do not fail".
const MODEL_OPTIONAL = [
    'model/lstm_weights_intraday.json',
];

const MODEL = [
    'model/backtest_results.json',
    'model/band_calibration.json',
    'model/live_calibration.json',
    'model/lstm_weights.json',
    'model/lstm_weights_penny.json',
    'model/xgb_trees.json',
    'model/macro.json',
    'model/ledger/recent.json',
    'model/bot/timeline.json',
    'model/bot/config.json',
];

async function exists(p) {
    try { await stat(p); return true; } catch { return false; }
}

async function walk(dir, out = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, out);
        else out.push(p);
    }
    return out;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const copied = [];
const missing = [];
const oversize = [];

async function take(rel) {
    const src = join(REPO, rel);
    if (!await exists(src)) { missing.push(rel); return; }
    const st = await stat(src);
    if (st.size > MAX_FILE) { oversize.push([rel, st.size]); return; }
    const dst = join(OUT, rel);
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst);
    copied.push([rel, st.size]);
}

for (const d of DIRS) {
    const abs = join(REPO, d);
    if (!await exists(abs)) { missing.push(d + '/'); continue; }
    for (const f of await walk(abs)) await take(relative(REPO, f).split('\\').join('/'));
}
for (const f of [...FILES, ...MODEL, ...MODEL_OPTIONAL]) await take(f);

const total = copied.reduce((n, [, s]) => n + s, 0);
console.log(`built ${relative(REPO, OUT)}/  ${copied.length} files  ${(total / 1048576).toFixed(1)} MB`);

const byTop = new Map();
for (const [rel, size] of copied) {
    const k = rel.split('/')[0];
    const cur = byTop.get(k) || [0, 0];
    byTop.set(k, [cur[0] + 1, cur[1] + size]);
}
for (const [k, [n, s]] of [...byTop].sort((a, b) => b[1][1] - a[1][1])) {
    console.log(`  ${k.padEnd(22)} ${String(n).padStart(4)} files  ${(s / 1048576).toFixed(2)} MB`);
}

if (missing.length) {
    console.log(`\nMISSING (not copied): ${missing.join(', ')}`);
}
if (oversize.length) {
    console.log('\nREFUSED, over Cloudflare\'s 25 MiB per-file limit:');
    for (const [rel, size] of oversize) console.log(`  ${rel}  ${(size / 1048576).toFixed(1)} MB`);
}

// Pages also caps a deployment at 20,000 files. Nowhere near it, but assert rather than assume.
if (copied.length > 20000) {
    console.error(`::error::${copied.length} files exceeds Cloudflare Pages' 20,000-file limit`);
    process.exitCode = 1;
}
// index.html is the one file whose absence means a blank site.
if (!await exists(join(OUT, 'index.html'))) {
    console.error('::error::dist/index.html is missing; refusing to call this a build');
    process.exitCode = 1;
}
// A model file quietly absent is a source that dies in the browser, which is exactly the class of
// failure that hid the dead macro source for weeks. Fail loudly instead.
const modelMissing = MODEL.filter(m => missing.includes(m));   // MODEL_OPTIONAL excluded on purpose
if (modelMissing.length) {
    console.error(`::error::model artifacts missing from the bundle: ${modelMissing.join(', ')}`);
    process.exitCode = 1;
}
