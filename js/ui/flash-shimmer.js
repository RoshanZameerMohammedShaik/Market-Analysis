// One-shot shimmer helper.
//
// Roshan's pattern: when the user clicks something that navigates to
// the next view (settings-gear → P&L Calculator inside Portfolio,
// header Portfolio button → "Portfolio Simulation" panel header,
// etc.), the destination's name should run a single left-to-right
// shimmer once it's on screen so the user's eye is pulled to it.
//
// CSS does the visual; this module just toggles the .flash-shimmer
// class onto a target element and removes it after the animation
// finishes (or after a hard timeout, in case animationend doesn't
// fire — e.g., element re-rendered, prefers-reduced-motion, etc.).
//
// Theme-awareness is handled in CSS via [data-theme="light"]
// .flash-shimmer override; this module is theme-agnostic.

const FALLBACK_MS = 2200;   // generous; animation is 1.6s

/**
 * Run the one-shot shimmer on the given element. Safe to call when
 * `el` is null (no-op). Re-firing while a shimmer is already running
 * restarts it from the beginning (matches the user's expectation of
 * "highlight this NOW").
 */
export function flashShimmer(el) {
    if (!el) return;
    // Restart pattern: remove the class, force a reflow, re-add it.
    // Just toggling won't restart the animation if the class is
    // already present.
    el.classList.remove('flash-shimmer');
    void el.offsetWidth;
    el.classList.add('flash-shimmer');
    const cleanup = () => el.classList.remove('flash-shimmer');
    el.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, FALLBACK_MS);
}

/**
 * Convenience: query a selector and shimmer it. Returns true if a
 * matching element was found and the shimmer was kicked off.
 */
export function flashShimmerSelector(selector, root = document) {
    const el = root.querySelector(selector);
    if (!el) return false;
    flashShimmer(el);
    return true;
}
