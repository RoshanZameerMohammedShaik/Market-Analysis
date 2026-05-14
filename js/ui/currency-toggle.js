// Header currency toggle button. Shows the *target* mode it'll switch to.
// '$ → ₹' icon when USD is active; '₹ → $' when INR is active.

import { toggle, getMode, fetchRate, getRate, onCurrencyChange } from '../currency.js';

export function initCurrencyToggle() {
    const btn = document.getElementById('currency-toggle');
    if (!btn) return;
    paint(btn);
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await toggle();
        } finally {
            btn.disabled = false;
            paint(btn);
        }
    });
    onCurrencyChange(() => paint(btn));
    // Refresh rate display every minute (in case user keeps the page open).
    setInterval(() => paint(btn), 60_000);
}

function paint(btn) {
    const mode = getMode();
    const rate = getRate();
    btn.classList.toggle('active', mode === 'INR');
    btn.innerHTML = mode === 'USD'
        ? '<span class="cur-from">$</span><span class="cur-arrow">→</span><span class="cur-to">₹</span>'
        : '<span class="cur-from">₹</span><span class="cur-arrow">→</span><span class="cur-to">$</span>';
    const ageMin = rate ? Math.max(0, Math.round((Date.now() - rate.ts) / 60000)) : null;
    btn.title = mode === 'USD'
        ? (rate ? `Show prices in INR (1 USD = ₹${rate.usdToInr.toFixed(2)} · refreshed ${ageMin}m ago)` : 'Show prices in INR')
        : (rate ? `Show prices in USD (1 USD = ₹${rate.usdToInr.toFixed(2)} · refreshed ${ageMin}m ago)` : 'Show prices in USD');
}
