// JS half of the band parity check. Driven by tools/band_sync_check.py.
//
// Loads js/forecast-band.js exactly as the browser would, with fetch stubbed to
// read model/band_calibration.json off disk, then emits the forecast for each
// input symbol as JSON on stdout so Python can diff it against its own math.
//
// Usage: node tools/band_sync_check.mjs <input.json> <repoRoot>
//
// NOTE: this file must live inside the repo, not in /tmp. Under Git Bash on
// Windows a "/tmp/x.mjs" argument reaches native node as "C:\tmp\x.mjs", which
// does not exist, and the failure surfaces as an empty stdout rather than an
// obvious error.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [inputPath, repoRoot] = process.argv.slice(2);
if (!inputPath || !repoRoot) {
    console.error('usage: node tools/band_sync_check.mjs <input.json> <repoRoot>');
    process.exit(2);
}

globalThis.fetch = async (u) => {
    const p = path.isAbsolute(u) ? u : path.join(repoRoot, u);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

const mod = await import(pathToFileURL(path.join(repoRoot, 'js/forecast-band.js')).href);
const cal = await mod.loadBandCalibration();
await mod.loadBandBlend();
if (cal._fallback) {
    console.error('ERROR: calibration did not load; refusing to compare against a fallback.');
    process.exit(3);
}

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const out = {};

// WHERE A BAND STARTS (forecast-band.js bandAnchor and its helpers), against the same published
// exchange calendar the Python side reads.
const anchorCases = input._anchors;
delete input._anchors;
if (anchorCases) {
    const sessions = await import(pathToFileURL(path.join(repoRoot, 'js/market-sessions.js')).href);
    const calPath = path.join(repoRoot, 'model', 'market_sessions.json');
    if (fs.existsSync(calPath)) sessions.setMarketSessions(JSON.parse(fs.readFileSync(calPath, 'utf8')));
    const ecs = await import(pathToFileURL(path.join(repoRoot, 'js/earnings-calendar-slice.js')).href);
    out._anchors = {
        complete: anchorCases.complete.map(c => ecs.isBarComplete(c.region, c.bar, Date.parse(c.now))),
        next: anchorCases.next.map(c => ecs.nextSessionAfter(c.region, c.iso)),
        sessionOf: anchorCases.sessionOf.map(c => ecs.barSessionDate(c.region, c.time)),
        anchor: anchorCases.anchor.map(c => {
            const a = mod.bandAnchor(c.candles, c.region, Date.parse(c.now));
            return a ? { index: a.index, session: a.session, day1: a.day1 } : null;
        }),
    };
}

for (const [sym, o] of Object.entries(input)) {
    const r = mod.forecastBands({
        candles: o.candles,
        currentPrice: o.price,
        cryptoMode: !!o.crypto,
        // null / 0 / 1..7 selects the pooled, ordinary-week or earnings z family.
        earningsDay: o.earningsDay ?? null,
        // The live correction (tools/write_band_live.py), when the fixture carries one.
        region: o.region ?? null,
        live: o.live ?? null,
        // The blended band for a liquid US listing (tools/calibrate_band_blend.py).
        sigmaVol: o.sigmaVol ?? null,
        // Pinned so date labels are deterministic across runs.
        now: new Date('2026-01-02T00:00:00Z'),
    });
    out[sym] = r === null ? null : {
        sigmaDaily: r.sigmaDaily,
        volTier: r.volTier,
        calibrated: r.calibrated,
        uncalibratedReason: r.uncalibratedReason ?? null,
        confidence: r.confidence,
        earningsDay: r.earningsDay ?? null,
        m: r.m ?? null,
        sigmaSource: r.sigmaSource ?? null,
        days: r.days.map(d => ({ day: d.day, low: d.low, high: d.high })),
    };
}
process.stdout.write(JSON.stringify(out));
