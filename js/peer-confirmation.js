// Cross-symbol confirmation. For a single-symbol stock signal, sample
// 3-5 sector mates and check if their lightweight signals agree. High
// agreement strengthens the call; high disagreement weakens it.
//
// Skipped on bulk scans (Hot Picks, Spikers) because adding 3-5 fetches
// per candidate compounds to seconds of latency. Single-symbol analyses
// take the latency hit because the user explicitly opted in.

import { fetchStockData } from './data.js';
import { generatePrediction } from './analysis.js';
import { symbolSector } from './sectors.js';

const PEERS = {
    XLK:  ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL'],
    XLC:  ['META', 'GOOGL', 'NFLX', 'DIS', 'TMUS'],
    XLY:  ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG'],
    XLP:  ['WMT', 'COST', 'PG', 'KO', 'PEP'],
    XLV:  ['UNH', 'JNJ', 'LLY', 'PFE', 'MRK'],
    XLF:  ['JPM', 'BAC', 'WFC', 'GS', 'V'],
    XLE:  ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
    XLI:  ['CAT', 'BA', 'UNP', 'HON', 'GE'],
    XLU:  ['NEE', 'DUK', 'SO', 'AEP', 'SRE'],
    XLB:  ['LIN', 'SHW', 'APD', 'FCX', 'NEM'],
    XLRE: ['PLD', 'AMT', 'CCI', 'EQIX', 'PSA'],
};

const cache = new Map(); // key -> { data, ts }
const TTL_MS = 5 * 60 * 1000;

/**
 * Returns { agreement, peerCount, dominantDir, peerSummary } or null on failure.
 * agreement is 0..1: fraction of peers whose direction matches ourSignal.
 * dominantDir is 'BUY' | 'SELL' | 'NEUTRAL' — majority across peers.
 */
export async function getPeerAgreement(symbol, ourSignal) {
    const upper = (symbol || '').toUpperCase();
    if (!upper) return null;
    const sec = symbolSector(upper);
    if (!sec) return null;
    const peers = (PEERS[sec.etf] || []).filter(p => p !== upper);
    if (peers.length === 0) return null;

    const cacheKey = `${upper}:${ourSignal}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const sample = peers.slice(0, 4);
    const results = await Promise.allSettled(sample.map(async p => {
        const data = await fetchStockData(p, '3mo', '1d');
        if (!data?.candles || data.candles.length < 30) return null;
        const pred = generatePrediction(data.candles);
        return pred?.signal || null;
    }));

    const sigs = results.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
    if (sigs.length === 0) return null;

    const agreeCount = sigs.filter(s => s === ourSignal).length;
    const buyCount = sigs.filter(s => s === 'BUY').length;
    const sellCount = sigs.filter(s => s === 'SELL').length;
    let dominantDir = 'NEUTRAL';
    if (buyCount > sellCount && buyCount > sigs.length / 2) dominantDir = 'BUY';
    else if (sellCount > buyCount && sellCount > sigs.length / 2) dominantDir = 'SELL';

    const data = {
        agreement: agreeCount / sigs.length,
        peerCount: sigs.length,
        dominantDir,
        peerSummary: `${sigs.length} sector mates: ${buyCount} BUY / ${sellCount} SELL / ${sigs.length - buyCount - sellCount} NEUTRAL`,
    };
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
}

/**
 * Translate peer agreement into a confidence delta.
 *   - Agreement >= 0.7: peers strongly back our call -> +4
 *   - Agreement >= 0.5 and dominant matches: mild support -> +1
 *   - Agreement <= 0.3 and peers oppose: -6
 *   - Else: 0
 */
export function peerAdjustment(ourSignal, peer) {
    if (!peer || !ourSignal || ourSignal === 'NEUTRAL') return { adjust: 0, reason: null };
    const a = peer.agreement;
    if (a >= 0.7) return { adjust: +4, reason: `Sector peers ${(a * 100).toFixed(0)}% agree (${peer.peerSummary})` };
    if (a >= 0.5 && peer.dominantDir === ourSignal) return { adjust: +1, reason: `Mild peer support (${peer.peerSummary})` };
    if (a <= 0.3) return { adjust: -6, reason: `Sector peers disagree, only ${(a * 100).toFixed(0)}% concur (${peer.peerSummary})` };
    return { adjust: 0, reason: null };
}
