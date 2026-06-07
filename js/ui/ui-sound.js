// General UI sound layer — soft synthesized cues across the whole app
// (hover, click/tap, tab switch, panel open/close, toggle, success, error).
//
// Built entirely with the Web Audio API: every sound is oscillators +
// envelopes through a low-pass filter, so it stays free, dependency-free, and
// in keeping with the dynamic-only rule (nothing pre-recorded shipped). The
// character matches Mia's "soft organic bubble" palette (js/mia/sound.js) so
// the app has ONE coherent sonic identity — these are just the non-voice,
// interaction-driven counterparts.
//
// HARD GATES (all must pass for any sound to play):
//   1. uiSoundEnabled (settings, default ON, persisted) — the mute.
//   2. NOT Mia-speaking — shares mia/sound.js's speaking gate via
//      isMiaSpeaking(), so UI cues never talk over her voice.
//   3. prefers-reduced-motion: reduce → we honour it as "reduce non-essential
//      feedback" and stay silent (motion-sensitive users often want quiet too).
//
// Autoplay policy: the AudioContext can't start until a user gesture. Every
// trigger here is gesture-driven (click/tap/hover-after-interaction), so
// ensure() lazily creates + resumes the context on first real use.
//
// Volume is intentionally very low and cues are very short — ambient texture,
// never a soundboard. Hover is throttled so sweeping the mouse doesn't machine-gun.

import { loadSettings, saveSettings } from '../mia/settings.js';
import { isMiaSpeaking } from '../mia/sound.js';

let ctx = null;
let masterGain = null;
const MASTER_VOLUME = 0.32;   // bumped from 0.14 — cues were too quiet to hear

// ── enable/mute (persisted, per-category) ────────────────────────────────
// Categories: 'click' | 'hover' | 'notify'. Each maps to a settings flag.
// The master `soundAllOff` silences every synthesized cue (UI + Mia actions)
// except Mia's voice. `uiSoundEnabled` (legacy) is honoured as an extra gate
// so an old "UI sounds off" state keeps working.
const CATEGORY_FLAG = { click: 'soundClick', hover: 'soundHover', notify: 'soundNotify' };

export function isUiSoundEnabled() {
    const s = loadSettings();
    return s.soundAllOff !== true && s.uiSoundEnabled !== false;
}
function categoryEnabled(category) {
    const s = loadSettings();
    if (s.soundAllOff === true) return false;
    if (s.uiSoundEnabled === false) return false;
    const flag = CATEGORY_FLAG[category];
    return !flag || s[flag] !== false;   // default ON per category
}

export function setUiSoundEnabled(on) {
    saveSettings({ uiSoundEnabled: !!on });
    applyMasterGain();
    return on;
}

// Per-category getters/setters for the Settings → Sounds submenu.
export function getSoundSettings() {
    const s = loadSettings();
    return {
        click: s.soundClick !== false,
        hover: s.soundHover !== false,
        notify: s.soundNotify !== false,
        miaActions: s.soundEnabled !== false,   // Mia's action sounds (mia/sound.js reads this)
        allOff: s.soundAllOff === true,
    };
}
export function setSoundCategory(category, on) {
    const key = { click: 'soundClick', hover: 'soundHover', notify: 'soundNotify' }[category];
    if (!key) return;
    saveSettings({ [key]: !!on });
    applyMasterGain();
}
export function setSoundAllOff(off) {
    saveSettings({ soundAllOff: !!off });
    applyMasterGain();
    return off;
}
function applyMasterGain() {
    if (!masterGain || !ctx) return;
    const on = isUiSoundEnabled();
    try { masterGain.gain.setValueAtTime(on ? MASTER_VOLUME : 0, ctx.currentTime); } catch (_) {}
}

// ── audio graph ───────────────────────────────────────────────────────────

function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

function ensure() {
    if (!isUiSoundEnabled()) return false;
    if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try {
            ctx = new AC();
            masterGain = ctx.createGain();
            masterGain.gain.value = MASTER_VOLUME;
            masterGain.connect(ctx.destination);
        } catch (_) { ctx = null; return false; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    return true;
}

// `category` is 'click' | 'hover' | 'notify' (defaults to 'click'). The cue
// only plays if that category is enabled, Mia isn't speaking, motion isn't
// reduced, the TAB IS VISIBLE, and the audio context is live. The
// document.hidden gate stops background cues — the watchlist poller fires
// notify() on signal flips every few minutes, which was playing sound while
// the app sat in the background (the "random sound" the user heard).
function canEmit(category = 'click') {
    if (typeof document !== 'undefined' && document.hidden) return false;
    return categoryEnabled(category) && !isMiaSpeaking() && !prefersReducedMotion() && ensure();
}

// One soft blip: sine through a low-pass on a quick rounded envelope.
function blip(freq, t0, peak = 0.5, dur = 0.12, glideTo = null) {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, glideTo || freq * 0.9), t0 + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(2400, freq * 3), t0);
    lp.Q.value = 0.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(lp); lp.connect(g); g.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
}

function now() { return ctx ? ctx.currentTime : 0; }

// ── public triggers ─────────────────────────────────────────────────────
// Each is a no-op when gated, so call sites never need to guard.

// Featherweight hover tick — throttled so a mouse sweep doesn't stutter.
let _lastHover = 0;
export function hover() {
    if (!canEmit('hover')) return;
    const t = (ctx.currentTime * 1000);
    if (t - _lastHover < 60) return;   // throttle: max ~16/s
    _lastHover = t;
    blip(720 + Math.random() * 40, now() + 0.001, 0.16, 0.07);
}

// Click / tap — a deliberate two-layer "tock": a low thud + a short mid body,
// distinctly weightier and LOWER than the light, airy hover tick (720Hz) so
// press vs. hover are unmistakable across the app.
export function click() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(190 + Math.random() * 16, t, 0.40, 0.13, 150);   // low thud, glides down
    blip(430 + Math.random() * 30, t, 0.30, 0.09);        // crisp mid body
}

// Brighter two-note rise for a tab / view switch.
export function tab() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(480, t, 0.34, 0.10);
    blip(680, t + 0.06, 0.34, 0.12);
}

// Panel / drawer open — gentle upward swell.
export function open() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(380, t, 0.30, 0.14, 600);
    blip(560, t + 0.07, 0.30, 0.16, 760);
}

// Panel / drawer close — gentle downward settle.
export function close() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(560, t, 0.28, 0.14, 420);
    blip(360, t + 0.07, 0.26, 0.16, 280);
}

// Toggle flip — single crisp mid tick.
export function toggle() {
    if (!canEmit()) return;
    blip(620, now() + 0.001, 0.30, 0.09);
}

// Success — warm rising major third+fifth (lighter than Mia's full triad).
export function success() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(523, t, 0.38, 0.14);          // C5
    blip(659, t + 0.09, 0.38, 0.16);   // E5
    blip(784, t + 0.18, 0.40, 0.24);   // G5
}

// Error — soft low minor two-tone (a gentle "nope", never harsh).
export function error() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(330, t, 0.40, 0.18, 300);
    blip(247, t + 0.12, 0.40, 0.24, 220);
}

// ── "Signal landed" — distinct chord per call direction, fired once per
// analysis when the signal card renders. Punchier than success() so a real
// prediction reads as more momentous than a form-validation tick.

// BUY — rising A4→D5→G5, clean held tones (confident, ascending).
export function signalLandedBuy() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(440, t, 0.34, 0.11);
    blip(587, t + 0.10, 0.34, 0.14);
    blip(784, t + 0.22, 0.38, 0.18);
}
// SELL — descending E5→A4→E4, each sliding down (cautious, settling).
export function signalLandedSell() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(659, t, 0.36, 0.12, 587);
    blip(440, t + 0.11, 0.34, 0.14, 392);
    blip(330, t + 0.24, 0.36, 0.18, 293);
}
// NEUTRAL / NO_TRADE — two equal C5 tones, no pitch motion ("wait and see").
export function signalLandedNeutral() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(523, t, 0.26, 0.20);
    blip(523, t + 0.08, 0.26, 0.22);
}
// One dispatcher so callers make a single call by signal string.
export function signalLanded(signal) {
    if (signal === 'BUY') signalLandedBuy();
    else if (signal === 'SELL') signalLandedSell();
    else signalLandedNeutral();   // NEUTRAL + NO_TRADE
}

// Featherweight "card arrived" chirp, trailing the hot-picks entrance cascade.
// Caller passes the card index; hard-capped at the first 5 so a 100-card grid
// never machine-guns. Pitch rises across the volley. Peak kept at 0.14 so the
// 5-chirp volley + the success() chord can't sum to clipping at MASTER_VOLUME.
export function cardArrival(i = 0) {
    if (!canEmit('notify')) return;
    if (i > 4) return;
    blip(660 + i * 28, now() + 0.001, 0.14, 0.07);
}

// Generic notification ping — a soft two-note rise for an info-kind toast
// (success/error have their own cues). Notify category.
export function notification() {
    if (!canEmit('notify')) return;
    const t = now() + 0.001;
    blip(620, t, 0.34, 0.12);
    blip(880, t + 0.08, 0.34, 0.16);
}

// ── delegated auto-wiring ─────────────────────────────────────────────────
// One set of document-level listeners drives most cues from a CSS allow-list,
// so individual modules don't each have to import and call these. Modules can
// still call the named triggers directly for semantic events (success/error).

const CLICK_SEL = '.tab-btn, .refresh-btn, .spikers-btn, .pl-btn, .penny-filter-btn, ' +
    '.header-btn, .header-menu-item, .portfolio-launcher, .mia-launcher, .hot-pick-card, ' +
    '.sp-bucket, .engine-signals-toggle, .watch-toggle, .scanner-row, .sector-tile, ' +
    '.earnings-cal-row, .options-scan-row, .resources-toggle, .time-travel-btn, ' +
    '.scanner-summary, .sector-heatmap-summary, .earnings-cal-summary, .options-scan-summary, ' +
    '.equity-curve-summary, .accuracy-report-summary, .mia-sound-pill';

const HOVER_SEL = '.tab-btn, .hot-pick-card, .header-btn, .penny-filter-btn, ' +
    '.refresh-btn, .spikers-btn, .portfolio-launcher, .sp-bucket, .sector-tile, ' +
    '.header-menu-item, .mia-sound-pill, .resources-toggle, .scanner-summary, ' +
    '.sector-heatmap-summary, .earnings-cal-summary, .options-scan-summary, ' +
    '.equity-curve-summary, .accuracy-report-summary';

const TAB_SEL = '.tab-btn, .penny-filter-btn, .sp-bucket';

let _wired = false;
export function initUiSound() {
    if (_wired) return;
    _wired = true;

    // Pre-warm the AudioContext on the VERY FIRST user gesture anywhere, so it's
    // already 'running' by the time the user clicks a button. Without this, the
    // first click(s) pay the context-resume latency and the sound lands late —
    // the "delay between click and sound" the user noticed. ensure() creates +
    // resumes; we just call it early on the first pointerdown (capture phase, so
    // it runs before the click cue below). One-shot via { once: true }.
    document.addEventListener('pointerdown', () => { try { ensure(); } catch (_) {} },
        { passive: true, capture: true, once: true });

    document.addEventListener('pointerdown', (e) => {
        const el = e.target instanceof Element ? e.target.closest(CLICK_SEL) : null;
        if (!el) return;
        // Tab-like controls get the brighter rising cue; everything else the
        // soft click. Keeps switching views feeling distinct from pressing.
        if (el.closest(TAB_SEL)) tab();
        else click();
    }, { passive: true, capture: true });

    // Hover cue — ONCE per item entered, not per descendant. pointerover
    // bubbles from every child node, so naively calling hover() on each event
    // machine-guns ("tup tup tup") as the cursor crosses a card's inner
    // elements. We track the allow-list element the pointer is currently
    // "inside" and only fire when it CHANGES — true pointerenter semantics via
    // delegation (one cue per card/button, regardless of how many children it
    // has). Cleared on pointerout when leaving the element entirely.
    let _hoveredItem = null;
    document.addEventListener('pointerover', (e) => {
        const el = e.target instanceof Element ? e.target.closest(HOVER_SEL) : null;
        if (el === _hoveredItem) return;   // still inside the same item → silent
        _hoveredItem = el;
        if (el) hover();                   // newly entered a different item → one cue
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
        // When the pointer truly leaves the current item (relatedTarget is
        // outside it), drop the reference so re-entering fires a fresh cue.
        if (!_hoveredItem) return;
        const to = e.relatedTarget;
        if (!to || !(to instanceof Node) || !_hoveredItem.contains(to)) _hoveredItem = null;
    }, { passive: true });
}
