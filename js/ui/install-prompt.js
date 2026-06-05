// PWA install affordance.
//
// Two platforms, two paths:
//   - Android / desktop Chrome/Edge fire `beforeinstallprompt`; we capture
//     it, suppress the default mini-infobar, and show our own tasteful
//     button that calls prompt() on click.
//   - iOS Safari has NO beforeinstallprompt — the only way to install is
//     Share → Add to Home Screen. So for iOS we show a one-line
//     instruction card instead of a button.
//
// Why bother: installed (standalone) mode is also the ONLY way iOS
// delivers Web Push, so nudging install directly helps the alert feature.
//
// Respectful: never shown if already installed (standalone), dismissible,
// and a dismissal is remembered (localStorage) so we don't nag. Surfaces
// only after a short delay so it doesn't fight the splash / first paint.

const DISMISS_KEY = 'ma-install-dismissed-v1';
const SHOW_DELAY_MS = 6000;

let deferredPrompt = null;

function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}
function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
}
function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
}

function buildCard(innerHtml) {
    const el = document.createElement('div');
    el.className = 'install-prompt';
    el.id = 'install-prompt';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Install Market Analyzer');
    el.innerHTML = innerHtml + `<button class="install-prompt-x" id="install-prompt-x" aria-label="Dismiss">×</button>`;
    document.body.appendChild(el);
    el.querySelector('#install-prompt-x').addEventListener('click', () => {
        rememberDismiss();
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 240);
    });
    // Animate in next frame.
    requestAnimationFrame(() => el.classList.add('visible'));
    return el;
}

function showAndroidCard() {
    if (document.getElementById('install-prompt')) return;
    const el = buildCard(`
        <div class="install-prompt-body">
            <div class="install-prompt-icon">📈</div>
            <div class="install-prompt-text">
                <div class="install-prompt-title">Install Market Analyzer</div>
                <div class="install-prompt-sub">Add it to your home screen — full-screen, faster, and enables price alerts.</div>
            </div>
            <button class="install-prompt-btn" id="install-prompt-go">Install</button>
        </div>`);
    el.querySelector('#install-prompt-go').addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch (_) {}
        deferredPrompt = null;
        rememberDismiss();  // installed or declined — either way don't re-nag
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 240);
    });
}

function showIosCard() {
    if (document.getElementById('install-prompt')) return;
    buildCard(`
        <div class="install-prompt-body">
            <div class="install-prompt-icon">📲</div>
            <div class="install-prompt-text">
                <div class="install-prompt-title">Add to Home Screen</div>
                <div class="install-prompt-sub">Tap <span class="install-prompt-share">⎙ Share</span> then “Add to Home Screen” for full-screen + price alerts.</div>
            </div>
        </div>`);
}

export function initInstallPrompt() {
    if (isStandalone() || dismissed()) return;   // already installed or user said no

    // Android / desktop: capture the event, then offer our own button.
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();              // suppress the default mini-infobar
        deferredPrompt = e;
        if (!dismissed()) setTimeout(showAndroidCard, SHOW_DELAY_MS);
    });

    // iOS Safari (not standalone): no event — show the manual hint card.
    if (isIos()) {
        setTimeout(() => { if (!isStandalone() && !dismissed()) showIosCard(); }, SHOW_DELAY_MS);
    }

    // If the app gets installed during the session, drop any visible card.
    window.addEventListener('appinstalled', () => {
        rememberDismiss();
        document.getElementById('install-prompt')?.remove();
    });
}
