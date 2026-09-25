// What a trade actually costs, in the browser. MIRROR of bot/broker.py + trading_costs.py.
//
// ONE MODEL, TWO LANGUAGES
// -----------------------
// The paper desk charges fills through bot/broker.py (commission + SEC/FINRA pass-throughs) and
// trading_costs.py (spread + market impact). This file is the same numbers and the same formulas
// for the P&L calculator and the signal card, and tools/cost_sync_check.py fails the build if the
// two ever disagree. Two independent cost models is how this project once had two engines for one
// prediction; a calculator that charges differently from the desk would be the same bug.
//
// WHY THE CALCULATOR NEEDS THIS AT ALL
// -----------------------------------
// It used to be gross-only: shares x (sell - buy), no commission, no fees, no spread. That answers
// a question nobody trading real size asks. The questions that actually came up were "how many
// shares to clear $500 on a 10-cent move", "what does a penny of spread cost me", and "IBKR Pro or
// Public" -- and at retail size the costs are a large fraction of a small move. On 5,000 shares
// going 10.90 -> 11.00, IBKR Pro Tiered takes ~$37 of a $500 gross.

// ── commission plans (US stocks) ─────────────────────────────────────────────
export const PLANS = {
    'ibkr-pro-tiered':  { perShare: 0.0035, minOrder: 0.35, maxPct: 1.0, label: 'IBKR Pro · Tiered', note: '$0.0035/share, $0.35 min' },
    'ibkr-pro-fixed':   { perShare: 0.005,  minOrder: 1.00, maxPct: 1.0, label: 'IBKR Pro · Fixed',  note: '$0.005/share, $1.00 min' },
    'ibkr-lite':        { perShare: 0.0,    minOrder: 0.0,  maxPct: 0.0, label: 'IBKR Lite',         note: '$0, routed for order flow' },
    'public-wholesale': { perShare: 0.0,    minOrder: 0.0,  maxPct: 0.0, label: 'Public · Wholesale', note: '$0, routed to wholesalers' },
    'public-smart':     { perShare: 0.003,  minOrder: 0.0,  maxPct: 0.0, label: 'Public · Smart route', note: '$0.003/share' },
    'public-lit':       { perShare: 0.003,  minOrder: 0.0,  maxPct: 0.0, label: 'Public · Lit only',  note: '$0.003/share' },
};
export const DEFAULT_PLAN = 'ibkr-pro-tiered';

// ── regulatory pass-throughs (sells only) ───────────────────────────────────
// SEC Section 31: $20.60 per $1,000,000 of sale proceeds, effective 2026-04-04 (SEC FY2026 advisory).
export const SEC_FEE_PCT = 0.00206;
// FINRA Trading Activity Fee: per share sold, capped per order.
export const FINRA_TAF_PER_SHARE = 0.000166;
export const FINRA_TAF_MAX = 8.30;

// ── spread + impact (trading_costs.py) ───────────────────────────────────────
// Effective HALF-spread, percent of notional, one side, by price. Used only when there is no live
// quote: price is a crude proxy for depth, and these tiers deliberately round against us.
export const HALF_SPREAD_PCT = [
    [0.01, 5.00],
    [0.10, 2.50],
    [1.00, 1.20],
    [5.00, 0.35],
    [20.00, 0.12],
    [100.00, 0.04],
    [Infinity, 0.02],
];
export const SLIPPAGE_PCT = 0.05;
export const CRYPTO_SPREAD_MULTIPLIER = 2.5;

const r6 = (x) => +Number(x).toFixed(6);

/** Broker commission for ONE order. Never negative, never above the plan's cap. */
export function commissionUSD(units, price, plan = DEFAULT_PLAN) {
    const cfg = PLANS[plan] || PLANS[DEFAULT_PLAN];
    const shares = Math.abs(Number(units));
    const value = shares * Math.abs(Number(price));
    if (!(shares > 0) || !(value > 0)) return 0;
    if (cfg.perShare <= 0 && cfg.minOrder <= 0) return 0;
    let fee = Math.max(shares * cfg.perShare, cfg.minOrder);
    if (cfg.maxPct > 0) fee = Math.min(fee, value * cfg.maxPct / 100);
    return r6(fee);
}

/** SEC Section 31 + FINRA TAF. Sells only; a buy pays neither. */
export function regulatoryUSD(units, price, side) {
    if (String(side).toUpperCase() !== 'SELL') return 0;
    const shares = Math.abs(Number(units));
    const proceeds = shares * Math.abs(Number(price));
    const sec = proceeds * SEC_FEE_PCT / 100;
    const taf = Math.min(shares * FINRA_TAF_PER_SHARE, FINRA_TAF_MAX);
    return r6(sec + taf);
}

/** Estimated half-spread for one side, percent. null for an unusable price. */
export function halfSpreadPct(price, crypto = false) {
    const p = Number(price);
    if (!(p > 0)) return null;
    let base = HALF_SPREAD_PCT[HALF_SPREAD_PCT.length - 1][1];
    for (const [ceiling, half] of HALF_SPREAD_PCT) {
        if (p < ceiling) { base = half; break; }
    }
    return crypto ? base * CRYPTO_SPREAD_MULTIPLIER : base;
}

export function sideCostPct(price, crypto = false) {
    const h = halfSpreadPct(price, crypto);
    return h == null ? null : h + SLIPPAGE_PCT;
}

export function roundTripCostPct(price, crypto = false) {
    const s = sideCostPct(price, crypto);
    return s == null ? null : 2 * s;
}

/**
 * Half-spread from a LIVE quote, percent of the midpoint.
 *
 * Refuses anything that is not a real two-sided market: a missing side, a crossed book, or a
 * spread wider than 20% of mid. Outside regular hours a quote can carry a stale bid against a fresh
 * ask, and turning that into a "measured" cost would be worse than the honest estimate it replaces.
 */
export function quotedHalfSpreadPct(bid, ask) {
    const b = Number(bid), a = Number(ask);
    if (!(b > 0) || !(a > 0) || a < b) return null;
    const mid = (a + b) / 2;
    const pct = ((a - b) / 2) / mid * 100;
    return pct <= 10 ? pct : null;
}

/**
 * Full cost breakdown for a round trip, and optionally the size needed to hit a target NET profit.
 *
 * orderType:
 *   'limit'  -- you fill AT the prices you entered. No spread is paid; the risk is not getting filled.
 *   'market' -- you buy at the ask and sell at the bid, plus the impact allowance per side. Uses the
 *               live quoted spread when one is supplied, else the price-tier estimate.
 *
 * Size precedence: targetNetUSD, then shares, then investment. Stocks trade whole shares; crypto
 * is fractional.
 */
export function planTrade({
    buyPrice, sellPrice,
    shares = null, investment = null, targetNetUSD = null,
    plan = DEFAULT_PLAN, orderType = 'limit', crypto = false,
    liveHalfSpreadPct = null,
} = {}) {
    const buy = Number(buyPrice), sell = Number(sellPrice);
    if (!(buy > 0) || !(sell > 0)) return { ok: false, error: 'Enter a purchase price and a sell price above zero.' };

    const market = orderType === 'market';
    const live = market && Number.isFinite(liveHalfSpreadPct) && liveHalfSpreadPct >= 0;
    const halfPct = !market ? 0 : (live ? liveHalfSpreadPct : halfSpreadPct(buy, crypto));
    const impactPct = market ? SLIPPAGE_PCT : 0;

    const costsFor = (s, sellAt = sell) => {
        const commBuy = crypto ? 0 : commissionUSD(s, buy, plan);
        const commSell = crypto ? 0 : commissionUSD(s, sellAt, plan);
        const reg = crypto ? 0 : regulatoryUSD(s, sellAt, 'SELL');
        const spread = s * (buy + sellAt) * (halfPct / 100);
        const impact = s * (buy + sellAt) * (impactPct / 100);
        const gross = s * (sellAt - buy);
        const total = commBuy + commSell + reg + spread + impact;
        return { commBuy, commSell, reg, spread, impact, gross, total, net: gross - total };
    };

    let s;
    let target = null;
    if (Number.isFinite(Number(targetNetUSD)) && Number(targetNetUSD) > 0) {
        const want = Number(targetNetUSD);
        // Net per share at size, ignoring per-order minimums: the move, less every per-share and
        // per-dollar cost. If that is not positive, no quantity reaches the target -- say so rather
        // than returning a nonsense share count.
        const perShareMargin = (sell - buy)
            - (crypto ? 0 : 2 * ((PLANS[plan] || PLANS[DEFAULT_PLAN]).perShare))
            - (crypto ? 0 : sell * SEC_FEE_PCT / 100 + FINRA_TAF_PER_SHARE)
            - (buy + sell) * ((halfPct + impactPct) / 100);
        if (!(perShareMargin > 0)) {
            return {
                ok: false,
                error: sell <= buy
                    ? 'The sell price is not above the purchase price, so no size makes a profit.'
                    : 'Costs per share are larger than the move, so no size reaches that profit.',
            };
        }
        // Binary search on size: net(s) is non-decreasing once the per-share margin is positive, and
        // the per-order minimums and the TAF cap make a closed form wrong at small and large sizes.
        const step = crypto ? 1e-6 : 1;
        let lo = step, hi = Math.max(step, Math.ceil((want / perShareMargin) * 2 / step) * step);
        while (costsFor(hi).net < want && hi < 1e12) hi *= 2;
        for (let i = 0; i < 200 && hi - lo > step; i++) {
            const mid = Math.round(((lo + hi) / 2) / step) * step;
            if (costsFor(mid).net >= want) hi = mid; else lo = mid;
        }
        s = costsFor(lo).net >= want ? lo : hi;
        target = { wantUSD: want, sharesNeeded: s };
    } else if (Number(shares) > 0) {
        s = Number(shares);
    } else if (Number(investment) > 0) {
        s = crypto ? Number(investment) / buy : Math.floor(Number(investment) / buy);
        if (!(s > 0)) return { ok: false, error: `That amount does not buy one share at ${buy}.` };
    } else {
        return { ok: false, error: 'Enter an investment amount or a target profit.' };
    }

    const c = costsFor(s);

    // Break-even sell price for THIS size: the lowest exit where net is not negative.
    let beLo = buy, beHi = Math.max(buy * 2, sell);
    for (let i = 0; i < 80; i++) {
        const mid = (beLo + beHi) / 2;
        if (costsFor(s, mid).net >= 0) beHi = mid; else beLo = mid;
    }

    return {
        ok: true,
        shares: s,
        capitalUSD: s * buy,
        grossUSD: c.gross,
        commissionBuyUSD: c.commBuy,
        commissionSellUSD: c.commSell,
        regulatoryUSD: c.reg,
        spreadUSD: c.spread,
        impactUSD: c.impact,
        totalCostUSD: c.total,
        netUSD: c.net,
        netPct: (c.net / (s * buy)) * 100,
        // What fraction of the gross move the costs consumed -- the number that decides whether a
        // small-move strategy is worth running at all.
        costShareOfGrossPct: c.gross > 0 ? (c.total / c.gross) * 100 : null,
        breakEvenSell: beHi,
        spreadSource: !market ? 'none (limit orders)' : live ? 'live quote' : 'estimate',
        halfSpreadPct: halfPct,
        target,
        plan,
        orderType: market ? 'market' : 'limit',
        crypto,
    };
}
