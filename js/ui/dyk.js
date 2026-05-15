// 'Did you know?' floating chip. Surfaces a random tip every ~45s,
// dismissable, won't repeat within a session. Suppressed on very small
// viewports where it covers content.

import { nextTip } from './tips.js';

const INTERVAL_MS = 45_000;
const MIN_DELAY_MS = 18_000;
const MOBILE_AUTO_HIDE_MS = 6_000;
const DESKTOP_AUTO_HIDE_MS = 12_000;

let timer = null;
let shown = false;

function isVerySmall() {
    return window.innerWidth <= 480;
}

export function startDyk() {
    if (timer) return;
    setTimeout(scheduleNext, MIN_DELAY_MS);
}

function scheduleNext() {
    timer = setTimeout(showNext, INTERVAL_MS);
}

function showNext() {
    // Suppress entirely on very small screens — it covers content.
    if (isVerySmall()) { scheduleNext(); return; }
    if (shown) { hide(); }
    const tip = nextTip();
    const root = document.body;
    const el = document.createElement('div');
    el.className = 'dyk-chip';
    el.id = 'dyk-chip';
    el.innerHTML = `
        <div class="dyk-chip-head">
            <span>💡 Did you know?</span>
            <button class="dyk-chip-close" id="dyk-close" aria-label="Dismiss">✕</button>
        </div>
        <div class="dyk-chip-body">${escapeHtml(tip)}</div>
    `;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    shown = true;
    // Tap-anywhere on the chip dismisses it (mobile thumb-friendly).
    el.addEventListener('click', hide);
    const hideMs = window.innerWidth <= 768 ? MOBILE_AUTO_HIDE_MS : DESKTOP_AUTO_HIDE_MS;
    setTimeout(hide, hideMs);
    scheduleNext();
}

function hide() {
    const el = document.getElementById('dyk-chip');
    if (!el) { shown = false; return; }
    el.classList.remove('show');
    setTimeout(() => { el.remove(); shown = false; }, 500);
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
