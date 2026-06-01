// Candlestick skeleton loader markup. Used during the multi-second
// "Running full analysis…" wait so the loader visually communicates
// "we are computing a market chart" rather than the generic spinner.
//
// Random up/down per bar (deterministic-ish based on index) so the
// pattern looks like a real chart, not a uniform animation.

export function candleLoaderHTML(n = 7) {
    const bars = [];
    // Strict alternation: green, red, green, red, … Roshan asked for
    // the cleaner rhythm over the irregular price-action pattern that
    // was here before.
    for (let i = 0; i < n; i++) {
        const cls = i % 2 === 0 ? 'up' : 'down';
        bars.push(`<span class="cl-bar ${cls}"><span class="cl-wick"></span><span class="cl-body"></span></span>`);
    }
    return `<div class="candle-loader" aria-label="Loading market data" role="progressbar">${bars.join('')}</div>`;
}
