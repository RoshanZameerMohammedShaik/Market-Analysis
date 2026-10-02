// Node half of tools/vol_sync_check.py: evaluate the same cases with js/vol-forecast.js.
import { readFileSync } from 'node:fs';
import { volFeatures, volPredict } from '../js/vol-forecast.js';

const { markets, cases } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const model = JSON.parse(readFileSync(new URL('../model/vol_model.json', import.meta.url), 'utf8'));
const out = cases.map(c => {
    const f = volFeatures(c.bars, markets[c.m], c.earn, c.dow, c.iv);
    return { f, p: volPredict(model, f) };
});
process.stdout.write(JSON.stringify(out));
