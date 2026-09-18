/**
 * Every tracked .js file must parse as an ES module.
 *
 * WHY THIS EXISTS AS ITS OWN GATE
 * ------------------------------
 * `node --check some.js` does NOT do what it appears to. Without "type": "module" in package.json,
 * Node treats a .js file as CommonJS, and this repo is entirely ES modules. The result was a syntax
 * gate that reported success on a file containing a hard syntax error:
 *
 *     desc: 'The auto-trading desk's fill log, ...'
 *            ^ unescaped apostrophe, terminates the string
 *
 * That was in js/mia/tools.js. It would have taken Mia down completely in the browser -- the module
 * simply would not load -- and `node --check` said it was fine. Every "syntax OK" in that session was
 * weaker than it looked.
 *
 * package.json now declares "type": "module", which makes --check parse these as modules. This file
 * exists so that guarantee is enforced across the whole tree on every run rather than depending on
 * someone remembering to check the one file they edited. The same apostrophe mistake recurred three
 * times in one session; a gate is cheaper than vigilance.
 *
 * Run: node tools/js_syntax_check.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const REPO = resolve(import.meta.dirname, '..');

// --cached AND --others: tracked files PLUS new ones that are not gitignored.
//
// `git ls-files` alone lists only the index, so a brand-new file is invisible to this gate until it
// is staged -- which is exactly when a fresh syntax error is most likely and least wanted. My first
// version of this check did that and then failed to catch a deliberately broken file I had just
// written, because I had not added it yet. --exclude-standard keeps dist/ and node_modules out via
// .gitignore rather than a hardcoded list that would drift.
const { stdout: listing } = await run(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.mjs'],
    { cwd: REPO, maxBuffer: 1 << 24 });
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(f => !f.startsWith('dist/'));

// A module-scoped assertion, not just a parse: confirm package.json actually declares ESM, because
// without it every check below silently weakens back to a CommonJS parse.
const { readFile } = await import('node:fs/promises');
const pkg = JSON.parse(await readFile(resolve(REPO, 'package.json'), 'utf-8'));
const esm = pkg.type === 'module';

const failures = [];
for (const f of files) {
    try {
        await run(process.execPath, ['--check', f], { cwd: REPO, maxBuffer: 1 << 22 });
    } catch (e) {
        const msg = String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ').trim();
        failures.push([f, msg]);
    }
}

console.log(`checked ${files.length} tracked JS files`);
console.log(`package.json "type": ${pkg.type || '(unset)'}`);
if (!esm) {
    console.log('::error title=js_syntax::package.json must declare "type": "module", or node --check '
        + 'parses these ES modules as CommonJS and silently passes files with real syntax errors.');
}
if (failures.length) {
    console.log('\nSYNTAX ERRORS:');
    for (const [f, msg] of failures) console.log(`  ${f}\n     ${msg}`);
}

const ok = esm && failures.length === 0;
console.log(`\n${ok ? 'JS SYNTAX CHECK PASS' : 'JS SYNTAX CHECK FAIL'}: `
    + `${files.length - failures.length}/${files.length} parse as ES modules`);
if (!ok && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=js_syntax::${failures.map(([f]) => f).slice(0, 8).join(', ') || 'package.json type'}`);
}
process.exitCode = ok ? 0 : 1;
