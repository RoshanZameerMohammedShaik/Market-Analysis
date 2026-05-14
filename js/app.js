// Market Analyzer entry point.
import { init } from './ui/core.js';
import { initAbout } from './ui/about.js';

document.addEventListener('DOMContentLoaded', () => {
    init();
    initAbout();
});
