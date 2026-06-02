// Visible feedback when Mia drives the app. The chat-bubble tool-badge tells
// the user *what* she's doing; this module makes it visible on the page itself
// — pulsing the control she just touched and showing a brief toast — so the
// agentic action doesn't feel invisible when it happens behind/around the
// chat panel.

const PULSE_CLASS = 'mia-agent-pulse';
const PULSE_MS = 1100;

export function pulseElement(el) {
    if (!el || !el.classList) return;
    el.classList.remove(PULSE_CLASS);
    void el.offsetWidth;
    el.classList.add(PULSE_CLASS);
    setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS + 50);
}

export function pulseElementById(id) {
    const el = id ? document.getElementById(id) : null;
    if (el) pulseElement(el);
    return el;
}

export function pulseSelector(sel) {
    const el = sel ? document.querySelector(sel) : null;
    if (el) pulseElement(el);
    return el;
}

export function scrollIntoViewIfNeeded(el) {
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
    if (!inView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Now routes through the unified notification system (top-left,
// auto-drain green bar, pause-on-hover, pin-on-click). The old
// custom .mia-agent-toast element + timer are gone.
import { notifyInfo } from '../ui/notify.js';
let _lastHandle = null;
export function showAgentToast(text, ms = 5000) {
    if (!text) return;
    // Only one Mia agent toast on screen at a time — close the
    // previous one before opening the next so we don't stack
    // identical agent-step toasts.
    if (_lastHandle) _lastHandle.close();
    _lastHandle = notifyInfo(text, { autoCloseMs: ms });
}

export function announce({ text, target }) {
    if (text) showAgentToast(text);
    if (target) {
        const el = typeof target === 'string'
            ? (target.startsWith('#') ? document.querySelector(target) : document.getElementById(target))
            : target;
        if (el) {
            scrollIntoViewIfNeeded(el);
            pulseElement(el);
        }
    }
}
