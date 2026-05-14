// Renders a small market-selector pill row in the controls section.
// Hidden when the user is on the Crypto tab (crypto is global).

import { MARKETS, getMarketId, setMarketId } from '../markets.js';
import { state } from './state.js';

export function initMarketSelector({ onChange }) {
    const host = document.getElementById('market-selector');
    if (!host) return;
    const render = () => {
        const active = getMarketId();
        host.innerHTML = `
            <span class="ms-label">Market</span>
            ${Object.values(MARKETS).map(m => `
                <button class="ms-btn ${m.id === active ? 'active' : ''}" data-mid="${m.id}" title="${m.label} · Yahoo Finance, 15-min delayed">
                    <span class="ms-flag">${m.flag}</span>
                    <span class="ms-name">${m.id}</span>
                </button>
            `).join('')}
        `;
        host.querySelectorAll('[data-mid]').forEach(btn => btn.addEventListener('click', () => {
            setMarketId(btn.dataset.mid);
            render();
            if (onChange) onChange(btn.dataset.mid);
        }));
    };
    render();
    syncVisibility();
    document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTimeout(syncVisibility, 0)));
}

function syncVisibility() {
    const host = document.getElementById('market-selector');
    if (!host) return;
    host.style.display = state.mode === 'crypto' ? 'none' : '';
}
