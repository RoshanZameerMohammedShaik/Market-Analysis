// Market Analyzer entry point.
import { init } from './ui/core.js';
import { initAbout } from './ui/about.js';
import { initCurrency } from './currency.js';
import { initCurrencyToggle } from './ui/currency-toggle.js';
import { initSpikers } from './ui/spikers.js';
import { initScanner } from './ui/scanner.js';
import { initWatchlist } from './ui/watchlist.js';
import { state } from './ui/state.js';

document.addEventListener('DOMContentLoaded', () => {
    initCurrency();
    init();
    initAbout();
    initCurrencyToggle();
    initScanner();
    initWatchlist();
    initSpikers({
        onPickSymbol: (sym) => {
            const input = document.getElementById('search-input');
            input.value = sym;
            // Programmatically dispatch input event so the search dropdown opens with results.
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Auto-pick the first matching item shortly after.
            setTimeout(() => {
                const item = document.querySelector(`.search-result-item[data-symbol="${sym}"]`);
                if (item) item.click();
            }, 600);
        },
    });
});
