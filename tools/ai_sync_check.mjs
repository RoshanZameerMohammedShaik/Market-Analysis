// Node half of tools/ai_sync_check.py. Runs the REAL browser modules
// (js/ai-model.js + js/xgb-model.js) over the same synthetic candles the Python
// side uses, and prints their results as JSON on stdout.
//
// It imports the shipped modules rather than reimplementing them: a parity test
// that reimplements the code under test can pass while both sides are wrong
// together, which is the mistake tools/band_sync_check.py originally made.
//
// The browser modules fetch their weights with fetch(), which does not exist in
// Node, so a minimal file-backed fetch is installed first. That is the only shim:
// the inference path itself is untouched.
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');

// Map the relative URLs the modules request onto real files. Returning a
// Response-shaped object keeps ai-model.js/xgb-model.js unmodified.
globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\.?\//, '').split('?')[0];
    try {
        const body = await readFile(join(REPO, rel), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    } catch {
        return { ok: false, status: 404, json: async () => null, text: async () => '' };
    }
};

const aiUrl = pathToFileURL(join(REPO, 'js', 'ai-model.js')).href;
const { getAIPrediction, loadModel } = await import(aiUrl);

const payload = JSON.parse(await readFile(process.argv[2], 'utf8'));

// loadModel() primes the LSTM weights and, in ai-model.js, the GBT trees too.
// Without it the first getAIPrediction call would report the model unavailable
// and every case would trivially "agree" as unavailable on both sides.
const loaded = await loadModel();
// Fail LOUDLY if the weights did not load. Without this the harness silently
// reports every case as unavailable, and the Python side then flags a parity
// mismatch that looks like a model disagreement rather than a harness problem.
// A parity test that can fail for reasons unrelated to parity is worse than none.
if (!loaded) {
    console.error('loadModel() returned falsy: LSTM weights did not load. '
        + 'Check that model/lstm_weights.json is readable from ' + REPO);
    process.exit(2);
}

const out = {};
for (const [name, candles] of Object.entries(payload)) {
    try {
        out[name] = await getAIPrediction(candles);
        if (!out[name] || out[name].available !== true) {
            console.error(`case ${name} unavailable on the JS side: `
                + `${out[name] && out[name].reason}`);
        }
    } catch (e) {
        out[name] = { available: false, reason: 'threw: ' + e.message };
    }
}
process.stdout.write(JSON.stringify(out));
