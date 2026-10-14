// Mia's sounds, played through the app's shared engine (js/ui/sound-engine.js), so she and the
// rest of the app share one context, one mix and one key.
//
// Rebuilt 2026-10-14 with the rest of the app's sounds. What each one is now:
//   TICK        a tiny tactile tick when Mia presses a button or finishes typing a field.
//   COMPLETE    two soft bells when an answer lands.
//   CONNECTING  a slow warm swell as voice mode wakes up. CONNECTED: a two-bell "ready".
//   LISTENING   one light pluck when the mic opens, a lower one when it closes.
//   THINKING    sparse, quiet glass droplets from the same key while she works, one every second
//               or so: present enough to say "working", calm enough to ignore. (It was a busy
//               loop of sliding bubbles.)
//
// HARD GATES: Mia's sound setting (default on, persisted), never while her voice is speaking, and
// never while the tab is hidden.

import { loadSettings, saveSettings } from './settings.js';
import { audio, now, bell, pluck, tap, pad, NOTE } from '../ui/sound-engine.js';

let speaking = false;
let thinkingHandle = null;

export function isSoundEnabled() {
    // The master "turn off all sounds" silences Mia's ACTION sounds too, never her voice.
    const s = loadSettings();
    if (s.soundAllOff === true) return false;
    return s.soundEnabled !== false;
}

export function setSoundEnabled(on) {
    saveSettings({ soundEnabled: !!on });
    if (!on) stopThinking();
    return on;
}

// Set by the voice layer while Mia's actual voice is playing. Every cue stays silent meanwhile, and
// a running thinking loop just skips its droplets until she stops.
export function setSpeaking(isSpeaking) { speaking = !!isSpeaking; }

// Read by js/ui/ui-sound.js so the rest of the app never talks over her either.
export function isMiaSpeaking() { return speaking; }

function canEmit() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    return isSoundEnabled() && !speaking && !!audio();
}

export function tick() {
    if (!canEmit()) return;
    tap(now(), { gain: 0.12, freq: 1900, body: 150 });
}

export function complete() {
    if (!canEmit()) return;
    const t = now();
    bell(NOTE.A5, t, { gain: 0.1, dur: 1.0 });
    bell(NOTE.D6, t + 0.11, { gain: 0.09, dur: 1.3, index: 1.3 });
}

export function connecting() {
    if (!canEmit()) return;
    pad([NOTE.D4, NOTE.A4], now(), { gain: 0.07, attack: 0.3, dur: 1.0 });
}

export function connected() {
    if (!canEmit()) return;
    const t = now();
    bell(NOTE.D5, t, { gain: 0.1, dur: 0.9 });
    bell(NOTE.A5, t + 0.1, { gain: 0.11, dur: 1.2 });
}

export function listeningOn() {
    if (!canEmit()) return;
    pluck(NOTE.A5, now(), { gain: 0.1, dur: 0.5, wet: 0.25 });
}

export function listeningOff() {
    if (!canEmit()) return;
    pluck(NOTE.Fs5, now(), { gain: 0.08, dur: 0.5, wet: 0.25 });
}

// The thinking loop. Idempotent; each droplet re-checks the gates, so muting or Mia starting to
// speak silences it at once without tearing it down, and it resumes between utterances.
export function startThinking() {
    if (thinkingHandle) return;
    let cancelled = false;
    let timer = null;
    const DROPS = [NOTE.Fs5, NOTE.A5, NOTE.B5, NOTE.D6, NOTE.E6];
    let last = -1;
    const drop = () => {
        if (cancelled) return;
        if (canEmit()) {
            let i = Math.floor(Math.random() * DROPS.length);
            if (i === last) i = (i + 2) % DROPS.length;   // never the same note twice running
            last = i;
            bell(DROPS[i], now(), { gain: 0.035, dur: 0.9, index: 1.0, wet: 0.45 });
        }
        timer = setTimeout(drop, 900 + Math.random() * 700);
    };
    timer = setTimeout(drop, 250);
    thinkingHandle = { stop() { cancelled = true; if (timer) { clearTimeout(timer); timer = null; } } };
}

export function stopThinking() {
    if (thinkingHandle) {
        try { thinkingHandle.stop(); } catch (_) {}
        thinkingHandle = null;
    }
}

export function isThinking() { return !!thinkingHandle; }
