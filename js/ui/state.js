// Shared mutable UI state. Modules import this rather than passing state
// through every call. Keep the surface small.

export const state = {
    mode: 'stock',
    timeframe: 'today',
    theme: localStorage.getItem('ma-theme') || 'dark',
    currentSymbol: null,
    currentCoinId: null,
    currentPrice: null,
    cryptoCache: {},
    hotPicksRequestId: 0,
};

export function nextHotPicksId() {
    return ++state.hotPicksRequestId;
}
