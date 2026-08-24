// The 7-day High/Low forecast panel.
//
// What it shows: for each of the next 7 sessions, an expected Low, an expected
// High, and a confidence that has been MEASURED rather than asserted (80%
// claimed, 80.0% realized across 56 tier/horizon cells, 70k+ observations).
//
// What it deliberately does NOT show: direction. Which edge of the band price
// ends up nearer is the coin flip this app cannot call (49.5% on correctly
// graded rows). Every label here is written to avoid implying otherwise.
//
// Replaces the multi-horizon block, which reused ONE direction for every horizon
// and scaled magnitude by a hand-picked confidence multiplier.

const CUR = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥',
              HKD: 'HK$', AUD: 'A$' };

function money(v, cur) {
    if (!Number.isFinite(v)) return '—';
    const sym = CUR[cur] || '';
    // Sub-dollar names need more precision or every row reads the same.
    const dp = Math.abs(v) < 1 ? 4 : 2;
    return sym + v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function dayLabel(iso, idx) {
    if (idx === 0) return 'Today';
    if (idx === 1) return 'Tomorrow';
    try {
        const d = new Date(iso + 'T00:00:00Z');
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (_) { return iso; }
}

/**
 * @param {Object} band  the `forecastBand` object from computeFullConfidence
 * @param {Object} opts  { currency, currentPrice }
 * @returns {string} HTML, or '' when there is nothing trustworthy to show
 */
export function renderForecastBand(band, { currency = 'USD', currentPrice = null } = {}) {
    if (!band || !Array.isArray(band.days) || !band.days.length) return '';

    // Refuse to print a confidence we cannot stand behind. An uncalibrated band
    // still has a shape, but the percentage would be a guess, and a guessed
    // percentage next to a price is exactly how this app previously came to
    // display 76% accuracy on a coin flip.
    const calibrated = band.calibrated === true;

    const rows = band.days.map((d, i) => {
        const spanPct = currentPrice > 0
            ? ((d.high - d.low) / currentPrice * 100) : null;
        return `
            <tr class="fb-row">
                <td class="fb-day">${dayLabel(d.date, i)}</td>
                <td class="fb-low">${money(d.low, currency)}</td>
                <td class="fb-high">${money(d.high, currency)}</td>
                <td class="fb-span">${spanPct != null ? `±${(spanPct / 2).toFixed(1)}%` : '—'}</td>
            </tr>`;
    }).join('');

    const conf = calibrated
        ? `<span class="fb-conf-value">${band.confidence}%</span>`
        : `<span class="fb-conf-value fb-uncal" title="No calibration loaded for this volatility tier, so no confidence can be stated honestly.">not calibrated</span>`;

    const tierNote = band.volTier
        ? `<span class="fb-tier" title="Assigned from this symbol's own recent volatility, so it moves as the symbol does.">${band.volTier} · ${band.sigmaDaily}%/day</span>`
        : '';

    return `
        <div class="forecast-band-section">
            <div class="fb-head">
                <span class="fb-title">Expected trading range, next 7 sessions</span>
                ${tierNote}
            </div>
            <table class="fb-table">
                <thead>
                    <tr>
                        <th class="fb-day">Day</th>
                        <th class="fb-low">Expected low</th>
                        <th class="fb-high">Expected high</th>
                        <th class="fb-span">Width</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="fb-foot">
                <div class="fb-conf">
                    Confidence ${conf}
                    <span class="fb-conf-note">that each day's high and low both land inside its row</span>
                </div>
                <div class="fb-caveat">
                    Range only. This does <strong>not</strong> predict whether price rises or falls,
                    and the band widens with time because uncertainty grows.
                    Coverage is a long-run average: when volatility jumps sharply after the band is
                    set, it holds far less often.
                </div>
            </div>
        </div>`;
}
