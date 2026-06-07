// Mia's voice-mode sound design — synthesized entirely in the browser
// with the Web Audio API. No sample files: every sound is built from
// oscillators + envelopes, so it stays free, dependency-free, and in
// keeping with the dynamic-only rule (nothing pre-recorded shipped).
//
// Character (Roshan's pick): "soft organic bubbles" — rounded sine
// blips, low-pass filtered, with a gentle random pitch wobble. The
// ChatGPT-voice-mode "dubudbudbud" thinking feel.
//
// Sounds:
//   - THINKING loop: soft randomized blips while Mia generates / runs
//     tools (text path AND voice path between utterances).
//   - TICK: one soft muted pop when Mia performs a tool action
//     (presses a button, finishes typing a field).
//   - LISTENING on/off: a short two-note cue when voice starts/stops
//     listening.
//
// HARD GATES (both must pass for any sound to play):
//   1. soundEnabled (Mia settings, default ON, persisted) — the mute.
//   2. NOT speaking — while Mia's TTS / Live voice is actually playing
//      audio, we stay silent so we never talk over her. Sounds resume
//      between utterances (thinking, ticks, listening all still fire
//      during voice mode — just not while she's mid-sentence).
//
// Browser autoplay policy: the AudioContext can't start until a user
// gesture. Mia is always invoked by a click, so ensure() lazily creates
// + resumes the context on the first sound request after any gesture.

import { loadSettings, saveSettings } from './settings.js';

let ctx = null;          // shared AudioContext
let masterGain = null;   // master volume / hard-mute node
let speaking = false;    // TTS/Live voice currently playing → suppress
let thinkingHandle = null; // { stop() } for the active thinking loop

const MASTER_VOLUME = 0.30;   // bumped from 0.18 — action sounds were too quiet to notice

// ── enable/mute state (persisted in Mia settings) ────────────────────

export function isSoundEnabled() {
    // Default ON. settings.soundEnabled is undefined on stores written
    // before this feature → treat undefined as true. The master soundAllOff
    // (Settings → Sounds → "Turn off all sounds") silences Mia's ACTION sounds
    // too — but NOT her voice/responses, which never read this flag.
    const s = loadSettings();
    if (s.soundAllOff === true) return false;
    return s.soundEnabled !== false;
}

export function setSoundEnabled(on) {
    saveSettings({ soundEnabled: !!on });
    if (!on) {
        // Killing the toggle should immediately silence any loop.
        stopThinking();
        if (masterGain) {
            try { masterGain.gain.cancelScheduledValues(now()); masterGain.gain.setValueAtTime(0, now()); } catch (_) {}
        }
    } else if (masterGain) {
        try { masterGain.gain.setValueAtTime(MASTER_VOLUME, now()); } catch (_) {}
    }
    return on;
}

// Called by the voice layer so we know when Mia's actual voice is
// playing. While true, every sound is suppressed; a running thinking
// loop is paused (its blips just don't emit) and resumes when she
// stops. We DON'T tear the loop down here — the generation lifecycle
// owns start/stop; this only gates emission.
export function setSpeaking(isSpeaking) {
    speaking = !!isSpeaking;
}

// Read-only view of the speaking gate so the general UI sound layer
// (js/ui/ui-sound.js) can share the SAME "never talk over Mia" suppression
// without duplicating the state. One source of truth for whether Mia's voice
// is mid-sentence.
export function isMiaSpeaking() { return speaking; }

// ── audio graph plumbing ─────────────────────────────────────────────

function now() { return ctx ? ctx.currentTime : 0; }

function ensure() {
    if (!isSoundEnabled()) return false;
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
    // Autoplay policy: context may start 'suspended' until a gesture.
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    return true;
}

// True only when it's OK to actually emit a sound right now. Also gated on tab
// visibility so Mia's action sounds never play while the app is backgrounded.
function canEmit() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    return isSoundEnabled() && !speaking && ensure();
}

// One soft "bubble" blip: a sine through a low-pass filter on a rounded
// attack/decay envelope. A quiet detuned sine partial is layered in for
// warmth so it reads as an organic "boop", not a flat console beep.
// freq in Hz; t0 absolute start time; gain peak; dur seconds.
function blip(freq, t0, peak = 0.6, dur = 0.16) {
    if (!ctx) return;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(1800, freq * 3), t0);
    // A gentle downward filter sweep rounds the tail so it "closes" softly
    // instead of holding a bright edge — much less "beepy".
    lp.frequency.exponentialRampToValueAtTime(Math.max(180, freq * 1.4), t0 + dur);
    lp.Q.value = 0.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.026);     // softer attack
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);     // smooth tail
    g.connect(masterGain);
    lp.connect(g);

    // Fundamental + a quiet partial a touch detuned for body/warmth.
    const mk = (mult, detune, level, type = 'sine') => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq * mult, t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * mult * 0.84), t0 + dur);
        if (detune) osc.detune.setValueAtTime(detune, t0);
        const og = ctx.createGain();
        og.gain.value = level;
        osc.connect(og); og.connect(lp);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
    };
    mk(1, 0, 1.0);          // fundamental
    mk(2.003, 4, 0.12);     // faint shimmering octave for warmth
}

// ── public sound triggers ────────────────────────────────────────────

// Soft muted pop for a discrete tool action (button press / field fill).
export function tick() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    // Two stacked partials, low + a quiet octave, very short — reads as
    // a rounded "bup" rather than a click.
    blip(560 + Math.random() * 60, t, 0.5, 0.12);
    blip(280 + Math.random() * 30, t, 0.28, 0.14);
}

// Soft three-note rising "done" chime — fires when an answer finishes or
// a key result lands (P&L total, equity curve). A gentle resolve, not a
// fanfare: warm rounded blips up a major triad. Gated like everything else.
export function complete() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(523, t, 0.42, 0.16);          // C5
    blip(659, t + 0.10, 0.42, 0.18);   // E5
    blip(784, t + 0.20, 0.46, 0.30);   // G5 — slightly longer tail to "settle"
}

// Soft "powering up" cue when voice mode begins connecting — a warm,
// slow upward swell of two overlapping low blips (think a device gently
// waking, not a dial tone). Replaces the abrupt thinking-loop start the
// user found "weird and shitty" at connect time. Short + low so it sits
// under the orb's visual swell rather than announcing itself.
export function connecting() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(196, t, 0.34, 0.34);          // G3 — low warm root, long soft tail
    blip(294, t + 0.14, 0.30, 0.32);   // D4 — a fifth above, overlapping rise
}

// Gentle two-note "ready" resolve once the connection is live and Mia is
// actually listening — a soft confirmation the link is up.
export function connected() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(392, t, 0.40, 0.16);          // G4
    blip(587, t + 0.10, 0.42, 0.22);   // D5 — clean upward resolve
}

// Two-note rising cue when voice starts listening; falling when it stops.
export function listeningOn() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(440, t, 0.5, 0.14);
    blip(620, t + 0.11, 0.5, 0.16);
}
export function listeningOff() {
    if (!canEmit()) return;
    const t = now() + 0.001;
    blip(540, t, 0.45, 0.14);
    blip(380, t + 0.11, 0.45, 0.16);
}

// Start the looping "dubudbudbud" thinking shimmer. Schedules a short
// run of randomized blips, then re-arms via setTimeout so the loop can
// be cancelled cleanly. Each tick re-checks canEmit(), so the loop goes
// silent the instant Mia starts speaking or the user mutes — without
// being torn down (it resumes between utterances). Idempotent: calling
// it while already running is a no-op.
export function startThinking() {
    if (thinkingHandle) return;
    let cancelled = false;
    let timer = null;

    // The pentatonic-ish set keeps the random blips musical, never sour.
    const NOTES = [330, 392, 440, 494, 587];

    const scheduleBurst = () => {
        if (cancelled) return;
        // Re-check gates each cycle. If we currently can't emit (muted or
        // speaking) we still keep the loop alive and just skip this burst,
        // so it picks back up the moment the gate clears.
        if (canEmit()) {
            const t = now();
            // 2–4 soft blips per burst at slightly random spacing →
            // the irregular "dubud-bud-bud" cadence.
            const count = 2 + Math.floor(Math.random() * 3);
            let offset = 0;
            for (let i = 0; i < count; i++) {
                const note = NOTES[Math.floor(Math.random() * NOTES.length)];
                blip(note * (0.98 + Math.random() * 0.04), t + offset, 0.32, 0.13);
                offset += 0.085 + Math.random() * 0.06;
            }
        }
        // Re-arm with a gap so bursts feel like considered "thoughts".
        const gap = 420 + Math.random() * 360;
        timer = setTimeout(scheduleBurst, gap);
    };

    // Kick off shortly so it doesn't collide with the click that started it.
    timer = setTimeout(scheduleBurst, 120);
    thinkingHandle = {
        stop() {
            cancelled = true;
            if (timer) { clearTimeout(timer); timer = null; }
        },
    };
}

export function stopThinking() {
    if (thinkingHandle) {
        try { thinkingHandle.stop(); } catch (_) {}
        thinkingHandle = null;
    }
}

export function isThinking() { return !!thinkingHandle; }
