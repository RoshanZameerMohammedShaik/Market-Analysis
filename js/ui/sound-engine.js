// The app's sound engine: one AudioContext, one quiet mix, a handful of instruments.
//
// Rebuilt 2026-10-14 (Roshan: "app sounds are sounding like shit, make all sounds sound premium
// and make sense where and when they sound"). The old cues were sine "blips" whose pitch slid
// down on every note, which is what made them sound like toy beeps, and each module ran its own
// AudioContext at its own loudness. Now:
//
//   ONE context and ONE mix bus, with a gentle limiter so stacked cues can never clip, a soft
//   high cut for warmth, and a small synthetic room (a convolver fed a generated decaying-noise
//   impulse), so every sound sits in the same space.
//
//   FOUR instruments, none of them pitch-bending:
//     bell   FM glass bell: a sine carrier with a modulator whose depth decays, so the strike is
//            bright and the tail is pure. The chimes.
//     pluck  a soft marimba: a few partials with the upper ones dying fast. Lighter accents.
//     tap    a tiny tactile tick: a 10 ms filtered noise grain plus a low body. Tabs, toggles,
//            Mia pressing a button.
//     air    a filtered-noise breath that sweeps up or down. Panels opening and closing.
//
//   ONE key: every pitched note comes from D major pentatonic, so any two cues that overlap
//   still agree with each other.
//
// No samples are shipped: everything is synthesized here, in keeping with the dynamic-only rule.
// Callers own the gates (mute settings, Mia speaking, tab hidden); this module only makes sound.

let ctx = null;
let bus = null;        // instruments connect here (dry)
let send = null;       // and here (reverb send)
let noiseBuf = null;

export const NOTE = {
    D3: 146.83, A3: 220.0, D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440.0, B4: 493.88,
    D5: 587.33, E5: 659.25, Fs5: 739.99, A5: 880.0, B5: 987.77, D6: 1174.66, E6: 1318.51, Fs6: 1479.98,
};

function impulse(c, seconds = 1.8, decay = 3.4) {
    const rate = c.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let prev = 0;
        for (let i = 0; i < len; i++) {
            // Smoothed noise (a one-pole low-pass) so the room is warm rather than hissy.
            const n = Math.random() * 2 - 1;
            prev = prev + 0.35 * (n - prev);
            d[i] = prev * Math.pow(1 - i / len, decay);
        }
    }
    return buf;
}

// resume() returns a promise that rejects when the browser refuses (no user gesture yet), so the
// rejection is caught here instead of surfacing as an unhandled error.
function wake() {
    if (ctx && ctx.state === 'suspended') {
        try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
}

/** The shared context, created on first use (autoplay rules: after a user gesture). */
export function audio() {
    if (ctx) { wake(); return ctx; }
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return null;
    try {
        ctx = new AC();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -16;
        limiter.knee.value = 10;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.2;
        const warm = ctx.createBiquadFilter();
        warm.type = 'lowpass';
        warm.frequency.value = 8500;
        warm.Q.value = 0.4;
        const master = ctx.createGain();
        master.gain.value = 0.85;
        bus = ctx.createGain();
        bus.connect(warm);
        warm.connect(limiter);
        const room = ctx.createConvolver();
        room.buffer = impulse(ctx);
        const wet = ctx.createGain();
        wet.gain.value = 0.32;
        send = ctx.createGain();
        send.connect(room);
        room.connect(wet);
        wet.connect(limiter);
        limiter.connect(master);
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    } catch (_) { ctx = null; return null; }
    wake();
    return ctx;
}

export function now() { return ctx ? ctx.currentTime + 0.005 : 0; }

/** An output stage for one voice: level into the dry bus, `wet` of it into the room. */
function out(level, wet) {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(bus);
    if (wet > 0) {
        const s = ctx.createGain();
        s.gain.value = wet;
        g.connect(s);
        s.connect(send);
    }
    return g;
}

/** FM glass bell. f in Hz, t absolute time. */
export function bell(f, t, { gain = 0.2, dur = 1.1, ratio = 3.5, index = 1.8, wet = 0.3 } = {}) {
    if (!ctx) return;
    const o = out(1, wet);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(o);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.setValueAtTime(f, t);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(f * ratio, t);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * index, t);
    depth.gain.exponentialRampToValueAtTime(Math.max(1, f * index * 0.04), t + Math.min(0.35, dur * 0.4));
    mod.connect(depth);
    depth.connect(car.frequency);
    car.connect(env);
    // A faint octave above, slightly detuned, for the shimmer of real glass.
    const sh = ctx.createOscillator();
    sh.type = 'sine';
    sh.frequency.setValueAtTime(f * 2.004, t);
    const shg = ctx.createGain();
    shg.gain.setValueAtTime(0.0001, t);
    shg.gain.linearRampToValueAtTime(gain * 0.12, t + 0.006);
    shg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.55);
    sh.connect(shg);
    shg.connect(o);
    const end = t + dur + 0.05;
    car.start(t); mod.start(t); sh.start(t);
    car.stop(end); mod.stop(end); sh.stop(end);
}

/** Soft marimba pluck. */
export function pluck(f, t, { gain = 0.18, dur = 0.55, wet = 0.2, bright = 6 } = {}) {
    if (!ctx) return;
    const o = out(1, wet);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * bright), t);
    lp.Q.value = 0.3;
    lp.connect(o);
    for (const [mult, level, life] of [[1, 1, 1], [3.93, 0.22, 0.22], [9.8, 0.05, 0.08]]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f * mult, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain * level, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * life);
        osc.connect(g);
        g.connect(lp);
        osc.start(t);
        osc.stop(t + dur * life + 0.05);
    }
}

/** A tiny tactile tick: a filtered noise grain over a low body. */
export function tap(t, { gain = 0.1, freq = 2600, body = 160 } = {}) {
    if (!ctx || !noiseBuf) return;
    const o = out(1, 0.04);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, t);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    src.connect(bp); bp.connect(g); g.connect(o);
    src.start(t, Math.random() * 0.5, 0.03);
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.setValueAtTime(body, t);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(gain * 0.9, t + 0.002);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    b.connect(bg); bg.connect(o);
    b.start(t); b.stop(t + 0.05);
}

/** A soft breath of air that rises (opening) or falls (closing). */
export function air(t, { up = true, gain = 0.05, dur = 0.24, wet = 0.15 } = {}) {
    if (!ctx || !noiseBuf) return;
    const o = out(1, wet);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(up ? 700 : 2600, t);
    bp.frequency.exponentialRampToValueAtTime(up ? 2600 : 700, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(o);
    src.start(t, Math.random() * 0.4, dur + 0.05);
}

/** A slow, warm swell of soft sines (Mia waking up). */
export function pad(freqs, t, { gain = 0.07, attack = 0.25, dur = 0.9, wet = 0.4 } = {}) {
    if (!ctx) return;
    const o = out(1, wet);
    for (const [i, f] of freqs.entries()) {
        for (const det of [-4, 4]) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            osc.detune.setValueAtTime(det, t);
            const g = ctx.createGain();
            const start = t + i * 0.08;
            g.gain.setValueAtTime(0.0001, start);
            g.gain.linearRampToValueAtTime(gain / 2, start + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
            osc.connect(g); g.connect(o);
            osc.start(start); osc.stop(start + dur + 0.05);
        }
    }
}
