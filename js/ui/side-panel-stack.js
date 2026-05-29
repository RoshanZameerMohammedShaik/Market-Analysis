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
