// Currency picker. Settings-menu item that opens a sub-list of all
// supported currencies; user picks one and the whole app re-renders
// in that currency.
//
// The settings menu structure (header dropdown) doesn't natively
// support a sub-list, so we use a small popover anchored to the
// menu item that opens on click. Clicking outside closes it.

import { setMode, getMode, fetchRates, onCurrencyChange, SUPPORTED_CURRENCIES, getCurrencyName, getCurrencySymbol } from '../currency.js';

export function initCurrencyToggle() {
    const btn = document.getElementById('currency-toggle');
    if (!btn) return;
    paint(btn);
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't let the parent settings menu close
        toggleCurrencyPicker(btn);
    });
    onCurrencyChange(() => paint(btn));
    // Initial fetch so rates are warm by the time user opens the picker.
    fetchRates().catch(() => {});
}

function paint(btn) {
    const mode = getMode();
    const sym = getCurrencySymbol(mode).trim() || mode;
    const meta = btn.querySelector('#currency-toggle-meta');
    if (meta) meta.textContent = `${sym} · ${mode}`;
    btn.title = `Change display currency (currently ${getCurrencyName(mode)})`;
}

let picker = null;

function toggleCurrencyPicker(anchor) {
    if (picker) {
        closeCurrencyPicker();
        return;
    }
    picker = document.createElement('div');
    picker.className = 'currency-picker';
    picker.setAttribute('role', 'listbox');
    const cur = getMode();
    picker.innerHTML = SUPPORTED_CURRENCIES.map(c => `
        <button class="currency-picker-item ${c.code === cur ? 'active' : ''}" data-code="${c.code}" type="button" role="option">
            <span class="currency-picker-symbol">${c.symbol}</span>
            <span class="currency-picker-code">${c.code}</span>
            <span class="currency-picker-name">${c.name}</span>
        </button>
    `).join('');
    document.body.appendChild(picker);

    // Position relative to the anchor.
    const r = anchor.getBoundingClientRect();
    picker.style.top = `${r.top}px`;
    // Show to the LEFT of the menu so it doesn't overflow off-screen.
    picker.style.right = `${window.innerWidth - r.left + 8}px`;

    picker.addEventListener('click', (e) => {
        const item = e.target.closest('.currency-picker-item');
        if (!item) return;
        e.stopPropagation();
        setMode(item.dataset.code);
        closeCurrencyPicker();
    });

    // Click outside → close.
    setTimeout(() => {
        document.addEventListener('click', _outsideClose, true);
        document.addEventListener('keydown', _escClose);
    }, 0);
}

function _outsideClose(e) {
    if (!picker) return;
    if (picker.contains(e.target)) return;
    closeCurrencyPicker();
}
function _escClose(e) {
    if (e.key === 'Escape') closeCurrencyPicker();
}

function closeCurrencyPicker() {
    if (!picker) return;
    picker.remove();
    picker = null;
    document.removeEventListener('click', _outsideClose, true);
    document.removeEventListener('keydown', _escClose);
}
