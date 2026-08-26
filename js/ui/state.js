// Centralised UI state. One module, one source of truth for cross-cutting
// fields (active tab, timeframe, currently-loaded symbol). Persisted bits
// are read at construction; everything else lives in memory.

import { DEFAULT_THEME, normalizeTheme } from './themes.js';

// Theme validation delegates to js/ui/themes.js. This used to re-list the valid
// ids in an if-chain that had to be kept in step with theme.js by hand, so adding
// a theme in one place silently reset every user's choice to dark in the other.
function loadTheme() {
    try {
        const saved = localStorage.getItem('ma-theme');
        const resolved = normalizeTheme(saved);
        // Write the migration back so a retired id is only translated once.
        if (saved && saved !== resolved) localStorage.setItem('ma-theme', resolved);
        return resolved;
    } catch (_) {}
    return DEFAULT_THEME;
}

export const state = {
    mode: 'stock',
    timeframe: 'today',
    theme: loadTheme(),
    currentSymbol: null,
    currentCoinId: null,
    currentPrice: null,
    cryptoCache: {},
    hotPicksRequestId: 0,
    // Time-travel mode: when set to a YYYY-MM-DD string, the analysis
    // pipeline truncates fetched candles at this date and runs the
    // engine on what would have been visible then. null = live mode.
    timeTravelDate: null,
};

export function nextHotPicksId() {
    state.hotPicksRequestId += 1;
    return state.hotPicksRequestId;
}
