// motion.js — the app's GSAP-powered animation vocabulary.
//
// GSAP (now 100% free, incl. SplitText / DrawSVG / Flip / ScrollTrigger via
// Webflow) is loaded globally as UMD scripts in index.html BEFORE the module
// graph, so window.gsap and the plugins are already registered when this runs.
// This module is the single place the rest of the app reaches for motion, so:
//   • every animation is gated on prefers-reduced-motion in ONE place;
//   • every call NO-OPS SAFELY if GSAP failed to load (offline first paint,
//     blocked CDN copy, etc.) — callers never need to guard;
//   • we never reinvent eased tweens / number counters / SVG draws by hand.
//
// Nothing here changes layout or engine behaviour; it only animates existing
// elements. Use sparingly and tastefully — GSAP makes it easy to overdo it.

const G = typeof window !== 'undefined' ? window.gsap : null;

function reduce() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

// True only when it's safe + desirable to animate with GSAP right now.
export function canAnimate() {
    return !!G && !reduce();
}

export function gsap() { return G; }

// The app's shared easing identities (mirror premium.css tokens). Registered
// as named CustomEases when the plugin is present, with safe fallbacks.
let _easesReady = false;
function ensureEases() {
    if (_easesReady || !G) return;
    _easesReady = true;
    const CE = window.CustomEase;
    if (CE && G.parseEase && !G.parseEase('premium')) {
        try {
            CE.create('premium', 'M0,0 C0.22,1 0.36,1 1,1');     // ~cubic-bezier(.22,1,.36,1)
            CE.create('expo-out', 'M0,0 C0.16,1 0.3,1 1,1');
        } catch (_) { /* fall back to built-ins below */ }
    }
}
function ease(name) {
    ensureEases();
    if (G && G.parseEase && G.parseEase(name)) return name;
    return name === 'premium' || name === 'expo-out' ? 'power3.out' : name;
}

// ── Entrances ────────────────────────────────────────────────────────────

// Staggered rise-in for a set of elements (cards, rows, list items). Returns
// the tween/timeline or null. `from` controls direction. Safe + reduced-motion
// aware: under reduce / no-GSAP the elements are simply left visible.
export function revealStagger(targets, opts = {}) {
    if (!canAnimate()) return null;
    const {
        y = 14, duration = 0.5, stagger = 0.045, delay = 0,
        from = 'start', clearProps = 'transform',
    } = opts;
    return G.from(targets, {
        opacity: 0,
        y,
        duration,
        delay,
        ease: ease('premium'),
        stagger: { each: stagger, from },
        clearProps,            // hand styling back to CSS when done (so hover/tilt work)
        overwrite: 'auto',
    });
}

// Single element rise-in.
export function revealUp(target, opts = {}) {
    if (!canAnimate() || !target) return null;
    const { y = 16, duration = 0.5, delay = 0 } = opts;
    return G.from(target, {
        opacity: 0, y, duration, delay, ease: ease('premium'),
        clearProps: 'transform', overwrite: 'auto',
    });
}

// ── Number counter (replaces the hand-rolled animate.js tween) ─────────────
// Counts an element's text from `from` to `to`. `format(v)` renders each frame
// (default: rounded integer + suffix). Under reduce / no-GSAP, snaps to final.
export function countTo(el, from, to, opts = {}) {
    const { duration = 0.7, suffix = '', format = null } = opts;
    if (!el) return null;
    const render = (v) => { el.textContent = format ? format(v) : `${Math.round(v)}${suffix}`; };
    if (!canAnimate() || from === to || Number.isNaN(from)) { render(to); return null; }
    const obj = { v: from };
    return G.to(obj, {
        v: to, duration, ease: ease('premium'),
        onUpdate: () => render(obj.v),
    });
}

// ── SplitText headline reveal ──────────────────────────────────────────────
// Animates a text element in by characters or words. Returns a cleanup fn that
// reverts the split (call it when removing the element). No-op safe.
export function revealText(el, opts = {}) {
    if (!canAnimate() || !el || !window.SplitText) return () => {};
    const { type = 'chars', duration = 0.6, stagger = 0.02, y = '0.5em' } = opts;
    let split;
    try { split = new window.SplitText(el, { type }); } catch (_) { return () => {}; }
    const parts = type === 'words' ? split.words : split.chars;
    G.from(parts, {
        opacity: 0, yPercent: 60, duration, ease: ease('expo-out'),
        stagger, overwrite: 'auto',
    });
    return () => { try { split.revert(); } catch (_) {} };
}

// ── DrawSVG line-draw ──────────────────────────────────────────────────────
// Draws an SVG path/line/polyline from 0 to 100% (e.g. sparklines, the ECG
// trace). `selector` can be an element or a CSS selector within `scope`.
export function drawLine(selector, opts = {}) {
    if (!canAnimate() || !window.DrawSVGPlugin) return null;
    const { duration = 0.9, delay = 0, scope = document } = opts;
    const el = typeof selector === 'string' ? scope.querySelector(selector) : selector;
    if (!el) return null;
    return G.fromTo(el, { drawSVG: '0%' }, {
        drawSVG: '100%', duration, delay, ease: ease('premium'),
    });
}

// ── Flip (layout transitions) ──────────────────────────────────────────────
// Smoothly animate a layout change you're about to make. Usage:
//   const state = motion.flipCapture('.hot-pick-card');
//   ...mutate the DOM (reorder / resize)...
//   motion.flipAnimate(state);
// Under reduce / no-GSAP, flipCapture returns null and flipAnimate no-ops, so
// the layout change just happens instantly.
export function flipCapture(targets) {
    if (!canAnimate() || !window.Flip) return null;
    try { return window.Flip.getState(targets); } catch (_) { return null; }
}
export function flipAnimate(state, opts = {}) {
    if (!state || !window.Flip) return null;
    const { duration = 0.5, stagger = 0.03 } = opts;
    try {
        return window.Flip.from(state, {
            duration, ease: ease('premium'), stagger,
            absolute: true, onEnter: (els) => G.from(els, { opacity: 0, scale: 0.9, duration }),
            onLeave: (els) => G.to(els, { opacity: 0, scale: 0.9, duration }),
        });
    } catch (_) { return null; }
}

// ── Attention pulse (e.g. a value that just changed) ───────────────────────
export function pulse(target, opts = {}) {
    if (!canAnimate() || !target) return null;
    const { scale = 1.06, duration = 0.18 } = opts;
    return G.fromTo(target, { scale: 1 }, {
        scale, duration, yoyo: true, repeat: 1, ease: 'power2.inOut',
        transformOrigin: 'center', overwrite: 'auto',
    });
}
