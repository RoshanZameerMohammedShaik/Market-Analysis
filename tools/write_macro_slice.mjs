/**
 * Publish the FRED macro series as model/macro.json so the BROWSER can read them.
 *
 * WHY THIS EXISTS
 * ---------------
 * fred.stlouisfed.org sends no Access-Control-Allow-Origin header, so a browser cannot
 * fetch it -- directly or through any of our fallbacks. Our Worker allowlists only the two
 * Yahoo hosts, and the public CORS proxies fail on FRED too. Verified in a real browser on
 * 2026-09-10: js/macro.js returned `available: false` with all four components null, while
 * the same module scored 28/28 in tools/macro_check.mjs because that check runs in NODE,
 * where there is no CORS at all.
 *
 * So one of the engine's four ensemble sources was contributing nothing in the app the user
 * actually opens, and the engine still printed a confident number. Same defect class as the
 * dead sentiment source.
 *
 * Node can read FRED. So Node writes the file and the browser reads it from its own origin:
 * no CORS, no proxy chain, and zero Worker requests against a 10k/day quota that has
 * already been blown once this month.
 *
 * RAW ROWS, NOT A SCORE
 * ---------------------
 * The slice carries the series observations, not a finished macro score. The browser runs
 * js/macro.js's own scoreSeries() over them, so there is exactly ONE implementation of the
 * scoring. Publishing a computed score would put that logic in two places and let them
 * drift -- which is how the ledger once ended up with two engines disagreeing about one
 * prediction.
 *
 * Run: node tools/write_macro_slice.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'model', 'macro.json');

const { fetchSeriesDirect, macroSeriesIds, getMacroScore } =
    await import(pathToFileURL(join(REPO, 'js', 'macro.js')).href);

// How many observations to keep per series. The scorers reach back 61 daily points
// (change60) and 13 monthly ones (change12m); 420 covers both with room for holiday gaps
// while keeping the file tiny. Sending the full history would be megabytes for no gain.
const KEEP = 420;

const ids = macroSeriesIds();
console.log(`fetching ${ids.length} FRED series: ${ids.join(', ')}`);

const series = {};
const failed = [];
for (const id of ids) {
    try {
        const rows = await fetchSeriesDirect(id);
        if (!rows.length) throw new Error('no parseable rows');
        series[id] = rows.slice(-KEEP);
        const last = series[id][series[id].length - 1];
        console.log(`  ${id.padEnd(8)} ${String(series[id].length).padStart(4)} rows  latest ${last.date} = ${last.value}`);
    } catch (e) {
        failed.push(id);
        console.error(`  ${id.padEnd(8)} FAILED: ${e.message}`);
    }
}

// Refuse to publish an empty slice. Overwriting a good file with one that has no series
// would take the browser's macro source down until the next successful run, which is
// strictly worse than leaving yesterday's readings in place -- macro moves slowly enough
// that a day-old file is still a useful reading, and getMacroScore reports its own asOf
// dates so staleness is visible rather than hidden.
if (!Object.keys(series).length) {
    console.error('refusing to write an empty macro slice; leaving the existing file alone');
    process.exitCode = 1;
} else {
    // Merge over what is already published so one series failing does not delete it.
    let existing = null;
    try { existing = JSON.parse(await readFile(OUT, 'utf-8')); } catch (_) { /* first run */ }
    const merged = { ...(existing?.series || {}), ...series };

    const payload = {
        schema: 1,
        generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        // Named so a reader of the file knows why it exists at all.
        note: 'FRED observations republished for the browser; FRED itself sends no CORS header. '
            + 'Raw rows on purpose -- js/macro.js scores them, so there is one scorer.',
        failed,
        series: merged,
    };

    await mkdir(join(REPO, 'model'), { recursive: true });
    await writeFile(OUT, JSON.stringify(payload), 'utf-8');

    const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
    console.log(`wrote model/macro.json  ${kb} KB  ${Object.keys(merged).length} series`
        + (failed.length ? `  (${failed.length} failed, kept previous)` : ''));

    // Prove the published file actually scores, rather than trusting that it will. A slice
    // that parses but produces available:false is the failure this whole exercise is about.
    const score = await getMacroScore();
    console.log(`macro score from these series: ${score.score} (available=${score.available}, `
        + `${score.componentsUsed ?? 0} components)`);
    if (!score.available) {
        console.error('::error title=write_macro_slice::the published series do not produce a macro score');
        process.exitCode = 1;
    }
}
