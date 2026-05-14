// Market Analyzer entry point.
import { init } from './ui/core.js';
import { initAbout } from './ui/about.js';
import { initCurrency } from './currency.js';
import { initCurrencyToggle } from './ui/currency-toggle.js';

document.addEventListener('DOMContentLoaded', () => {
    initCurrency();
    init();
    initAbout();
    initCurrencyToggle();
});
