// Position sizing and exposure control, sized off measured volatility.
//
// THE DESIGN RULE THAT SHAPES THIS WHOLE FILE: size on RISK, never on EDGE.
//
// There is no `expectedReturn` parameter anywhere in here, and that is
// deliberate. Backtest Sharpe predicts live Sharpe with R^2 = 0.02 (Quantopian,
// 888 algorithms, hash-timestamped out-of-sample boundary). Volatility predicts
// live volatility at R^2 = 0.67 and max drawdown at 0.34. So the only inputs
// worth sizing from are the ones that actually carry over. Accepting an expected
// return would invite plugging in a number this app has no way to verify, which
// is exactly how it ended up displaying 76% accuracy on a coin flip.
//
// Stops come from model/band_calibration.json stopZ, which is the measured
// one-sided distance the low reaches, not a guessed ATR multiple. A stop at the
// 0.90 curve survives 90% of holds, and that number was solved from 70,861
// observations rather than assumed.

import { loadBandCalibration, rangeSigma } from './forecast-band.js';

// Never bet the balance. A ~50% win-rate series compounded at full size goes to
// zero regardless of edge: the app's own 1-day equity curve showed -99.6% purely
// as a position-sizing artifact before it was switched to fixed-fractional.
export const DEFAULTS = {
    riskPctPerTrade: 1.0,     // % of equity risked between entry and stop
    maxPositionPct: 25.0,     // hard cap on notional as % of equity
    maxPortfolioHeatPct: 5.0, // cap on summed open risk
    stopSurvival: 0.90,       // stop should survive 90% of holds
    targetAnnualVol: 15.0,    // for the volatility-targeting path
    killDrawdownPct: 20.0,
    kellyFraction: 0.25,      // fractional Kelly; full Kelly on an ESTIMATED edge is ruinous
};

function tierFor(sigma, edges) {
    for (const [lo, hi, name] of edges) if (sigma >= lo && sigma < hi) return name;
    return edges[edges.length - 1][2];
}

/**
 * Stop price whose breach probability is measured, not assumed.
 * Returns null when calibration is unavailable: a stop we cannot justify is
 * worse than no stop, because it silently mis-sizes every position built on it.
 */
export function stopFromCalibration({ candles, price, horizonDays = 5,
                                      survival = DEFAULTS.stopSurvival, cal = null }) {
    const c = cal || null;
    if (!c || !c.stopZ) return null;
    const sigma = rangeSigma(candles, c.volLookbackDays || 30);
    if (!sigma || !(price > 0)) return null;
    const tier = tierFor(sigma, c.tierEdges);
    const curve = c.stopZ?.[tier]?.[String(horizonDays)];
    if (!curve) return null;
    const key = Number(survival).toFixed(2);
    const z = curve[key];
    if (z === undefined) {
        return { error: `no calibration at survival ${key}`, available: Object.keys(curve) };
    }
    const dist = z * sigma * Math.sqrt(horizonDays);
    return {
        stop: +(price * Math.exp(-dist)).toFixed(price < 1 ? 4 : 2),
        stopDistPct: +((1 - Math.exp(-dist)) * 100).toFixed(2),
        survival: Number(survival),
        z, sigmaDaily: +(sigma * 100).toFixed(2), volTier: tier, horizonDays,
    };
}

/**
 * Fixed-fractional sizing. shares = (equity * risk%) / (entry - stop).
 * Clamped by maxPositionPct so a tight stop cannot produce an absurd notional.
 */
export function sizePosition({ equity, entry, stop,
                               riskPctPerTrade = DEFAULTS.riskPctPerTrade,
                               maxPositionPct = DEFAULTS.maxPositionPct,
                               fractional = false, minUnit = null }) {
    if (!(equity > 0) || !(entry > 0) || !(stop > 0) || stop >= entry) return null;
    const riskPerShare = entry - stop;
    const riskBudget = equity * (riskPctPerTrade / 100);

    // Equities trade in whole shares; crypto does not. Flooring BTC to an integer
    // returns 0 units on any normal retail account (one BTC exceeds the position
    // cap outright), which silently blocks every crypto position. `fractional`
    // rounds down to `minUnit` instead, default 1e-8 (one satoshi).
    const unit = fractional ? (minUnit ?? 1e-8) : 1;
    const quantize = (x) => Math.floor(x / unit) * unit;

    let shares = quantize(riskBudget / riskPerShare);
    const capShares = quantize(equity * (maxPositionPct / 100) / entry);
    const capped = shares > capShares;
    if (capped) shares = capShares;

    const notional = shares * entry;
    const dollarRisk = shares * riskPerShare;
    // Always return the full shape, even at zero size. An object missing fields
    // renders as "$undefined" downstream, which reads like a data problem rather
    // than the intended "this position is too small to take".
    const out = {
        shares: fractional ? +shares.toFixed(8) : shares,
        notional: +notional.toFixed(2),
        dollarRisk: +dollarRisk.toFixed(2),
        riskPctActual: +(dollarRisk / equity * 100).toFixed(2),
        positionPct: +(notional / equity * 100).toFixed(2),
        cappedByMaxPosition: capped,
        fractional,
    };
    if (shares < unit) {
        out.reason = fractional
            ? 'position rounds below the minimum tradable unit'
            : 'risk budget is smaller than one whole share at this stop distance; ' +
              'enable fractional sizing or reduce the stop distance';
    }
    return out;
}

/**
 * Volatility targeting: size so the position contributes a chosen annualised
 * volatility. This is the sizing method whose input actually persists out of
 * sample, which is why it is here alongside fixed-fractional.
 */
export function sizeByVolTarget({ equity, price, candles,
                                  targetAnnualVol = DEFAULTS.targetAnnualVol,
                                  maxPositionPct = DEFAULTS.maxPositionPct, cal = null,
                                  fractional = false, minUnit = null }) {
    const sigma = rangeSigma(candles, cal?.volLookbackDays || 30);
    if (!sigma || !(equity > 0) || !(price > 0)) return null;
    const annVol = sigma * Math.sqrt(252);
    const targetFrac = Math.min((targetAnnualVol / 100) / annVol, maxPositionPct / 100);
    const unit = fractional ? (minUnit ?? 1e-8) : 1;
    const raw = equity * targetFrac / price;
    const shares = Math.floor(raw / unit) * unit;
    return {
        shares: fractional ? +shares.toFixed(8) : shares,
        notional: +(shares * price).toFixed(2),
        positionPct: +(shares * price / equity * 100).toFixed(2),
        assetAnnualVol: +(annVol * 100).toFixed(1),
        targetAnnualVol,
        cappedByMaxPosition: (targetAnnualVol / 100) / annVol > maxPositionPct / 100,
    };
}

/** Summed open risk. Blocks new entries past the heat cap. */
export function portfolioHeat({ equity, positions = [],
                                maxPortfolioHeatPct = DEFAULTS.maxPortfolioHeatPct }) {
    if (!(equity > 0)) return null;
    let risk = 0, notional = 0;
    for (const p of positions) {
        const sh = Number(p.shares) || 0;
        const e = Number(p.entry) || 0;
        const s = Number(p.stop) || 0;
        if (sh > 0 && e > s && s > 0) risk += sh * (e - s);
        notional += sh * e;
    }
    const heatPct = risk / equity * 100;
    return {
        heatPct: +heatPct.toFixed(2),
        grossExposurePct: +(notional / equity * 100).toFixed(2),
        dollarRisk: +risk.toFixed(2),
        maxPortfolioHeatPct,
        overHeat: heatPct > maxPortfolioHeatPct,
        remainingRiskBudget: +Math.max(0, equity * (maxPortfolioHeatPct / 100) - risk).toFixed(2),
    };
}

/** Drawdown kill switch. Halts NEW entries; it does not close anything. */
export function killSwitch({ peakEquity, currentEquity,
                             killDrawdownPct = DEFAULTS.killDrawdownPct }) {
    if (!(peakEquity > 0) || !(currentEquity > 0)) return null;
    // Compare the ROUNDED drawdown, not the raw float. (1 - 80/100) * 100 is
    // 19.999999999999996 in IEEE 754, so a raw `>=` comparison silently fails to
    // trip the switch at exactly the threshold. A kill switch that does not fire
    // on the boundary is worse than no kill switch, because it reports headroom
    // of 0.00% while still permitting entries.
    const ddRaw = (1 - currentEquity / peakEquity) * 100;
    const dd = +ddRaw.toFixed(2);
    return {
        drawdownPct: dd,
        killDrawdownPct,
        halted: dd >= killDrawdownPct,
        headroomPct: +Math.max(0, killDrawdownPct - dd).toFixed(2),
    };
}

/**
 * Fractional Kelly, gated on statistical power.
 *
 * This REFUSES to return a fraction when the sample is too small to tell the
 * observed win rate apart from a coin flip at 95% confidence. Distinguishing 53%
 * from 50% needs 1,068 independent trades; 52% needs 2,401. Without that gate,
 * Kelly happily sizes a position off 20 lucky trades, and full Kelly on an
 * overestimated edge is the classic route to ruin.
 */
export function kellyFraction({ winRate, payoffRatio, n,
                                fraction = DEFAULTS.kellyFraction }) {
    if (!(winRate > 0 && winRate < 1) || !(payoffRatio > 0) || !(n > 0)) return null;
    const edge = winRate - 0.5;
    if (Math.abs(edge) < 1e-9) {
        return { fractionOfEquity: 0, reason: 'win rate is exactly a coin flip' };
    }
    const nRequired = Math.ceil((1.96 * 0.5 / edge) ** 2);
    if (n < nRequired) {
        return {
            fractionOfEquity: 0,
            reason: `sample too small: ${n} trades cannot distinguish a ` +
                    `${(winRate * 100).toFixed(1)}% win rate from 50% at 95% confidence`,
            tradesRequired: nRequired,
        };
    }
    // f* = p - (1-p)/b
    const full = winRate - (1 - winRate) / payoffRatio;
    if (full <= 0) {
        return { fractionOfEquity: 0, reason: 'Kelly is non-positive: no bet is the correct size' };
    }
    return {
        fractionOfEquity: +Math.min(full * fraction, DEFAULTS.maxPositionPct / 100).toFixed(4),
        fullKelly: +full.toFixed(4),
        fractionUsed: fraction,
        tradesRequired: nRequired,
        n,
    };
}

/**
 * One call that assembles the whole decision for a candidate position.
 * Returns `allowed:false` with a reason rather than a number whenever any gate
 * fails, so a caller cannot accidentally trade an unjustified size.
 */
export async function assessPosition({ equity, price, candles, horizonDays = 5,
                                       openPositions = [], peakEquity = null,
                                       fractional = false, minUnit = null,
                                       opts = {} }) {
    const cal = await loadBandCalibration();
    const o = { ...DEFAULTS, ...opts };
    const gates = [];

    const kill = peakEquity
        ? killSwitch({ peakEquity, currentEquity: equity, killDrawdownPct: o.killDrawdownPct })
        : null;
    if (kill?.halted) gates.push(`drawdown ${kill.drawdownPct}% at or past the ${o.killDrawdownPct}% kill switch`);

    const heat = portfolioHeat({ equity, positions: openPositions,
                                 maxPortfolioHeatPct: o.maxPortfolioHeatPct });
    if (heat?.overHeat) gates.push(`portfolio heat ${heat.heatPct}% over the ${o.maxPortfolioHeatPct}% cap`);

    const st = stopFromCalibration({ candles, price, horizonDays,
                                     survival: o.stopSurvival, cal });
    if (!st || st.error) gates.push(st?.error || 'no calibrated stop available for this tier and horizon');

    const sized = st && !st.error
        ? sizePosition({ equity, entry: price, stop: st.stop,
                         riskPctPerTrade: o.riskPctPerTrade, maxPositionPct: o.maxPositionPct,
                         fractional, minUnit })
        : null;
    const volSized = sizeByVolTarget({ equity, price, candles,
                                       targetAnnualVol: o.targetAnnualVol,
                                       maxPositionPct: o.maxPositionPct, cal,
                                       fractional, minUnit });

    if (sized?.reason) gates.push(sized.reason);
    return {
        allowed: gates.length === 0 && !!sized?.shares,
        blockedBy: gates,
        stop: st, fixedFractional: sized, volTargeted: volSized,
        heat, kill,
        calibrated: !!cal?.stopZ && !cal._fallback,
    };
}
