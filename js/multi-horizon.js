// Multi-horizon expected-move predictor. Answers "how much will it spike?".
//
// Approach:
//   E[move at horizon h] = sign(signal) * ATR_pct * sqrt(h) * regime_mult * strength_mult
//
// Where:
//   ATR_pct        = current ATR / current price * 100  (daily expected range)
//   sqrt(h)        = volatility scales with sqrt(time) by random-walk theory
//   regime_mult    = 0.7 (low VIX) | 1.0 (mid) | 1.3 (high)
//   strength_mult  = 0.5 (38% conf) -> 1.5 (88% conf), linear
//
// Conformal interval at horizon h: existing 1d interval * sqrt(h).
//
// We do not predict the direction here — the engine already does. We
// only translate "BUY" + confidence into an expected magnitude band.

const HORIZONS = [
    { id: '1d', days: 1, label: '1 day' },
    { id: '3d', days: 3, label: '3 days' },
    { id: '5d', days: 5, label: '1 week' },
    { id: '20d', days: 20, label: '1 month' },
];

function regimeMult(volTier) {
    if (volTier === 'low') return 0.7;
    if (volTier === 'high') return 1.3;
    return 1.0;
}

function strengthMult(confidence) {
    // confidence is 38..88; map to 0.5..1.5 linearly.
    const c = Math.max(38, Math.min(88, confidence || 50));
    return 0.5 + (c - 38) / 50;
}

/**
 * @param {Object} args
 *  - signal: 'BUY' | 'SELL' | 'NEUTRAL'
 *  - confidence: number
 *  - atr: ATR (price units)
 *  - currentPrice: number
 *  - volTier: 'low'|'mid'|'high'|null
 *  - conformal1d: { lo_pct, hi_pct } | null  (existing 1d interval)
 */
export function predictMultiHorizon({ signal, confidence, atr, currentPrice, volTier, conformal1d }) {
    if (!atr || !currentPrice || atr <= 0 || currentPrice <= 0) return null;
    if (signal !== 'BUY' && signal !== 'SELL') return null;

    const atrPct = (atr / currentPrice) * 100;
    const dir = signal === 'BUY' ? 1 : -1;
    const rMult = regimeMult(volTier);
    const sMult = strengthMult(confidence);

    const out = HORIZONS.map(h => {
        const sqrtH = Math.sqrt(h.days);
        const expectedPct = dir * atrPct * sqrtH * rMult * sMult;
        let interval = null;
        if (conformal1d) {
            const lo = conformal1d.lo_pct * sqrtH;
            const hi = conformal1d.hi_pct * sqrtH;
            interval = { lo_pct: +lo.toFixed(2), hi_pct: +hi.toFixed(2) };
        }
        return {
            id: h.id,
            label: h.label,
            days: h.days,
            expectedPct: +expectedPct.toFixed(2),
            targetPrice: +(currentPrice * (1 + expectedPct / 100)).toFixed(2),
            interval,
        };
    });

    return { horizons: out, regimeMult: rMult, strengthMult: sMult };
}
