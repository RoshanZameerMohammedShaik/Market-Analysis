// Hot Picks Scanner — fresh analysis on every page load
import { fetchStockData, fetchCryptoData, HOT_STOCKS, HOT_CRYPTO, CRYPTO_NAMES, fetchWithProxy } from './data.js';
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

    // CoinGecko is strict on rate limits — process one at a time with delays
    for (let i = 0; i < HOT_CRYPTO.length; i++) {
        const coinId = HOT_CRYPTO[i];
        try {
            const data = await fetchCryptoData(coinId, 90);
            if (!data.candles || data.candles.length < 20) continue;

            const prediction = generatePrediction(data.candles, timeframe);
            results.push({
                symbol: data.symbol,
                name: data.name,
                id: coinId,
                price: data.currentPrice,
                signal: prediction.signal,
                confidence: prediction.confidence,
                reasons: prediction.reasons,
                change: data.change24h || 0,
            });
        } catch (e) {
            // Skip failed coins silently
            continue;
        }

        // Rate limit: wait between each request for CoinGecko
        if (i < HOT_CRYPTO.length - 1) {
            await new Promise(r => setTimeout(r, 600));
        }
    }

    // If CoinGecko failed entirely, try fetching market data in bulk as fallback
    if (results.length === 0) {
        try {
            const fallbackResults = await fetchCryptoMarketFallback(timeframe);
            results.push(...fallbackResults);
        } catch (e) { /* give up */ }
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

// Fallback: use CoinGecko /coins/markets endpoint which returns many coins in one call
async function fetchCryptoMarketFallback(timeframe) {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&sparkline=true&price_change_percentage=24h,7d';
    const res = await fetchWithProxy(url);
    const coins = await res.json();

    if (!Array.isArray(coins)) return [];

    return coins.map(coin => {
        // Use sparkline data (7 days of prices) for basic prediction
        const sparkline = coin.sparkline_in_7d?.price || [];
        if (sparkline.length < 20) return null;

        const candles = sparkline.map((close, i) => ({
            time: Date.now() / 1000 - (sparkline.length - i) * 3600,
            open: close, high: close * 1.01, low: close * 0.99, close, volume: 0,
        }));

        const prediction = generatePrediction(candles, timeframe);
        const name = CRYPTO_NAMES[coin.id] || coin.name;

        return {
            symbol: coin.symbol.toUpperCase(),
            name,
            id: coin.id,
            price: coin.current_price,
            signal: prediction.signal,
            confidence: prediction.confidence,
            reasons: prediction.reasons,
            change: coin.price_change_percentage_24h || 0,
        };
    }).filter(Boolean);
}
