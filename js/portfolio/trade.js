// Trade execution layer. Thin wrapper around state.js + pricing.js that
// handles the user-facing "buy $X of NVDA" / "sell N units of BTC-USD"
// shapes, fetches the live fill price, and writes the resulting BUY or
// SELL into the portfolio state.
//
// Long-only enforced in state.js. Fractional units are the default.
//
// All inputs are validated at this layer so the UI / Mia tool / any other
// caller sees consistent error messages instead of bubbling state.js's
// internal Errors verbatim.

import { recordBuy, recordSell, getPortfolio, isInstantiated, avgCostBasisUSD } from './state.js';
import { getCurrentPrice, isCryptoSymbol } from './pricing.js';

// Place a market BUY. `quote` is { mode: 'amountUSD', value } OR
// { mode: 'units', value } — supports both "buy $250 of X" and
// "buy 0.5 X". priceOverrideUSD is for testing only.
export async function buy(symbol, quote, priceOverrideUSD = null) {
    if (!isInstantiated()) throw new Error('Load a portfolio first.');
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error('Symbol required.');
    const price = priceOverrideUSD != null ? Number(priceOverrideUSD) : await getCurrentPrice(sym);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Couldn't get a live price for ${sym}.`);

    let units;
    if (quote.mode === 'amountUSD') {
        const amt = Number(quote.value);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('Buy amount must be > 0.');
        units = amt / price;
    } else if (quote.mode === 'units') {
        units = Number(quote.value);
        if (!Number.isFinite(units) || units <= 0) throw new Error('Units must be > 0.');
    } else {
        throw new Error('Quote mode must be "amountUSD" or "units".');
    }

    const cost = units * price;
    const cash = getPortfolio().cashUSD;
    if (cost > cash + 1e-6) {
        throw new Error(`Insufficient cash: trade needs $${cost.toFixed(2)} USD, you have $${cash.toFixed(2)}.`);
    }

    const result = recordBuy({ symbol: sym, units, priceUSD: price });
    return {
        symbol: sym, side: 'BUY', units, fillPriceUSD: price,
        costUSD: result.costUSD, cashRemainingUSD: result.cashRemainingUSD,
    };
}

// Place a market SELL. quote.mode='units' or 'amountUSD' or 'all'.
// 'all' liquidates the entire position — convenient for "exit AAPL".
export async function sell(symbol, quote, priceOverrideUSD = null) {
    if (!isInstantiated()) throw new Error('Load a portfolio first.');
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error('Symbol required.');
    const pos = getPortfolio().positions[sym];
    if (!pos || pos.units < 1e-9) throw new Error(`You don't hold any ${sym} to sell.`);

    const price = priceOverrideUSD != null ? Number(priceOverrideUSD) : await getCurrentPrice(sym);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Couldn't get a live price for ${sym}.`);

    let units;
    if (quote.mode === 'all') {
        units = pos.units;
    } else if (quote.mode === 'units') {
        units = Number(quote.value);
        if (!Number.isFinite(units) || units <= 0) throw new Error('Units must be > 0.');
    } else if (quote.mode === 'amountUSD') {
        const amt = Number(quote.value);
        if (!Number.isFinite(amt) || amt <= 0) throw new Error('Sell amount must be > 0.');
        units = amt / price;
    } else {
        throw new Error('Quote mode must be "amountUSD", "units", or "all".');
    }
    if (units > pos.units + 1e-9) {
        throw new Error(`You only hold ${pos.units} ${sym}; can't sell ${units}. (Long-only — no shorting.)`);
    }

    const result = recordSell({ symbol: sym, units, priceUSD: price });
    return {
        symbol: sym, side: 'SELL', units, fillPriceUSD: price,
        proceedsUSD: result.proceedsUSD, realizedUSD: result.realizedUSD,
        cashRemainingUSD: result.cashRemainingUSD,
    };
}

// Unrealized P&L for a single held position at a given current price.
// priceUSD is the live price; caller (UI) supplies it from a subscription
// so this stays a pure function (no fetch inside hot render path).
export function unrealizedPnL(symbol, priceUSD) {
    const sym = normalizeSymbol(symbol);
    const pos = getPortfolio().positions[sym];
    if (!pos || pos.units < 1e-9 || !Number.isFinite(priceUSD)) return null;
    const cost = avgCostBasisUSD(sym);
    if (cost == null) return null;
    const marketValue = pos.units * priceUSD;
    const totalCost = pos.units * cost;
    return {
        symbol: sym,
        units: pos.units,
        avgCostUSD: cost,
        currentPriceUSD: priceUSD,
        marketValueUSD: marketValue,
        unrealizedUSD: marketValue - totalCost,
        unrealizedPct: ((priceUSD - cost) / cost) * 100,
    };
}

function normalizeSymbol(symbol) {
    return String(symbol || '').toUpperCase().trim();
}

// Re-exports to give UI a single import surface.
export { isCryptoSymbol };
