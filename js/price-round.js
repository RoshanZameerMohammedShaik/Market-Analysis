/**
 * Magnitude-aware price rounding. THE one browser implementation.
 *
 * Mirror of price_round.py; tools/band_sync_check.py fails the build if the two
 * disagree. See that file for the full history. Short version: a fixed number of
 * decimal places destroys sub-penny prices, and 51 of 1,053 live symbols are
 * sub-penny, including SHIB, BONK and FLOKI.
 *
 * js/analysis.js used `+predictedHigh.toFixed(2)`, so every price target on a
 * sub-dollar asset was quantised to the cent and every target on a sub-penny
 * asset became 0.00: a zero-width range, which can only ever score as a hit.
 */
const SIG_FIGS_BELOW_CENT = 6;

/** Round a price for storage or display, never collapsing it to zero. */
export function roundPrice(v, sig = SIG_FIGS_BELOW_CENT) {
    const f = Number(v);
    if (v === null || v === undefined || !Number.isFinite(f)) return null;
    const av = Math.abs(f);
    if (av === 0) return 0;
    if (av >= 1) return +f.toFixed(2);
    if (av >= 0.01) return +f.toFixed(4);
    // Significant figures, not decimal places: a flat 8dp still collapses at 1e-9.
    return +f.toFixed(Math.min(100, -Math.floor(Math.log10(av)) + (sig - 1)));
}

/** Display decimals appropriate to `price`, matching the roundPrice ladder. */
export function decimalsFor(price) {
    const av = Math.abs(Number(price));
    if (!Number.isFinite(av) || av === 0) return 2;
    if (av >= 1) return 2;
    if (av >= 0.01) return 4;
    return Math.min(12, -Math.floor(Math.log10(av)) + (SIG_FIGS_BELOW_CENT - 1));
}
