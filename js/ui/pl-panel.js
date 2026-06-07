// P&L Calculator — standalone right-edge slide-in side panel.
//
// Previously the calculator lived inside the Portfolio panel (a collapsed
// <details>). Roshan asked for it to be its own panel. The calculator fields
// + math still live in js/ui/pl.js (operating on #pl-sidebar / #pl-* ids);
// this module just owns the PANEL CHROME — registering #pl-panel with the
// side-panel-stack coordinator (so it stacks alongside Mia + Portfolio),
// wiring the #pl-launcher button, and the close button.
//
// The agentic-stage P&L demo (controlPLCalculate in mia/ui-bridge.js) still
// relocates #pl-sidebar into the centered glass stage — opening this panel
// first is the non-agentic path the launcher + Mia's open_pl_panel use.

import { registerSidePanel, openSidePanel, closeSidePanel, isSidePanelOpen } from './side-panel-stack.js';
import { flashShimmer } from './flash-shimmer.js';

const PANEL_WIDTH = 380;

export function initPLPanel() {
    const panel = document.getElementById('pl-panel');
    if (!panel) return;
    registerSidePanel('pl', {
        width: () => Math.min(PANEL_WIDTH, window.innerWidth * 0.94),
        getElement: () => document.getElementById('pl-panel'),
        onLayout: () => {
            const el = document.getElementById('pl-panel');
            if (!el) return;
            el.classList.toggle('open', isSidePanelOpen('pl'));
            el.setAttribute('aria-hidden', isSidePanelOpen('pl') ? 'false' : 'true');
        },
    });

    // Launcher toggles the panel.
    const launcher = document.getElementById('pl-launcher');
    if (launcher) {
        launcher.addEventListener('click', () => {
            if (isSidePanelOpen('pl')) closePLPanel();
            else openPLPanel();
        });
    }

    // Close button (delegated on the panel for robustness, mirroring portfolio).
    panel.addEventListener('click', (e) => {
        if (e.target.closest('#pl-panel-close')) {
            e.preventDefault();
            e.stopPropagation();
            closePLPanel();
        }
    });
}

export function openPLPanel(opts = {}) {
    const { shimmerTitle = true, focusFirst = false } = opts;
    openSidePanel('pl');
    if (shimmerTitle) {
        requestAnimationFrame(() => flashShimmer(document.querySelector('#pl-panel .pl-panel-title-text')));
    }
    if (focusFirst) {
        requestAnimationFrame(() => document.getElementById('pl-investment')?.focus({ preventScroll: true }));
    }
}

export function closePLPanel() {
    closeSidePanel('pl');
}

export function isPLPanelOpen() {
    return isSidePanelOpen('pl');
}
