// Candlestick skeleton loader markup. Used during the multi-second
// "Running full analysis…" wait so the loader visually communicates
// "we are computing a market chart" rather than the generic spinner.
//
// Random up/down per bar (deterministic-ish based on index) so the
// pattern looks like a real chart, not a uniform animation.

export function candleLoaderHTML(n = 7) {
    const bars = [];
    // Alternating-ish pattern with a couple flips so the loader looks
    // like an actual price-action sequence, not a regular oscillation.
    const dirSeq = ['up', 'up', 'down', 'up', 'down', 'down', 'up', 'down', 'up'];
    for (let i = 0; i < n; i++) {
        const cls = dirSeq[i % dirSeq.length];
        bars.push(`<span class="cl-bar ${cls}"><span class="cl-wick"></span><span class="cl-body"></span></span>`);
    }
    return `<div class="candle-loader" aria-label="Loading market data" role="progressbar">${bars.join('')}</div>`;
}
