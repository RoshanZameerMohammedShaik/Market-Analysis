// Market Conditions Module — Fear & Greed, VIX, Macro Data
// All free APIs, no keys required

import { fetchWithProxy } from './data.js';

// ─── FEAR & GREED INDEX ──────────────────────────────────────────────────────

export async function fetchFearGreedIndex() {
    try {
        // alternative.me free Fear & Greed API
        const res = await fetchWithProxy('https://api.alternative.me/fng/?limit=2&format=json');
        const data = await res.json();

        if (!data.data || data.data.length === 0) return null;

        const current = data.data[0];
        const previous = data.data[1] || current;

        return {
            value: parseInt(current.value),           // 0-100
            label: current.value_classification,      // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
            previous: parseInt(previous.value),
            trend: parseInt(current.value) - parseInt(previous.value), // positive = improving sentiment
            timestamp: current.timestamp,
        };
    } catch (e) {
        return null;
    }
}

// ─── CRYPTO FEAR & GREED ─────────────────────────────────────────────────────

export async function fetchCryptoFearGreed() {
    try {
        const res = await fetchWithProxy('https://api.alternative.me/fng/?limit=2&format=json&date_format=us');
        const data = await res.json();

        if (!data.data || data.data.length === 0) return null;

        const current = data.data[0];
        return {
            value: parseInt(current.value),
            label: current.value_classification,
        };
    } catch (e) {
        return null;
    }
}

// ─── VIX (Volatility Index) ──────────────────────────────────────────────────

export async function fetchVIX() {
    try {
        // Use Yahoo Finance for VIX data. Pass raw '^VIX' — fetchWithProxy
        // encodes the whole URL once when routing through the worker /
        // CORS proxy. Pre-encoding to %5E here would get encoded again
        // to %255E and Yahoo would 404. (Same bug we fixed in regime.js
        // and yields.js.)
        const url = 'https://query2.finance.yahoo.com/v8/finance/chart/^VIX?range=5d&interval=1d';
        const res = await fetchWithProxy(url);
        const json = await res.json();

        const result = json?.chart?.result?.[0];
        if (!result) return null;

        const closes = result.indicators.quote[0].close.filter(c => c !== null);
        const current = closes[closes.length - 1];
        const previous = closes[closes.length - 2] || current;

        // VIX interpretation:
        // < 15: Low volatility (complacent, bullish)
        // 15-20: Normal
        // 20-30: Elevated fear
        // > 30: High fear / panic
        let level;
        if (current < 15) level = 'low';
        else if (current < 20) level = 'normal';
        else if (current < 30) level = 'elevated';
        else level = 'extreme';

        return {
            value: Math.round(current * 100) / 100,
            previous: Math.round(previous * 100) / 100,
            change: Math.round((current - previous) * 100) / 100,
            level,
        };
    } catch (e) {
        return null;
    }
}

// ─── MARKET BREADTH (S&P 500 trend) ─────────────────────────────────────────

export async function fetchMarketBreadth() {
    try {
        // Use S&P 500 as market proxy
        // Raw '^GSPC' (see ^VIX comment above for the double-encoding gotcha).
        const url = 'https://query2.finance.yahoo.com/v8/finance/chart/^GSPC?range=1mo&interval=1d';
        const res = await fetchWithProxy(url);
        const json = await res.json();

        const result = json?.chart?.result?.[0];
        if (!result) return null;

        const closes = result.indicators.quote[0].close.filter(c => c !== null);
        if (closes.length < 10) return null;

        const current = closes[closes.length - 1];
        const fiveDayAgo = closes[closes.length - 6] || closes[0];
        const tenDayAgo = closes[closes.length - 11] || closes[0];

        const fiveDayChange = ((current - fiveDayAgo) / fiveDayAgo) * 100;
        const tenDayChange = ((current - tenDayAgo) / tenDayAgo) * 100;

        // Simple trend assessment
        let trend;
        if (fiveDayChange > 1 && tenDayChange > 2) trend = 'strong_bull';
        else if (fiveDayChange > 0.5) trend = 'bullish';
        else if (fiveDayChange < -1 && tenDayChange < -2) trend = 'strong_bear';
        else if (fiveDayChange < -0.5) trend = 'bearish';
        else trend = 'neutral';

        return {
            sp500: Math.round(current * 100) / 100,
            fiveDayChange: Math.round(fiveDayChange * 100) / 100,
            tenDayChange: Math.round(tenDayChange * 100) / 100,
            trend,
        };
    } catch (e) {
        return null;
    }
}

// ─── AGGREGATE MARKET SCORE ──────────────────────────────────────────────────

export async function getMarketConditionsScore(mode = 'stock') {
    const [fearGreed, vix, breadth] = await Promise.allSettled([
        mode === 'crypto' ? fetchCryptoFearGreed() : fetchFearGreedIndex(),
        fetchVIX(),
        fetchMarketBreadth(),
    ]);

    const fg = fearGreed.status === 'fulfilled' ? fearGreed.value : null;
    const vixData = vix.status === 'fulfilled' ? vix.value : null;
    const market = breadth.status === 'fulfilled' ? breadth.value : null;

    // Score each component 0-100 (bullish scale)
    let scores = [];
    let reasons = [];

    // Fear & Greed: used DIRECTLY as a 0-100 bullish score (momentum reading:
    // fear = risk-off/bearish, greed = risk-on/bullish). NOTE: the reason text
    // below is written to MATCH that scoring direction so the card never
    // contradicts itself. (A 'contrarian' reading — extreme fear = buy
    // opportunity — would require FLIPPING the score to 100-fg.value, which
    // changes every prediction and is being validated via backtest before any
    // change; do not flip the value here without that.)
    if (fg) {
        scores.push({ value: fg.value, weight: 0.35 });
        if (fg.value <= 25) {
            reasons.push(`Extreme Fear (${fg.value}/100) — risk-off, weighs bearish`);
        } else if (fg.value <= 40) {
            reasons.push(`Fear (${fg.value}/100) — market cautious, mildly bearish`);
        } else if (fg.value >= 75) {
            reasons.push(`Extreme Greed (${fg.value}/100) — risk-on, but stretched`);
        } else if (fg.value >= 60) {
            reasons.push(`Greed (${fg.value}/100) — bullish sentiment`);
        } else {
            reasons.push(`Neutral sentiment (${fg.value}/100)`);
        }
    }

    // VIX: inverse relationship (low VIX = bullish)
    if (vixData) {
        // Convert VIX to 0-100 bullish scale (VIX 10=90 bullish, VIX 40=10 bullish)
        const vixScore = Math.max(0, Math.min(100, 100 - (vixData.value - 10) * 3));
        scores.push({ value: vixScore, weight: 0.30 });

        if (vixData.level === 'extreme') {
            reasons.push(`VIX at ${vixData.value} — extreme fear/panic in market`);
        } else if (vixData.level === 'elevated') {
            reasons.push(`VIX at ${vixData.value} — elevated uncertainty`);
        } else if (vixData.level === 'low') {
            reasons.push(`VIX at ${vixData.value} — low volatility, calm market`);
        } else {
            reasons.push(`VIX at ${vixData.value} — normal volatility`);
        }
    }

    // Market breadth: trend to score
    if (market) {
        let breadthScore;
        switch (market.trend) {
            case 'strong_bull': breadthScore = 85; break;
            case 'bullish': breadthScore = 65; break;
            case 'neutral': breadthScore = 50; break;
            case 'bearish': breadthScore = 35; break;
            case 'strong_bear': breadthScore = 15; break;
            default: breadthScore = 50;
        }
        scores.push({ value: breadthScore, weight: 0.35 });
        reasons.push(`S&P 500: ${market.fiveDayChange > 0 ? '+' : ''}${market.fiveDayChange}% (5d), ${market.tenDayChange > 0 ? '+' : ''}${market.tenDayChange}% (10d)`);
    }

    // Weighted average
    if (scores.length === 0) {
        return { score: 50, reasons: ['Market data unavailable'], raw: { fg, vix: vixData, breadth: market } };
    }

    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    const weightedScore = scores.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight;

    return {
        score: Math.round(weightedScore),  // 0-100 bullish scale
        reasons,
        raw: { fg, vix: vixData, breadth: market },
    };
}
