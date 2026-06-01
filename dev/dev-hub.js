// Dev Hub controller — single toggle button + how-to-use copy.
//
// The standalone console viewer was removed because each tab has
// its own debug-capture buffer, so /dev's console only ever showed
// dev/index.html's own page events. The actual debug experience
// lives as a floating chip on the main app (see js/ui/debug-panel.js)
// which captures and renders the SAME tab's logs in real time.
// /dev is now strictly: mode-toggle + instructions to find the chip.

const STORAGE_KEY = 'ma-dev-mode';

const statusEl = document.getElementById('dev-status');
const toggleBtn = document.getElementById('dev-toggle');

function isOn() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
}

function refresh() {
    const on = isOn();
    statusEl.dataset.on = on ? 'true' : 'false';
    statusEl.textContent = on ? 'on' : 'off';
    toggleBtn.dataset.on = on ? 'true' : 'false';
    toggleBtn.textContent = on ? 'Turn OFF' : 'Turn ON';
}

toggleBtn.addEventListener('click', () => {
    try {
        if (isOn()) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, '1');
    } catch (_) {}
    refresh();
});

refresh();
