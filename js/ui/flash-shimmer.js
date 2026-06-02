// One-shot shimmer helper.
//
// Roshan's pattern: when the user clicks something that navigates to
// the next view (gear → P&L Calculator inside Portfolio, header
// Portfolio button → "Portfolio Simulation" panel header, Mia toggle
// → "Mia" name in the chat, Resources toggle → "Resources" headline),
// the destination's name should run a single left-to-right shimmer
// once it's on screen so the user's eye lands on it. The text ends
// bright white (or theme-blue) and STAYS bright — the shimmer is the
// transition into a bright label, not a flash that disappears.
//
// CSS does the visual: .flash-shimmer's animation runs once with
// fill-mode: forwards so the final frame (bright peak over the text)
// stays after the animation ends. This module only adds the class
// once and never removes it, so the persisted bright state holds
// until the element is re-rendered by something else.
//
// Theme-awareness is handled in CSS via [data-theme="light"]
// .flash-shimmer override; this module is theme-agnostic.

/**
 * Run the one-shot shimmer on the given element. Safe to call when
 * `el` is null (no-op). Re-firing while a shimmer is already running
 * restarts it from the beginning (matches the user's expectation of
 * "highlight this NOW") — useful when a panel is opened a second time
 * after the bright state was wiped by a re-render.
 */
export function flashShimmer(el) {
    if (!el) return;
    // Restart pattern: remove the class, force a reflow, re-add.
    // Toggling alone won't restart the animation if the class is
    // already present from a previous shimmer that wasn't cleared.
    el.classList.remove('flash-shimmer');
    void el.offsetWidth;
    el.classList.add('flash-shimmer');
    // Note: we DON'T strip the class on animationend. The whole point
    // of one-shot shimmer is that it ends with the text bright and
    // STAYS bright (animation-fill-mode: forwards in the CSS holds the
    // final frame). Removing the class here would snap the text back
    // to its dim base immediately after the sweep — exactly what
    // Roshan called out as wrong.
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
