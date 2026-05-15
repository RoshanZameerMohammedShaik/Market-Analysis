// Level 2 — research_symbol meta-tool.
//
// Fires 5 reads in parallel for a single symbol so Mia has rich
// multi-source context to synthesize her own qualitative read. Total
// time bounded by the slowest sub-fetch (~2-4s), since they all run
// at once.
//
// Each sub-result is trimmed before bundling so the returned JSON
// fits comfortably under the 4KB tool-result truncation in agent.js.

import { fetchNewsAndSentiment, fetchFredSeries, fetchRedditSentiment, fetchOptionsView, fetchCryptoDerivativesView } from './external-tools.js';

function trimNews(res) {
    if (!res || res.error) return res;
    return {
        count: res.count,
        sentiment: res.sentiment?.overall,
        score: res.sentiment?.score,
        topHeadlines: (res.topHeadlines || []).slice(0, 4),
    };
}

function trimReddit(res) {
    if (!res || res.error) return res;
    return {
        count: res.count,
        sentiment: res.sentiment,
        score: res.score,
        bullishPosts: res.bullishPosts,
        bearishPosts: res.bearishPosts,
        topPosts: (res.topPosts || []).slice(0, 2).map(p => ({ title: p.title, score: p.score, comments: p.comments })),
    };
}

function trimOptions(res) {
    if (!res) return null;
    return {
        pcr: res.pcr ? +res.pcr.toFixed(2) : null,
        skew: res.skew ? +res.skew.toFixed(2) : null,
        callVol: res.callVol,
        putVol: res.putVol,
    };
}

function trimDerivs(res) {
    if (!res) return null;
    return {
        fundingPctPer8h: res.fundingPctPer8h ? +res.fundingPctPer8h.toFixed(3) : null,
        oiTrend24hPct: res.oiTrend24hPct ? +res.oiTrend24hPct.toFixed(2) : null,
    };
}

function trimMacro(res) {
    if (!res || res.error) return res;
    return {
        series: res.series,
        latest: res.latest,
        pctChange: res.pctChange,
    };
}

/**
 * args:
 *   { symbol: 'AAPL', mode: 'stock'|'crypto', macroSeries?: 'DGS10' }
 */
export async function researchSymbol({ symbol, mode = 'stock', macroSeries = 'DGS10', companyName = '' }) {
    if (!symbol) return { error: 'symbol required' };

    const isCrypto = mode === 'crypto';
    const tasks = [
        // News + sentiment is universal
        fetchNewsAndSentiment({ symbol, mode, companyName }).then(trimNews).catch(e => ({ error: e.message })),
        // Reddit works for both stocks and crypto symbols
        fetchRedditSentiment({ symbol }).then(trimReddit).catch(e => ({ error: e.message })),
        // Macro series (10y yield by default) gives a market-context anchor
        fetchFredSeries({ series: macroSeries, lookbackMonths: 1 }).then(trimMacro).catch(e => ({ error: e.message })),
        // Stocks get options; crypto gets derivs
        isCrypto
            ? fetchCryptoDerivativesView({ coinId: symbol.toLowerCase() }).then(trimDerivs).catch(e => ({ error: e.message }))
            : fetchOptionsView({ symbol }).then(trimOptions).catch(e => ({ error: e.message })),
    ];

    const [news, reddit, macro, positioning] = await Promise.all(tasks);

    return {
        symbol,
        mode,
        sources: {
            news,
            reddit,
            macro: { series: macroSeries, ...(macro || {}) },
            positioning: isCrypto ? { type: 'derivs', ...positioning } : { type: 'options', ...positioning },
        },
    };
}
