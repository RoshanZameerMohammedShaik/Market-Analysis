// Market Analyzer entry point.
import { init } from './ui/core.js';
import { initAbout } from './ui/about.js';
import { initCurrency } from './currency.js';
import { initCurrencyToggle } from './ui/currency-toggle.js';
import { initSpikers } from './ui/spikers.js';
import { initScanner } from './ui/scanner.js';
import { initWatchlist } from './ui/watchlist.js';
import { initSectorHeatmap } from './ui/sector-heatmap.js';
import { initEarningsCalendar } from './ui/earnings-calendar.js';
// Removed per user: Unusual Options Activity (no data — Yahoo crumb-walled),
// "Did following the engine pay off" (equity curve), and "Which setups does
// the engine read best" (accuracy report) — all judged low-value.
// Also removed per user: the "Install Market Analyzer" PWA prompt card
// (js/ui/install-prompt.js stays on disk, just no longer initialized).
import { initPortfolioPanel } from './ui/portfolio-panel.js';
import { initDebugPanel } from './ui/debug-panel.js';
import { initUiSound } from './ui/ui-sound.js';
import { prewarmWatchlist } from './analysis-cache.js';
import { state } from './ui/state.js';

document.addEventListener('DOMContentLoaded', () => {
    initCurrency();
    init();
    initAbout();
    initCurrencyToggle();
    initScanner();
    initWatchlist();
    // Coverage surfaces — collapsed by default, lazy-load on open.
    initSectorHeatmap();
    initEarningsCalendar();
    initPortfolioPanel();
    // Floating Debug App panel — only mounts when dev mode is on.
    // Reads from the always-on debug-capture buffer that's already
    // running by the time we get here (loaded inline in <head>).
    initDebugPanel();
    // General UI sound layer — delegated hover/click/tab cues across the app.
    // Shares Mia's mute + speaking gate; success/error fire from notify.js.
    initUiSound();
    // Background pre-warm of the user's watchlist. Runs after a short
    // delay so the main page render finishes first; each symbol is
    // analyzed sequentially with a small gap so we don't saturate the
    // network. Subsequent clicks on a watched symbol then render
    // instantly from cache (stale-while-revalidate, 2 min freshness).
    // Silent on failure — a broken upstream just means the symbol
    // loads cold on click instead of warm.
    prewarmWatchlist().catch(() => {});
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
