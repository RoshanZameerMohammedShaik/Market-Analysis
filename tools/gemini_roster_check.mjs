/**
 * Verify the Gemini model roster, the quota-scope cooldown, and the Live model chain.
 *
 * WHY THESE THREE TOGETHER
 * -----------------------
 * Roshan's 2026-09-18 AI Studio dashboard introduced Gemini 3.8 and exposed a structural problem in
 * how the free tier was being used:
 *
 *     Gemini 3.8 Flash       23 / 20 RPD    OVER
 *     Gemini 3.7 Flash       22 / 20 RPD    OVER      (was missing from the roster entirely)
 *     Gemini 3.6 Flash       21 / 20 RPD    OVER      (also missing)
 *     Gemini 3 Flash         21 / 20 RPD    OVER
 *     Gemini 3.5 Flash       20 / 20 RPD    AT LIMIT
 *     Gemini 2.5 Flash       20 / 20 RPD    AT LIMIT
 *     Gemini 3.5 Flash Lite  21 / 500 RPD   headroom  (also missing)
 *     Gemini 3.1 Flash Lite   6 / 500 RPD   headroom
 *     Gemma 4 26B            14 / 14.4K RPD headroom
 *
 * Three things followed from that:
 *   1. Two live models (3.6, 3.7) and a 500-RPD Lite were absent, so their quota went unused.
 *   2. Every 429 was capped at a 30-minute cooldown, so six models whose DAILY quota was spent got
 *      retried every half hour until midnight -- six wasted round-trips before every answer.
 *   3. The Live API is the opposite shape: unlimited RPM and RPD, only TPM capped. Voice is the
 *      cheap path, and the Live chain re-discovered model access from scratch every session.
 *
 * Run: node tools/gemini_roster_check.mjs
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(resolve(REPO, rel)).href);

// tier-cooldown persists through localStorage and announces changes on document.
const store = new Map();
globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
};
globalThis.document = { dispatchEvent: () => true };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };

const PASS = [], FAIL = [];
const check = (n, c, d = '') => {
    (c ? PASS : FAIL).push(n);
    console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? `  -> ${d}` : ''}`);
};

// ── roster ────────────────────────────────────────────────────────────────────
const { GEMINI_MODELS, shortName } = await imp('js/mia/backends/gemini-models.js');
console.log('=== the roster covers every model the dashboard shows as usable ===');
const ids = GEMINI_MODELS.map(m => m.id);
for (const want of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash',
                    'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
    check(`${want} is in the roster`, ids.includes(want), ids.join(', ').slice(0, 120));
}
check('no duplicate model ids', new Set(ids).size === ids.length,
      `${ids.length} entries, ${new Set(ids).size} unique`);
check('every entry has a tier of reasoning or fast',
      GEMINI_MODELS.every(m => m.tier === 'reasoning' || m.tier === 'fast'),
      JSON.stringify(GEMINI_MODELS.filter(m => !['reasoning', 'fast'].includes(m.tier))));
check('every entry has a label for the status pill', GEMINI_MODELS.every(m => !!m.label));
check('3.8 leads the reasoning tier',
      GEMINI_MODELS.filter(m => m.tier === 'reasoning')[0].id === 'gemini-3.8-flash',
      GEMINI_MODELS.filter(m => m.tier === 'reasoning')[0].id);

// The load-bearing ordering claim: the models that still have quota when the good ones are spent
// must not be buried behind the ones that are already exhausted.
const fast = GEMINI_MODELS.filter(m => m.tier === 'fast');
const firstTwoFast = fast.slice(0, 2);
check('the 500-RPD Lites lead the fast tier',
      firstTwoFast.every(m => m.rpd === 500),
      firstTwoFast.map(m => `${m.id}(${m.rpd})`).join(', '));
const lite25 = fast.findIndex(m => m.id === 'gemini-2.5-flash-lite');
const lite35 = fast.findIndex(m => m.id === 'gemini-3.5-flash-lite');
check('the 500-RPD 3.5 Lite is ahead of the 20-RPD 2.5 Lite', lite35 < lite25, `${lite35} vs ${lite25}`);
check('shortName renders 3.8 for the status pill',
      typeof shortName('gemini-3.8-flash') === 'string' && shortName('gemini-3.8-flash').length > 0,
      shortName('gemini-3.8-flash'));

// ── cooldown scope ────────────────────────────────────────────────────────────
const cd = await imp('js/mia/backends/tier-cooldown.js');
console.log();
console.log('=== a DAILY 429 must park the model until the quota resets, not for 30 minutes ===');
store.clear();
const minuteReset = cd.markCooling('m-model', 45, 'minute');
const minuteMs = minuteReset - Date.now();
check('a per-minute 429 honours the short server hint',
      minuteMs > 40_000 && minuteMs < 50_000, `${Math.round(minuteMs / 1000)}s`);

const dayReset = cd.markCooling('d-model', 45, 'day');
const dayMs = dayReset - Date.now();
// Must be far longer than the old 30-minute ceiling, and never more than a day plus slack.
check('a per-day 429 parks for hours, not 30 minutes',
      dayMs > 31 * 60 * 1000, `${Math.round(dayMs / 60000)} min`);
check('and never longer than about a day',
      dayMs <= 25 * 60 * 60 * 1000, `${(dayMs / 3600000).toFixed(1)} h`);
check('the short server hint does NOT shorten a daily park',
      dayMs > 45_000, `${Math.round(dayMs / 1000)}s`);
check('the scope is recorded so the UI can say which it is',
      cd.coolingScope('d-model') === 'day' && cd.coolingScope('m-model') === 'minute',
      `${cd.coolingScope('d-model')} / ${cd.coolingScope('m-model')}`);
check('both models read as cooling', cd.isCooling('d-model') && cd.isCooling('m-model'));
check('an unknown model is not cooling', !cd.isCooling('never-seen'));
// Default scope must stay the safe short one, so an un-updated call site cannot park a model all day.
store.clear();
cd.markCooling('legacy-call', undefined);
const legacyMs = cd.msUntilHealthy('legacy-call');
check('an unscoped call defaults to the SHORT cooldown',
      legacyMs > 0 && legacyMs <= 60_000, `${Math.round(legacyMs / 1000)}s`);

// ── live chain ────────────────────────────────────────────────────────────────
console.log();
console.log('=== the Live chain leads with 3.8 and remembers what actually connected ===');
const vl = await imp('js/mia/voice-live.js');
const live = Object.values(vl.VOICE_LIVE_MODELS);
check('a 3.8 Live id leads the chain', /3\.8/.test(live[0]), live[0]);
check('the 3.1 fallback is still present', live.some(m => m === 'gemini-3.1-flash-live-preview'));
check('the 2.5 native-audio fallback is still present',
      live.some(m => m.includes('native-audio-dialog')));
check('no duplicate live ids', new Set(live).size === live.length);

store.clear();
check('with nothing remembered the pick is null', vl.currentLivePick() === null);
// A remembered pick must be honoured...
store.set('mia-live-model-pick', JSON.stringify({ model: 'gemini-3.1-flash-live-preview', ts: Date.now() }));
check('a fresh remembered pick is used', vl.currentLivePick() === 'gemini-3.1-flash-live-preview',
      String(vl.currentLivePick()));
// ...but must expire, or a model Google enables later is shadowed forever.
store.set('mia-live-model-pick', JSON.stringify({ model: 'gemini-3.1-flash-live-preview', ts: Date.now() - 25 * 3600 * 1000 }));
check('a pick older than a day is discarded so the top is re-probed',
      vl.currentLivePick() === null, String(vl.currentLivePick()));
// A retired or renamed id must not pin the chain to something that no longer exists.
store.set('mia-live-model-pick', JSON.stringify({ model: 'gemini-1.0-retired', ts: Date.now() }));
check('a pick that left the catalog is ignored', vl.currentLivePick() === null, String(vl.currentLivePick()));
store.set('mia-live-model-pick', 'not json at all');
check('a corrupt pick does not throw', vl.currentLivePick() === null);

console.log();
const ok = FAIL.length === 0;
console.log(`${ok ? 'GEMINI ROSTER CHECK PASS' : 'GEMINI ROSTER CHECK FAIL'}: ${PASS.length} passed, ${FAIL.length} failed`);
if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=gemini_roster::${FAIL.slice(0, 6).join('; ')}`);
process.exitCode = ok ? 0 : 1;
