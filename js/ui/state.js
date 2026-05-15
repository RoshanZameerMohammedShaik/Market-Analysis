// Centralised UI state. One module, one source of truth for cross-cutting
// fields (active tab, timeframe, currently-loaded symbol). Persisted bits
// are read at construction; everything else lives in memory.

function loadTheme() {
    try {
        const saved = localStorage.getItem('ma-theme');
        // Migrate users who had the old 'colourful' theme to dark.
        if (saved === 'colourful') {
            localStorage.setItem('ma-theme', 'dark');
            return 'dark';
        }
        if (saved === 'dark' || saved === 'light' || saved === 'terminal') return saved;
    } catch (_) {}
    return 'dark';
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
};

export function nextHotPicksId() {
    state.hotPicksRequestId += 1;
    return state.hotPicksRequestId;
}
