// Unified notification system. Top-left toast container with a green
// auto-drain progress bar. Replaces the ad-hoc `mia-agent-toast` and
// `portfolio-toast` snippets scattered around the codebase.
//
// Behaviour (Roshan's spec):
//   - Top-left of the viewport, newest at the top, older slide down.
//   - Each notification carries a green liner that drains over 5s.
//   - The notification auto-dismisses when the bar reaches 0.
//   - Hovering the notification pauses the drain (timer accumulates
//     active non-hovered time, so a hover at 2s elapsed resumes from
//     2s when the user leaves — not a 5s reset).
//   - Clicking the body of the notification removes the bar and
//     pins the notification — it stays until the user clicks ×.
//   - × button always closes the notification immediately.
//
// API:
//   notify('Saved successfully')
//   notify('Connection failed', { kind: 'error' })
//   notify('Calculating…', { kind: 'info', autoCloseMs: 8000 })
//   notify('Trade executed', { kind: 'success' })
//
// `kind` is one of 'info' | 'success' | 'warn' | 'error'. Default
// 'info'. The colour of the drain bar always stays green per spec
// (visual is "the timer running out", not "this is good news"),
// but the body left-border tints with the kind.

const CONTAINER_ID = 'ma-notify-container';
const DEFAULT_DURATION_MS = 5000;

function ensureContainer() {
    let el = document.getElementById(CONTAINER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = CONTAINER_ID;
    el.className = 'ma-notify-container';
    document.body.appendChild(el);
    return el;
}

function buildNotification(message, kind) {
    const el = document.createElement('div');
    el.className = `ma-notify ma-notify-${kind || 'info'}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    el.innerHTML = `
        <div class="ma-notify-body">
            <div class="ma-notify-text"></div>
            <button type="button" class="ma-notify-close" aria-label="Dismiss">×</button>
        </div>
        <div class="ma-notify-bar" aria-hidden="true">
            <div class="ma-notify-bar-fill"></div>
        </div>
    `;
    el.querySelector('.ma-notify-text').textContent = String(message);
    return el;
}

/**
 * Create a notification. Returns a handle with .close() so callers
 * can dismiss programmatically.
 */
export function notify(message, opts = {}) {
    const { kind = 'info', autoCloseMs = DEFAULT_DURATION_MS } = opts;
    const container = ensureContainer();
    const el = buildNotification(message, kind);
    // Prepend so the newest sits at the top of the stack.
    container.insertBefore(el, container.firstChild);

    // Semantic sound cue. success → warm rise, error/warn → soft low two-tone.
    // info stays silent (it fires constantly — "Calculating…", "Loading…" —
    // and a sound on every one would be noise). Lazy import so notify.js has
    // no hard dependency on the audio layer and works if it's absent.
    if (kind === 'success' || kind === 'error' || kind === 'warn') {
        import('./ui-sound.js').then(s => {
            if (kind === 'success') s.success();
            else s.error();
        }).catch(() => {});
    }

    // Drain logic — track `elapsed` in active (non-hovered) ms.
    const fill = el.querySelector('.ma-notify-bar-fill');
    let elapsed = 0;
    let lastTick = performance.now();
    let raf = 0;
    let paused = false;
    let pinned = false;
    let closed = false;

    function tick(now) {
        if (closed) return;
        if (!paused && !pinned) {
            elapsed += now - lastTick;
        }
        lastTick = now;
        const ratio = Math.min(1, elapsed / autoCloseMs);
        fill.style.width = `${(1 - ratio) * 100}%`;
        if (ratio >= 1 && !pinned) {
            close();
            return;
        }
        raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    function close() {
        if (closed) return;
        closed = true;
        cancelAnimationFrame(raf);
        el.classList.add('ma-notify-leaving');
        // Wait for the slide-out, then remove from DOM.
        setTimeout(() => el.remove(), 240);
    }

    // Pause on hover. Use pointer events so we cover mouse + pen +
    // touch hold. Mobile tap is treated as a click below — no hover.
    el.addEventListener('pointerenter', () => { paused = true; });
    el.addEventListener('pointerleave', () => { paused = false; });

    // Click body (not the ×) → pin the notification, hide the bar.
    el.querySelector('.ma-notify-body').addEventListener('click', (e) => {
        if (e.target.closest('.ma-notify-close')) return; // × handler runs
        if (pinned) return;
        pinned = true;
        el.classList.add('ma-notify-pinned');
    });
    // × always closes.
    el.querySelector('.ma-notify-close').addEventListener('click', close);

    return { el, close };
}

// Sugar for the four common kinds.
export const notifyInfo    = (msg, opts) => notify(msg, { ...opts, kind: 'info' });
export const notifySuccess = (msg, opts) => notify(msg, { ...opts, kind: 'success' });
export const notifyWarn    = (msg, opts) => notify(msg, { ...opts, kind: 'warn' });
export const notifyError   = (msg, opts) => notify(msg, { ...opts, kind: 'error' });
