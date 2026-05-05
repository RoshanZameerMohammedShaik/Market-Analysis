// Hot Picks Scanner — fresh analysis on every page load
import { fetchStockData, fetchCryptoData, HOT_STOCKS, HOT_CRYPTO } from './data.js';
import { generatePrediction } from './analysis.js';

// ─── STOCK HOT PICKS ─────────────────────────────────────────────────────────

export async function scanStockHotPicks(timeframe = 'today', maxPicks = 20) {
    const results = [];
    const batchSize = 6;

    // Process in batches to avoid rate limiting but scan the full pool
    for (let i = 0; i < HOT_STOCKS.length; i += batchSize) {
        const batch = HOT_STOCKS.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
            batch.map(async (symbol) => {
                try {
                    const data = await fetchStockData(symbol, '3mo', '1d');
                    if (!data.candles || data.candles.length < 30) return null;

                    const prediction = generatePrediction(data.candles, timeframe);
                    return {
                        symbol: data.symbol,
                        name: data.name,
                        price: data.currentPrice,
                        signal: prediction.signal,
                        confidence: prediction.confidence,
                        reasons: prediction.reasons,
                        change: data.currentPrice && data.previousClose
                            ? ((data.currentPrice - data.previousClose) / data.previousClose * 100)
                            : 0,
                    };
                } catch (e) {
                    return null;
                }
            })
        );

        batchResults.forEach(r => {
            if (r.status === 'fulfilled' && r.value) results.push(r.value);
        });

        // Small delay between batches to avoid throttling
        if (i + batchSize < HOT_STOCKS.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // Return ALL analyzed stocks sorted by confidence (BUY signals first, then others)
    // Show BUY signals at top, then NEUTRAL, then SELL — all sorted by confidence
    const buySignals = results
        .filter(r => r.signal === 'BUY')
        .sort((a, b) => b.confidence - a.confidence);

    // If we have enough BUY signals, return those
    if (buySignals.length >= maxPicks) {
        return buySignals.slice(0, maxPicks);
    }

    // Otherwise fill with NEUTRAL signals too (but mark them differently)
    const neutralSignals = results
        .filter(r => r.signal === 'NEUTRAL')
        .sort((a, b) => b.confidence - a.confidence);

    return [...buySignals, ...neutralSignals].slice(0, maxPicks);
}

// ─── CRYPTO HOT PICKS ────────────────────────────────────────────────────────

export async function scanCryptoHotPicks(timeframe = 'today', maxPicks = 20) {
    const results = [];
    const batchSize = 4;

    for (let i = 0; i < HOT_CRYPTO.length; i += batchSize) {
        const batch = HOT_CRYPTO.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
            batch.map(async (coinId) => {
                try {
                    const data = await fetchCryptoData(coinId, 90);
                    if (!data.candles || data.candles.length < 30) return null;

                    const prediction = generatePrediction(data.candles, timeframe);
                    return {
                        symbol: data.symbol,
                        name: data.name,
                        id: coinId,
                        price: data.currentPrice,
                        signal: prediction.signal,
                        confidence: prediction.confidence,
                        reasons: prediction.reasons,
                        change: data.change24h || 0,
                    };
                } catch (e) {
                    return null;
                }
            })
        );

        batchResults.forEach(r => {
            if (r.status === 'fulfilled' && r.value) results.push(r.value);
        });

        if (i + batchSize < HOT_CRYPTO.length) {
            await new Promise(r => setTimeout(r, 400));
        }
    }

    const buySignals = results
        .filter(r => r.signal === 'BUY')
        .sort((a, b) => b.confidence - a.confidence);

    if (buySignals.length >= maxPicks) {
        return buySignals.slice(0, maxPicks);
    }

    const neutralSignals = results
        .filter(r => r.signal === 'NEUTRAL')
        .sort((a, b) => b.confidence - a.confidence);

    return [...buySignals, ...neutralSignals].slice(0, maxPicks);
}
