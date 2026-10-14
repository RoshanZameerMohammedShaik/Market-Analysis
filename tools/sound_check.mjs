/**
 * Renders every interface sound offline and checks what can be measured about it.
 *
 * Nobody can hear a CI run, so this checks the things that make a cue sound cheap or broken
 * rather than taste: that each cue actually makes sound, never clips, has no click at the end
 * (a tail cut off mid-wave), sits at a sensible level next to the others (a tab tick must never
 * be louder than a result chime), and that hover stays silent. It also catches audio-graph
 * errors (a bad ramp, a bad buffer offset) that would otherwise only show up as a silent app.
 *
 * Method: window.AudioContext is swapped for an OfflineAudioContext before the engine first
 * asks for one, the cue is called, and the rendered buffer is measured. One page per cue, since
 * the engine keeps one context for the life of the page.
 *
 * Run: node tools/sound_check.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 8153;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer(async (req, res) => {
    try {
        const p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>s</title>'); return; }
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
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// [label, module, call]. The call runs inside the page with the module as `m`.
const CUES = [
    ['tab', '/js/ui/ui-sound.js', 'm.tab()'],
    ['toggle', '/js/ui/ui-sound.js', 'm.toggle()'],
    ['click', '/js/ui/ui-sound.js', 'm.click()'],
    ['open', '/js/ui/ui-sound.js', 'm.open()'],
    ['close', '/js/ui/ui-sound.js', 'm.close()'],
    ['success', '/js/ui/ui-sound.js', 'm.success()'],
    ['error', '/js/ui/ui-sound.js', 'm.error()'],
    ['notification', '/js/ui/ui-sound.js', 'm.notification()'],
    ['landed up', '/js/ui/ui-sound.js', "m.signalLanded('up', 'X|BUY')"],
    ['landed down', '/js/ui/ui-sound.js', "m.signalLanded('down', 'X|SELL')"],
    ['landed flat', '/js/ui/ui-sound.js', "m.signalLanded('flat', 'X|DONT_BUY')"],
    ['grid ready', '/js/ui/ui-sound.js', 'm.gridReady()'],
    ['hover', '/js/ui/ui-sound.js', 'm.hover()'],
    ['mia tick', '/js/mia/sound.js', 'm.tick()'],
    ['mia complete', '/js/mia/sound.js', 'm.complete()'],
    ['mia connecting', '/js/mia/sound.js', 'm.connecting()'],
    ['mia connected', '/js/mia/sound.js', 'm.connected()'],
    ['mia listening on', '/js/mia/sound.js', 'm.listeningOn()'],
    ['mia listening off', '/js/mia/sound.js', 'm.listeningOff()'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const out = {};
for (const [label, mod, call] of CUES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/__blank`);
    const r = await page.evaluate(async ({ mod, call }) => {
        const RATE = 44100, SECONDS = 3;
        let made = null;
        // Every `new AudioContext()` in the engine gets this offline one instead.
        window.AudioContext = function () { made = new OfflineAudioContext(2, RATE * SECONDS, RATE); return made; };
        window.webkitAudioContext = window.AudioContext;
        const m = await import(mod);
        (0, eval)('(m) => { ' + call + '; }')(m);
        if (!made) return { silent: true, peak: 0, rms: 0 };
        const buf = await made.startRendering();
        let peak = 0, sum = 0, last = 0, n = 0;
        const L = buf.getChannelData(0), R = buf.getChannelData(1);
        for (let i = 0; i < L.length; i++) {
            const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
            if (a > peak) peak = a;
            if (a > 1e-4) last = i;
            sum += L[i] * L[i] + R[i] * R[i]; n += 2;
        }
        // Loudness over the part that sounds (RMS of the active span), and the level of the very
        // last rendered sample: a cue whose tail is still loud at the end of the buffer was cut.
        let act = 0, an = 0;
        for (let i = 0; i <= last; i++) { act += L[i] * L[i] + R[i] * R[i]; an += 2; }
        const tailEnd = Math.max(Math.abs(L[L.length - 1]), Math.abs(R[R.length - 1]));
        return { silent: peak < 1e-4, peak, rms: Math.sqrt(act / Math.max(1, an)), lengthMs: Math.round(last / RATE * 1000), tailEnd };
    }, { mod, call });
    out[label] = { ...r, errors };
    await page.close();
}
await browser.close();
server.close();

const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
console.log('\ncue                  peak dBFS   rms dBFS   length');
for (const [k, r] of Object.entries(out)) {
    console.log(`  ${k.padEnd(19)} ${db(r.peak).padStart(8)}   ${db(r.rms).padStart(8)}   ${r.silent ? 'silent' : r.lengthMs + ' ms'}`);
}
console.log('');
for (const [k, r] of Object.entries(out)) {
    if (r.errors.length) check(`${k}: no page errors`, false, r.errors[0]);
}
check('hover is silent', out.hover.silent);
for (const [k, r] of Object.entries(out)) {
    if (k === 'hover') continue;
    check(`${k}: makes a sound`, !r.silent);
    check(`${k}: never clips (peak under -1 dBFS)`, r.peak < 0.89, `peak ${db(r.peak)} dBFS`);
    check(`${k}: ends cleanly`, r.tailEnd < 1e-3, `last sample ${r.tailEnd.toExponential(1)}`);
}
// Taps are felt, not heard: under every chime. And every cue stays under 2.5 s.
const loudestTap = Math.max(out.tab.peak, out.toggle.peak, out['mia tick'].peak);
const quietestChime = Math.min(out.success.peak, out.notification.peak, out['landed up'].peak, out['landed down'].peak);
check('a tab or toggle tick is quieter than any result chime', loudestTap < quietestChime,
    `tick ${db(loudestTap)} vs chime ${db(quietestChime)} dBFS`);
check('the error cue is not louder than success', out.error.peak <= out.success.peak * 1.12,
    `error ${db(out.error.peak)} vs success ${db(out.success.peak)}`);
check('every cue is short (under 2.5 s)', Object.values(out).every((r) => r.silent || r.lengthMs < 2500));

console.log(`\n${FAIL.length ? 'SOUND CHECK FAIL' : 'SOUND CHECK PASS'}: ${PASS.length} passed, ${FAIL.length} failed`);
process.exit(FAIL.length ? 1 : 0);
