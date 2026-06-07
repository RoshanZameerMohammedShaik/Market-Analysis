// Coordinator for right-edge slide-in side panels (Mia + Portfolio).
//
// Rule: whoever opens FIRST keeps the right edge. Whoever opens second
// stacks to its left. When the first one closes, the second slides over
// to take the right edge.
//
// Implementation: each registered panel exports getElement() + a width.
// The stack maintains an ordered array of currently-open panel ids in
// open-order. We translate that to a CSS variable per panel that says
// how far from the right edge it should sit.
//
// Panels read these vars in their CSS:
//   #panel-id { right: var(--panel-id-offset, -100%); }  (closed = off-screen)
//   .panel-id.open { right: var(--panel-id-offset, 0); } (open  = at offset)

const PANELS = new Map(); // id -> { width: number|fn, getElement, onLayout? }
const openOrder = []; // [first-opened, second-opened, ...]

export function registerSidePanel(id, opts) {
    PANELS.set(id, opts);
}

export function openSidePanel(id) {
    if (!PANELS.has(id)) return;
    if (openOrder.includes(id)) {
        recomputeLayout();
        return;
    }
    openOrder.push(id);
    recomputeLayout();
}

export function closeSidePanel(id) {
    const idx = openOrder.indexOf(id);
    if (idx === -1) return;
    openOrder.splice(idx, 1);
    recomputeLayout();
}

export function isSidePanelOpen(id) {
    return openOrder.includes(id);
}

// Recompute every open panel's offset from the right edge based on its
// position in openOrder. The panel at index 0 (opened first) sits at
// right: 0; the next panel sits at right: width-of-first; etc.
function recomputeLayout() {
    let cumulativeRight = 0;
    for (let i = 0; i < openOrder.length; i++) {
        const id = openOrder[i];
        const cfg = PANELS.get(id);
        if (!cfg) continue;
        const w = typeof cfg.width === 'function' ? cfg.width() : cfg.width;
        // The CSS var carries this panel's right-edge offset in px.
        document.documentElement.style.setProperty(`--${id}-stack-right`, `${cumulativeRight}px`);
        cumulativeRight += w;
    }
    // Body class signals which panels are open so panel CSS can hook
    // both "is open at all" and "is at right edge / stacked left of
    // another panel" if it wants distinct visual treatment per state.
    document.body.classList.toggle('side-panel-mia-open', openOrder.includes('mia'));
    document.body.classList.toggle('side-panel-portfolio-open', openOrder.includes('portfolio'));
    document.body.classList.toggle('side-panel-pl-open', openOrder.includes('pl'));
    // Notify EVERY registered panel so each one can sync its open class /
    // aria-hidden / launcher state with the current stack. We can't iterate
    // only openOrder here, because a panel that just closed has been removed
    // from openOrder and would never get notified — its .open class would
    // stay set forever, leaving it visible after the user clicked ✕.
    for (const [id, cfg] of PANELS.entries()) {
        cfg?.onLayout?.();
    }
}

// Expose order for debugging / for panels that want to know if they're
// "in front" (top of stack at right edge).
export function getOpenOrder() {
    return [...openOrder];
}

// Selectors for elements that should NOT trigger click-outside close.
// Any registered panel can opt extra selectors in via opts.outsideExempt
// passed to registerSidePanel. We always exempt:
//   - the panels themselves (their .getElement())
//   - any modal backdrops the panels open (Trade modal, Instantiate
//     modal, etc. — clicking their content shouldn't close the panel
//     behind them)
//   - launcher buttons (clicking the launcher to toggle is its own
//     handler; we'd close-then-toggle-open which is jittery)
const ALWAYS_EXEMPT_SELECTORS = [
    '#mia-launcher',
    '#portfolio-launcher',
    '#pl-launcher',
    '.portfolio-modal-backdrop',
    '.portfolio-modal',
    '.search-results',
    '.mia-voice-overlay',
    '.mia-launcher-caption',
    '.mia-launcher-glass',
];

// Click-outside-to-close. Listens at the document level (capture phase
// so we beat any panel-internal handlers that might preventDefault).
// When ANY panel is open and the click target is outside every open
// panel + every exempt selector, close all open panels.
function isClickOutsideAllPanels(target) {
    if (!target || target.nodeType !== 1) return false;
    // If click is inside any registered panel's element, NOT outside.
    for (const id of openOrder) {
        const cfg = PANELS.get(id);
        const el = cfg?.getElement?.();
        if (el && el.contains(target)) return false;
    }
    // If click matches any always-exempt selector, NOT outside.
    for (const sel of ALWAYS_EXEMPT_SELECTORS) {
        if (target.closest(sel)) return false;
    }
    return true;
}

document.addEventListener('mousedown', (e) => {
    if (openOrder.length === 0) return;
    if (!isClickOutsideAllPanels(e.target)) return;
    // Close all open panels — same as ✕ on each, in reverse order so
    // the layout recomputes one panel at a time and we don't fight
    // the transitions.
    const toClose = [...openOrder].reverse();
    for (const id of toClose) closeSidePanel(id);
}, true);
// Same handler for touchstart so mobile gestures close too. We use
// touchstart not touchend so the close happens immediately on tap-down,
// matching the responsiveness of the chat-app pattern users expect.
document.addEventListener('touchstart', (e) => {
    if (openOrder.length === 0) return;
    if (!isClickOutsideAllPanels(e.target)) return;
    const toClose = [...openOrder].reverse();
    for (const id of toClose) closeSidePanel(id);
}, { capture: true, passive: true });
