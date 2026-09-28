// JS half of the earnings-calendar parity check. Driven by tools/earnings_sync_check.py.
//
// Usage: node tools/earnings_sync_check.mjs <input.json> <repoRoot>
//
// Must live inside the repo: under Git Bash on Windows a /tmp path reaches native node as
// C:\tmp\... and the failure shows up as empty stdout rather than an error.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [inputPath, repoRoot] = process.argv.slice(2);
if (!inputPath || !repoRoot) {
    console.error('usage: node tools/earnings_sync_check.mjs <input.json> <repoRoot>');
    process.exit(2);
}

const mod = await import(pathToFileURL(path.join(repoRoot, 'js/earnings-calendar-slice.js')).href);
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const out = {
    cases: input.cases.map(([sym, region, sess]) => mod.earningsDayFor(sym, region, sess, input.slice)),
    sessionCases: input.sessionCases.map(([region, epochSec]) => mod.sessionDateFor(region, epochSec * 1000)),
};
process.stdout.write(JSON.stringify(out));
