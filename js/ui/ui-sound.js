// The app's interface sounds, played through the shared engine (js/ui/sound-engine.js).
//
// WHEN A SOUND PLAYS (2026-10-14, Roshan: "make all sounds sound premium and make sense where and
// when they sound", and "remove sounds that sound when hovering"):
//
//   the analysis lands     one chime, shaped by the call on the card: rising for BUY or HOLD on
//                          a measured rise, falling for SELL or a DON'T BUY on a measured fall, one
//                          soft note when nothing is measured. Once per symbol and call.
//   switching a tab        a tiny tactile tick, like a good keyboard.
//   flipping a toggle      the same tick, a shade lower.
//   a panel opens/closes   a breath of air (with a faint bell on open).
//   success / error toast  a short bright arpeggio / a soft low pair, never harsh.
//   a notification         one clear bell.
//   Hot Picks finish       one quiet shimmer for the whole grid.
//
// Never: hovering anything, pressing an ordinary button or row, every card arriving.
//
// HARD GATES (every one must pass): the user's sound settings, Mia not speaking (her voice is
// never talked over), prefers-reduced-motion not set, and the tab visible (a background poll
// once played sounds into an idle tab).

import { loadSettings, saveSettings } from '../mia/settings.js';
import { isMiaSpeaking } from '../mia/sound.js';
import { audio, now, bell, pluck, tap, air, NOTE } from './sound-engine.js';

// ── enable/mute (persisted, per category) ─────────────────────────────────
// Categories: 'click' (tabs, toggles) and 'notify' (chimes, toasts). `soundAllOff` silences every
// synthesized cue (UI and Mia's actions) but never Mia's voice. `uiSoundEnabled` (legacy) still
// works as an extra off switch.
const CATEGORY_FLAG = { click: 'soundClick', notify: 'soundNotify' };

export function isUiSoundEnabled() {
    const s = loadSettings();
    return s.soundAllOff !== true && s.uiSoundEnabled !== false;
}
function categoryEnabled(category) {
    const s = loadSettings();
    if (s.soundAllOff === true || s.uiSoundEnabled === false) return false;
    const flag = CATEGORY_FLAG[category];
    return !flag || s[flag] !== false;
}
export function setUiSoundEnabled(on) {
    saveSettings({ uiSoundEnabled: !!on });
    return on;
}
export function getSoundSettings() {
    const s = loadSettings();
    return {
        click: s.soundClick !== false,
        notify: s.soundNotify !== false,
        miaActions: s.soundEnabled !== false,
        allOff: s.soundAllOff === true,
    };
}
export function setSoundCategory(category, on) {
    const key = CATEGORY_FLAG[category];
    if (key) saveSettings({ [key]: !!on });
}
export function setSoundAllOff(off) {
    saveSettings({ soundAllOff: !!off });
    return off;
}

function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

function canEmit(category = 'click') {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (!categoryEnabled(category) || isMiaSpeaking() || prefersReducedMotion()) return false;
    return !!audio();
}

// ── cues ──────────────────────────────────────────────────────────────────
// Each is a no-op when gated, so call sites never need to guard.

/** Hover is silent, always. Kept so old imports keep working. */
export function hover() {}

/** A deliberate press where one is wanted (the sound settings use it to confirm). */
export function click() {
    if (!canEmit()) return;
    tap(now(), { gain: 0.15, freq: 2400 });
}

/** Switching a tab or a filter. */
export function tab() {
    if (!canEmit()) return;
    tap(now(), { gain: 0.14, freq: 3000, body: 170 });
}

/** Flipping a toggle. */
export function toggle() {
    if (!canEmit()) return;
    tap(now(), { gain: 0.14, freq: 2000, body: 140 });
}

/** A panel or drawer opening. */
export function open() {
    if (!canEmit()) return;
    const t = now();
    air(t, { up: true });
    bell(NOTE.A5, t + 0.08, { gain: 0.05, dur: 0.7, index: 1.1 });
}

/** A panel or drawer closing. */
export function close() {
    if (!canEmit()) return;
    air(now(), { up: false, gain: 0.04 });
}

/** Something worked: a short bright arpeggio. */
export function success() {
    if (!canEmit('notify')) return;
    const t = now();
    bell(NOTE.D5, t, { gain: 0.13, dur: 0.9 });
    bell(NOTE.Fs5, t + 0.07, { gain: 0.12, dur: 0.95 });
    bell(NOTE.A5, t + 0.14, { gain: 0.13, dur: 1.2 });
}

/** Something failed: a soft low pair, never a buzzer. */
export function error() {
    if (!canEmit('notify')) return;
    const t = now();
    pluck(NOTE.E4, t, { gain: 0.16, dur: 0.45, bright: 3 });
    pluck(NOTE.D4, t + 0.13, { gain: 0.15, dur: 0.6, bright: 3 });
}

/** A notification: one clear bell. */
export function notification() {
    if (!canEmit('notify')) return;
    const t = now();
    bell(NOTE.B5, t, { gain: 0.14, dur: 1.4, index: 1.5 });
    bell(NOTE.Fs5, t + 0.09, { gain: 0.07, dur: 1.1, index: 1.2 });
}

// ── the analysis lands ───────────────────────────────────────────────────
// Shaped by the call the card actually shows (js/ui/forecast-cards.js data-tone), never by the
// engine's raw coin-flip signal, and played once per symbol and call, not on every re-render.
let _lastLanded = '';

/** tone: 'up' | 'down' | 'flat' (also accepts the old BUY / SELL / NEUTRAL strings). */
export function signalLanded(tone, key = '') {
    const tn = tone === 'BUY' ? 'up' : tone === 'SELL' ? 'down' : (tone === 'up' || tone === 'down') ? tone : 'flat';
    const id = `${key}|${tn}`;
    if (key && id === _lastLanded) return;
    _lastLanded = id;
    if (!canEmit('notify')) return;
    const t = now();
    if (tn === 'up') {
        bell(NOTE.D5, t, { gain: 0.12, dur: 1.0 });
        bell(NOTE.A5, t + 0.1, { gain: 0.13, dur: 1.3 });
        bell(NOTE.D6, t + 0.2, { gain: 0.06, dur: 1.4, index: 1.2 });
    } else if (tn === 'down') {
        bell(NOTE.A5, t, { gain: 0.11, dur: 1.0 });
        bell(NOTE.E5, t + 0.12, { gain: 0.12, dur: 1.3 });
    } else {
        pluck(NOTE.Fs5, t, { gain: 0.11, dur: 0.7, wet: 0.3 });
    }
}
export function signalLandedBuy() { signalLanded('up'); }
export function signalLandedSell() { signalLanded('down'); }
export function signalLandedNeutral() { signalLanded('flat'); }

/** Hot Picks finished loading: one quiet shimmer for the grid, not a chirp per card. */
export function gridReady() {
    if (!canEmit('notify')) return;
    const t = now();
    bell(NOTE.Fs6, t, { gain: 0.04, dur: 0.8, index: 1.0 });
    bell(NOTE.D6, t + 0.05, { gain: 0.045, dur: 0.9, index: 1.0 });
    bell(NOTE.A5, t + 0.1, { gain: 0.05, dur: 1.1, index: 1.0 });
}
/** Old per-card chirp, retired: the first call plays the grid shimmer, the rest are silent. */
export function cardArrival(i = 0) { if (i === 0) gridReady(); }

// ── wiring ────────────────────────────────────────────────────────────────
// Only tabs and toggles make a sound on press. Nothing makes a sound on hover.
const TAB_SEL = '.tab-btn, .penny-filter-btn, .sp-bucket';
const TOGGLE_SEL = '.theme-toggle, .watch-toggle, [role="switch"]';

let _wired = false;
export function initUiSound() {
    if (_wired) return;
    _wired = true;
    // Warm the context on the first gesture anywhere, so the first real cue is not late.
    document.addEventListener('pointerdown', () => { try { if (isUiSoundEnabled()) audio(); } catch (_) {} },
        { passive: true, capture: true, once: true });
    document.addEventListener('pointerdown', (e) => {
        const el = e.target instanceof Element ? e.target : null;
        if (!el) return;
        if (el.closest(TAB_SEL)) tab();
        else if (el.closest(TOGGLE_SEL)) toggle();
    }, { passive: true, capture: true });
}
