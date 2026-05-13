// Dev-mode flag: gates internal diagnostics (calibration badge,
// heuristic→historical delta, live-accuracy strip) so the public sees
// a clean signal card while the operator gets the full picture.
//
// Activation:
//   - Visit ?dev=1 once → stored in localStorage, persists across reloads
//   - Visit ?dev=0 → cleared
//   - Anything else → honor whatever's in localStorage
//
// This is privacy theater, not security. Anyone reading the source can
// flip it on. Use it for noise reduction, never to hide anything sensitive.

const STORAGE_KEY = 'ma-dev-mode';

function readUrlFlag() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('dev')) return null;
        return params.get('dev') === '1';
    } catch (_) {
        return null;
    }
}

function persist(value) {
    try {
        if (value) localStorage.setItem(STORAGE_KEY, '1');
        else localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* quota / disabled */ }
}

let cached = null;

export function isDev() {
    if (cached !== null) return cached;
    const urlFlag = readUrlFlag();
    if (urlFlag !== null) {
        persist(urlFlag);
        cached = urlFlag;
        return cached;
    }
    try {
        cached = localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
        cached = false;
    }
    return cached;
}
