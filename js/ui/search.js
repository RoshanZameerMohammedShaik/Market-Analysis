import { searchStocks, searchCrypto } from '../data.js';
import { state } from './state.js';

let searchTimeout = null;

export function initSearch(onSelect) {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = input.value.trim();
        if (query.length < 2) {
            results.classList.remove('visible');
            return;
        }
        searchTimeout = setTimeout(() => performSearch(query, onSelect), 300);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim().length >= 2) {
            results.classList.add('visible');
        }
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.search-container')) results.classList.remove('visible');
    });
}

async function performSearch(query, onSelect) {
    const results = document.getElementById('search-results');
    results.innerHTML = '<div class="loading"><div class="loader"></div></div>';
    results.classList.add('visible');

    try {
        const items = state.mode === 'stock' ? await searchStocks(query) : await searchCrypto(query);
        if (items.length === 0) {
            results.innerHTML = '<div class="empty-state">No results found</div>';
            return;
        }
        results.innerHTML = items.map(item => {
            if (state.mode === 'stock') {
                return `<div class="search-result-item" data-symbol="${item.symbol}">
                    <div><span class="result-symbol">${item.symbol}</span> <span class="result-name">${item.name}</span></div>
                    <span class="result-name">${item.exchange || ''}</span>
                </div>`;
            }
            return `<div class="search-result-item" data-coinid="${item.id}" data-symbol="${item.symbol}">
                <div><span class="result-symbol">${item.symbol}</span> <span class="result-name">${item.name}</span></div>
            </div>`;
        }).join('');
        results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                results.classList.remove('visible');
                onSelect({
                    mode: state.mode,
                    symbol: el.dataset.symbol,
                    coinId: el.dataset.coinid || null,
                });
            });
        });
    } catch (e) {
        results.innerHTML = `<div class="error-message">Search failed: ${e.message}</div>`;
    }
}

export function updatePlaceholder() {
    const input = document.getElementById('search-input');
    if (!input) return;
    input.placeholder = state.mode === 'stock'
        ? 'Search stocks by name or symbol (e.g., AAPL, Tesla)...'
        : 'Search crypto by name (e.g., Bitcoin, Solana)...';
}
