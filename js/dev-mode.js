// Dev-mode flag: gates internal diagnostics so the public sees a clean
// signal card while the operator gets full diagnostic detail.
//
// Activation paths (any one works):
//   - Visit /dev    → dev/index.html sets localStorage and redirects to /
//   - Visit /dev/off → clears localStorage
//   - ?dev=1 / ?dev=0 still work (legacy)
//   - Manual: localStorage.setItem('ma-dev-mode', '1')
//
// This is noise reduction, not security. Anyone reading the source can
// flip it on. Don't put anything sensitive behind it.

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
    } catch (_) { /* */ }
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
