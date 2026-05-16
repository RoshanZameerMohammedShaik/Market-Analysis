// Visible feedback when Mia drives the app. The chat-bubble tool-badge tells
// the user *what* she's doing; this module makes it visible on the page itself
// — pulsing the control she just touched and showing a brief toast — so the
// agentic action doesn't feel invisible when it happens behind/around the
// chat panel.

const PULSE_CLASS = 'mia-agent-pulse';
const PULSE_MS = 1100;

let toastEl = null;
let toastTimer = null;

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

export function showAgentToast(text, ms = 2200) {
    if (!text) return;
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'mia-agent-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = `<span class="mia-agent-toast-dot"></span><span class="mia-agent-toast-text"></span>`;
    toastEl.querySelector('.mia-agent-toast-text').textContent = text;
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.classList.remove('show'); }, ms);
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
