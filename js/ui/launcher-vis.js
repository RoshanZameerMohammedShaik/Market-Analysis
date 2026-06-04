// Single owner of the Mia launcher's visibility state. Replaces the
// brittle CSS class cascade (.side-panel-mia-open + .mia-voice-minimized
// + .mia-agentic-active overlapping each other) that was leaving the
// launcher hidden after agentic stage close in a real Roshan session.
//
// Anywhere code wants to change launcher visibility, it calls
// setLauncherVis('hidden' | 'orb' | 'visible'). The function writes
// data-launcher-vis on <body>, which CSS reads to apply the right
// styles. No more "is voice on AND panel closed AND agentic NOT
// running" boolean math scattered across files.
//
// Three modes:
//   'hidden'  — chat panel is open in chat mode; launcher would compete.
//   'orb'     — voice minimized or agentic stage active; launcher renders
//               as the orb visualization.
//   'visible' — default. Round disc with M-ECG glyph; tap to open panel.

const ATTR = 'data-launcher-vis';
const VALID = new Set(['hidden', 'orb', 'visible']);

export function setLauncherVis(mode) {
    if (!VALID.has(mode)) {
        // No-op on bad input rather than throw — visibility is a UX
        // concern, not a correctness one. Log so dev sees the typo.
        console.warn('[launcher-vis] unknown mode:', mode);
        return;
    }
    if (mode === 'visible') {
        document.body.removeAttribute(ATTR);
    } else {
        document.body.setAttribute(ATTR, mode);
    }
}

export function getLauncherVis() {
    return document.body.getAttribute(ATTR) || 'visible';
}
