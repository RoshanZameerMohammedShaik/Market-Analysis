// Visible feedback when Mia drives the app. The chat-bubble tool-badge tells
// the user *what* she's doing; this module makes it visible on the page itself
// — pulsing the control she just touched and showing a brief toast — so the
// agentic action doesn't feel invisible when it happens behind/around the
// chat panel.

const PULSE_CLASS = 'mia-agent-pulse';
const PULSE_MS = 1100;

export function pulseElement(el) {
    if (!el || !el.classList) return;
    el.classList.remove(PULSE_CLASS);
    void el.offsetWidth;
    el.classList.add(PULSE_CLASS);
    setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS + 50);
}

export function pulseElementById(id) {
    const el = id ? document.getElementById(id) : null;
    if (el) pulseElement(el);
    return el;
}

export function pulseSelector(sel) {
    const el = sel ? document.querySelector(sel) : null;
    if (el) pulseElement(el);
    return el;
}

export function scrollIntoViewIfNeeded(el) {
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
    if (!inView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Now routes through the unified notification system (top-left,
// auto-drain green bar, pause-on-hover, pin-on-click). The old
// custom .mia-agent-toast element + timer are gone.
import { notifyInfo } from '../ui/notify.js';
let _lastHandle = null;
export function showAgentToast(text, ms = 5000) {
    if (!text) return;
    // Only one Mia agent toast on screen at a time — close the
    // previous one before opening the next so we don't stack
    // identical agent-step toasts.
    if (_lastHandle) _lastHandle.close();
    _lastHandle = notifyInfo(text, { autoCloseMs: ms });
}

export function announce({ text, target }) {
    if (text) showAgentToast(text);
    if (target) {
        const el = typeof target === 'string'
            ? (target.startsWith('#') ? document.querySelector(target) : document.getElementById(target))
            : target;
        if (el) {
            scrollIntoViewIfNeeded(el);
            pulseElement(el);
        }
    }
}

// ── Agentic-motion toolkit ───────────────────────────────────────────
// Shared helpers that make Mia's tool actions LOOK like she's doing
// them — performing each step at a visible, human-perceptible speed
// rather than mutating the DOM instantly. Used by the P&L agentic
// flow and (via runAgenticSteps) by other control tools.
//
// They also make her actions SOUND agentic: pressButton + the
// per-field completion in typeIntoInput emit a soft tick. The sound
// engine self-gates (mute + not-speaking), so we call it unconditionally
// and let sound.js decide whether to actually emit. Lazy dynamic import
// keeps agent-pulse free of a hard dependency on the audio layer.
let _sound = null;
function soundTick() {
    if (_sound) { try { _sound.tick(); } catch (_) {} return; }
    import('./sound.js').then(m => { _sound = m; try { m.tick(); } catch (_) {} }).catch(() => {});
}

const REDUCED_MOTION = (() => {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
})();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Type a value into an input character-by-character at a visible speed,
// firing `input` events so any listeners (validation, formatting) react
// as if a human typed it. Adds a `.mia-typing` class for a caret/glow
// cue. Resolves when the full value is entered. Honors reduced-motion
// by setting the value instantly.
export async function typeIntoInput(input, value, { perChar = 75, focus = true } = {}) {
    if (!input) return;
    const str = String(value);
    if (focus) { try { input.focus({ preventScroll: false }); } catch (_) {} }
    scrollIntoViewIfNeeded(input);
    if (REDUCED_MOTION) {
        input.value = str;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    input.classList.add('mia-typing');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < str.length; i++) {
        input.value = str.slice(0, i + 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Slight jitter so it reads as organic typing, not a metronome.
        await sleep(perChar + Math.round((Math.random() - 0.5) * 24));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.classList.remove('mia-typing');
    // Brief "field filled" flash so the user sees the value land.
    input.classList.add('mia-field-filled');
    setTimeout(() => input.classList.remove('mia-field-filled'), 650);
    // Soft pop as the field lands (not per-keystroke — that'd be maddening).
    soundTick();
}

// Visibly "press" a button: highlight it, pause so the user sees the
// intent, then click. Returns after the click fires.
export async function pressButton(btn, { preDelay = 350 } = {}) {
    if (!btn) return;
    scrollIntoViewIfNeeded(btn);
    btn.classList.add('mia-agent-target');
    if (!REDUCED_MOTION) await sleep(preDelay);
    pulseElement(btn);
    soundTick();
    btn.click();
    setTimeout(() => btn.classList.remove('mia-agent-target'), 900);
}

// Run an ordered list of { text, run } steps, announcing each with a
// toast and pausing between them so the sequence is legible as a
// deliberate agent workflow rather than an instant state jump.
export async function runAgenticSteps(steps, { gap = 500 } = {}) {
    for (const step of steps) {
        if (!step) continue;
        if (step.text) showAgentToast(step.text);
        if (typeof step.run === 'function') {
            // eslint-disable-next-line no-await-in-loop
            await step.run();
        }
        if (!REDUCED_MOTION) await sleep(gap);
    }
}
