// Portfolio simulation — state model + localStorage persistence.
//
// Internal accounting is always in USD. The user's "display currency" is a
// label + an FX rate at instantiate-time (and a current FX rate fetched on
// demand for display). We do NOT recompute everything in the user's
// currency at runtime — that would compound rounding errors and make
// position-cost math weird across FX swings. Instead: cash and lot cost
// basis stored in USD; UI converts on render via the live FX rate.
//
// Lots are FIFO-tracked. A buy adds a lot; a sell consumes lots in
// purchase-order so cost basis and realized P&L are accurate.

const LS_KEY = 'ma-portfolio-v1';
const SCHEMA_VERSION = 1;

// In-memory mirror of localStorage. Read once on init, written through on
// every mutation. Avoids parse-on-every-read cost on the hot UI path.
let portfolio = null;

function emptyPortfolio() {
    return {
        schema: SCHEMA_VERSION,
        instantiated: false,
        currency: 'USD',     // display currency the user picked
        initialAmountUSD: 0, // their original deposit in USD terms
        initialAmountLocal: 0,
        initialFxRate: 1,    // local→USD at instantiation, frozen for return-pct calcs
        cashUSD: 0,
        // positions[symbol] = { units, lots: [{ units, costBasisUSD, openedAt }] }
        positions: {},
        // Append-only trade log for transparency / future analytics
        history: [],
        createdAt: null,
        updatedAt: null,
    };
}

function load() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return emptyPortfolio();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyPortfolio();
        // Forward-compat: if we ever bump schema, migrate here. For now just
        // ensure all expected top-level keys exist.
        const empty = emptyPortfolio();
        return { ...empty, ...parsed };
    } catch (_) {
        return emptyPortfolio();
    }
}

function save() {
    if (!portfolio) return;
    portfolio.updatedAt = new Date().toISOString();
    try { localStorage.setItem(LS_KEY, JSON.stringify(portfolio)); } catch (_) {}
    document.dispatchEvent(new CustomEvent('ma:portfolio-changed'));
}

export function initPortfolio() {
    portfolio = load();
}

export function getPortfolio() {
    if (!portfolio) initPortfolio();
    return portfolio;
}

export function isInstantiated() {
    return getPortfolio().instantiated === true;
}

// Reset to a fresh, un-instantiated state. Existing trade history is wiped
// — this is "start over" not "withdraw funds." History stays in the
// exported snapshot if user grabs one before reset.
export function resetPortfolio() {
    portfolio = emptyPortfolio();
    save();
}

// First-time setup. amount is in `currency`; we record both the local
// amount and its USD equivalent at the given rate so we can show the user
// a faithful return-pct in their own currency later.
export function instantiatePortfolio({ currency, amount, fxRateToUSD }) {
    const amt = Number(amount);
    const rate = Number(fxRateToUSD);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount.');
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid FX rate.');
    const usd = amt * rate;
    portfolio = emptyPortfolio();
    portfolio.instantiated = true;
    portfolio.currency = String(currency || 'USD').toUpperCase();
    portfolio.initialAmountLocal = amt;
    portfolio.initialAmountUSD = usd;
    portfolio.initialFxRate = rate;
    portfolio.cashUSD = usd;
    portfolio.createdAt = new Date().toISOString();
    portfolio.history.push({
        type: 'INSTANTIATE',
        currency: portfolio.currency,
        amount: amt,
        amountUSD: usd,
        fxRate: rate,
        ts: portfolio.createdAt,
    });
    save();
}

// Add more practice cash (after a bust or just because). Recorded in
// history with the FX rate used at the time so the user's lifetime
// "money in" is auditable.
export function addFunds({ currency, amount, fxRateToUSD }) {
    if (!isInstantiated()) throw new Error('Portfolio not instantiated.');
    const amt = Number(amount);
    const rate = Number(fxRateToUSD);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount.');
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid FX rate.');
    const usd = amt * rate;
    portfolio.cashUSD += usd;
    portfolio.history.push({
        type: 'ADD_FUNDS',
        currency: String(currency || portfolio.currency).toUpperCase(),
        amount: amt,
        amountUSD: usd,
        fxRate: rate,
        ts: new Date().toISOString(),
    });
    save();
}

// Buy: deduct cash, add a lot. units may be fractional. priceUSD is the
// fill price. Caller (trade.js) is responsible for sourcing the live
// price; this module just records the result.
export function recordBuy({ symbol, units, priceUSD }) {
    if (!isInstantiated()) throw new Error('Portfolio not instantiated.');
    const sym = String(symbol || '').toUpperCase();
    const u = Number(units);
    const p = Number(priceUSD);
    if (!sym) throw new Error('Symbol required.');
    if (!Number.isFinite(u) || u <= 0) throw new Error('Units must be > 0.');
    if (!Number.isFinite(p) || p <= 0) throw new Error('Price must be > 0.');
    const costUSD = u * p;
    if (costUSD > portfolio.cashUSD + 1e-6) throw new Error('Insufficient cash.');
    portfolio.cashUSD -= costUSD;
    const pos = portfolio.positions[sym] || { units: 0, lots: [] };
    pos.units += u;
    pos.lots.push({ units: u, costBasisUSD: p, openedAt: new Date().toISOString() });
    portfolio.positions[sym] = pos;
    portfolio.history.push({
        type: 'BUY',
        symbol: sym,
        units: u,
        priceUSD: p,
        costUSD,
        ts: new Date().toISOString(),
    });
    save();
    return { costUSD, cashRemainingUSD: portfolio.cashUSD };
}

// Sell: consume lots FIFO, credit cash, compute realized P&L.
// Long-only: refuse to sell more units than the user holds.
export function recordSell({ symbol, units, priceUSD }) {
    if (!isInstantiated()) throw new Error('Portfolio not instantiated.');
    const sym = String(symbol || '').toUpperCase();
    const u = Number(units);
    const p = Number(priceUSD);
    if (!sym) throw new Error('Symbol required.');
    if (!Number.isFinite(u) || u <= 0) throw new Error('Units must be > 0.');
    if (!Number.isFinite(p) || p <= 0) throw new Error('Price must be > 0.');
    const pos = portfolio.positions[sym];
    if (!pos || pos.units < u - 1e-9) throw new Error('Not enough units to sell (long-only — no shorting).');

    let remaining = u;
    let costBasisConsumedUSD = 0;
    const newLots = [];
    for (const lot of pos.lots) {
        if (remaining <= 0) { newLots.push(lot); continue; }
        if (lot.units <= remaining + 1e-9) {
            costBasisConsumedUSD += lot.units * lot.costBasisUSD;
            remaining -= lot.units;
        } else {
            costBasisConsumedUSD += remaining * lot.costBasisUSD;
            newLots.push({ ...lot, units: lot.units - remaining });
            remaining = 0;
        }
    }
    pos.units -= u;
    pos.lots = newLots;
    if (pos.units < 1e-9) delete portfolio.positions[sym];
    else portfolio.positions[sym] = pos;

    const proceedsUSD = u * p;
    const realizedUSD = proceedsUSD - costBasisConsumedUSD;
    portfolio.cashUSD += proceedsUSD;
    portfolio.history.push({
        type: 'SELL',
        symbol: sym,
        units: u,
        priceUSD: p,
        proceedsUSD,
        costBasisUSD: costBasisConsumedUSD,
        realizedUSD,
        ts: new Date().toISOString(),
    });
    save();
    return { proceedsUSD, realizedUSD, cashRemainingUSD: portfolio.cashUSD };
}

// Average cost basis per unit for a held symbol, in USD.
export function avgCostBasisUSD(symbol) {
    const pos = getPortfolio().positions[String(symbol || '').toUpperCase()];
    if (!pos || pos.units < 1e-9) return null;
    const totalCost = pos.lots.reduce((s, l) => s + l.units * l.costBasisUSD, 0);
    return totalCost / pos.units;
}

// Symbols currently held — used by pricing.js to subscribe live tickers.
export function heldSymbols() {
    return Object.keys(getPortfolio().positions);
}

// Total cumulative deposits in USD — for return-pct calculations that
// account for added funds, not just initial deposit.
export function totalDepositedUSD() {
    return getPortfolio().history
        .filter(h => h.type === 'INSTANTIATE' || h.type === 'ADD_FUNDS')
        .reduce((s, h) => s + (h.amountUSD || 0), 0);
}

// Snapshot for export. Same shape as in storage; safe to share / re-import
// because it's just user data (no secrets).
export function exportPortfolio() {
    return JSON.stringify(getPortfolio(), null, 2);
}

// Import a previously-exported snapshot. Replaces current portfolio.
// Validates the schema version so a future incompatible export doesn't
// silently corrupt the running state.
export function importPortfolio(jsonString) {
    let parsed;
    try { parsed = JSON.parse(jsonString); }
    catch (_) { throw new Error('Not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('Snapshot is not an object.');
    if (parsed.schema !== SCHEMA_VERSION) {
        throw new Error(`Snapshot schema v${parsed.schema} doesn't match app schema v${SCHEMA_VERSION}.`);
    }
    portfolio = { ...emptyPortfolio(), ...parsed };
    save();
}
