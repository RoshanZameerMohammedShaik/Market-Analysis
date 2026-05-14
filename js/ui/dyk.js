// 'Did you know?' floating chip. Surfaces a random tip every 30s,
// dismissable, won't repeat within a session.

import { nextTip } from './tips.js';

const INTERVAL_MS = 30_000;
const MIN_DELAY_MS = 12_000;

let timer = null;
let shown = false;

export function startDyk() {
    if (timer) return;
    setTimeout(scheduleNext, MIN_DELAY_MS);
}

function scheduleNext() {
    timer = setTimeout(showNext, INTERVAL_MS);
}

function showNext() {
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
    document.getElementById('dyk-close').addEventListener('click', hide);
    // Auto-dismiss after 12s
    setTimeout(hide, 12_000);
    scheduleNext();
}

function hide() {
    const el = document.getElementById('dyk-chip');
    if (!el) { shown = false; return; }
    el.classList.remove('show');
    setTimeout(() => { el.remove(); shown = false; }, 500);
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
