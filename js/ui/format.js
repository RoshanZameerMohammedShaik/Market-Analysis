// Number / time formatters. Single source of truth for display formatting.
//
// fmt() is for non-currency numbers (shares, percentages, raw counts).
// fmtPrice() and fmtCompact() delegate to currency.js so any USD value
// flips automatically when the user toggles INR.

import { format as fmtCurrency, priceTag, getMode, getRate } from '../currency.js';

export const fmt = (n, digits = 2) => {
    if (n == null || Number.isNaN(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

// Returns currency-aware formatted price text (no markup).
// `opts.srcCurrency` lets callers that fetched a non-USD-native price
// (Indian / London / Tokyo / Hong Kong listings — Yahoo returns them
// in native currency, not USD) skip the FX conversion. Default USD.
export const fmtPrice = (value, opts) => fmtCurrency(value, opts);

// Returns the markup that auto-flips when currency changes. Use this in HTML strings.
export const fmtPriceTag = (value, opts) => priceTag(value, opts);

export const fmtCompact = n => {
    if (n == null) return '—';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return fmt(n);
};

export const timeAgo = date => {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};

export { getMode as currencyMode, getRate as currencyRate };
