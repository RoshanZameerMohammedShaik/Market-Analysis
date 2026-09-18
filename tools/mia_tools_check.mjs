/**
 * Mia's tool registry must be internally consistent, and must cover the app.
 *
 * TWO FAILURE MODES THIS CATCHES
 * -----------------------------
 * 1. DECLARED BUT NOT IMPLEMENTED. Gemini reads tool-schemas.js to decide what it can call. A name
 *    there with no matching entry in tools.js means the model confidently invokes something that
 *    does not exist, and the user sees Mia try and fail at a thing she just offered to do.
 * 2. IMPLEMENTED BUT NOT DECLARED. The reverse is quieter and was real: a working tool the model is
 *    never told about is dead code, and the capability silently does not exist. Mia had no desk
 *    tools at all, so "how is your desk doing" left her guessing at a P&L figure — the single worst
 *    thing this app can do.
 *
 * It also asserts coverage of the surfaces Mia SHOULD reach, and the one she deliberately should not:
 * arming or resetting the auto-trading desk moves money and needs a GitHub PAT the user pastes
 * himself. The desk once opened a $25,000 book from a config default and ran 11 fills nobody asked
 * for ("I never initiated it"). A model that can be talked into "go ahead and start trading"
 * reintroduces that with a friendlier face, so reading is wired and starting is not.
 *
 * Run: node tools/mia_tools_check.mjs
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(resolve(REPO, rel)).href);

// tools.js reaches into browser globals through its imports. Shim the minimum so the module loads.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
globalThis.document = { dispatchEvent: () => true, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.window = globalThis;

const PASS = [], FAIL = [];
const check = (n, c, d = '') => {
    (c ? PASS : FAIL).push(n);
    console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? `  -> ${d}` : ''}`);
};

const schemas = await imp('js/mia/tool-schemas.js');
const decls = schemas.TOOL_DECLARATIONS || [];
const declared = decls.map(d => d.name).filter(Boolean);

let implemented = [];
try {
    const t = await imp('js/mia/tools.js');
    // The registry is not exported directly -- listTools() is the public surface. Guessing an export
    // name silently produced an empty set, which reported all 75 tools as unimplemented. Use the
    // accessor the module actually offers.
    const listed = typeof t.listTools === 'function' ? t.listTools() : null;
    implemented = Array.isArray(listed)
        ? listed.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean)
        : Object.keys(t.TOOLS || t.default || {});
} catch (e) {
    console.log(`  (tools.js could not be imported in Node: ${String(e.message).slice(0, 90)})`);
    console.log('  Falling back to a source scan for the dispatch keys.');
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(resolve(REPO, 'js/mia/tools.js'), 'utf-8');
    // Dispatch entries look like `    tool_name: {` at two-space-plus indentation.
    implemented = [...src.matchAll(/^\s{4}([a-z][a-z0-9_]{2,}):\s*\{/gm)].map(m => m[1]);
}

console.log('=== declarations and dispatch must agree ===');
console.log(`     declared ${declared.length}, implemented ${implemented.length}`);
const noImpl = declared.filter(n => !implemented.includes(n));
const noDecl = implemented.filter(n => !declared.includes(n));
check('every declared tool has an implementation', noImpl.length === 0, noImpl.join(', '));
check('every implemented tool is declared to the model', noDecl.length === 0, noDecl.join(', '));
check('no duplicate declarations', new Set(declared).size === declared.length,
      declared.filter((n, i) => declared.indexOf(n) !== i).join(', '));
check('every declaration has a description the model can act on',
      decls.every(d => typeof d.description === 'string' && d.description.length > 30),
      decls.filter(d => !d.description || d.description.length <= 30).map(d => d.name).join(', '));
check('every declaration has a parameters object',
      decls.every(d => d.parameters && d.parameters.type === 'OBJECT'),
      decls.filter(d => !d.parameters || d.parameters.type !== 'OBJECT').map(d => d.name).join(', '));
// Gemini's WebSocket wire format rejects lowercase type names even though some SDKs accept them.
const badTypes = [];
for (const d of decls) {
    for (const [k, v] of Object.entries(d.parameters?.properties || {})) {
        if (v.type && v.type !== v.type.toUpperCase()) badTypes.push(`${d.name}.${k}=${v.type}`);
    }
}
check('all parameter types are UPPERCASE (the wire format requires it)', badTypes.length === 0,
      badTypes.join(', '));

console.log();
console.log('=== the surfaces Mia should be able to reach ===');
const want = {
    'the auto-trading desk (read)': ['get_desk_status', 'get_desk_trades'],
    'a named display currency': ['set_currency'],
    'the practice portfolio': ['get_portfolio', 'place_trade', 'instantiate_portfolio'],
    'the watchlist': ['add_to_watchlist', 'remove_from_watchlist', 'get_watchlist'],
    'symbol navigation': ['select_symbol', 'analyze_symbol', 'switch_mode', 'switch_timeframe'],
    'themes': ['set_theme', 'cycle_theme'],
    'panels': ['open_portfolio_panel', 'open_pl_panel', 'open_resources'],
    'hot picks and spikers': ['get_hot_picks', 'refresh_hot_picks', 'find_spikers'],
    'price alerts': ['set_price_alert'],
    'the ledger and accuracy record': ['get_ledger_history', 'get_accuracy_stats', 'get_source_accuracy'],
    'time travel': ['set_time_travel', 'clear_time_travel'],
    // The scanner's WINDOW was reachable and its FILTERS were not, so Mia could set the time range
    // of a table she had no way to narrow.
    'the ledger scanner filters and window': ['filter_scanner', 'set_accuracy_window'],
};
for (const [label, names] of Object.entries(want)) {
    const missing = names.filter(n => !declared.includes(n));
    check(`can reach ${label}`, missing.length === 0, `missing ${missing.join(', ')}`);
}

console.log();
console.log('=== and the one she must NOT reach ===');
// Naming the exact verbs rather than a loose regex, so a future read-only tool with "desk" in its
// name does not trip this and get removed by someone trusting the test over the intent.
const forbidden = ['arm_desk', 'start_desk', 'stop_desk', 'reset_desk', 'clear_desk',
                   'set_allocation', 'allocate_desk', 'disarm_desk'];
const present = forbidden.filter(n => declared.includes(n) || implemented.includes(n));
check('no tool can arm, stop, reset or fund the auto-trading desk', present.length === 0,
      present.join(', '));

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'MIA TOOLS CHECK PASS' : 'MIA TOOLS CHECK FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=mia_tools::${FAIL.slice(0, 6).join('; ')}`);
process.exitCode = ok ? 0 : 1;
