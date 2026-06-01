// News Fetching Module — STRICT relevance filtering, locale-aware.
// Pulls Google News RSS for the active market's locale + Yahoo Finance.

import { fetchWithProxy } from './data.js';
import { getMarket } from './markets.js';
import { isCooling, recordFailure, recordSuccess } from './breaker.js';

export async function fetchStockNews(symbol, companyName = '') {
    const results = [];
    const market = getMarket();
    const queries = [
        `"${symbol}" stock`,
        companyName ? `"${companyName}" stock price` : `${symbol} earnings price`,
    ];

    // First Google News query in parallel with Yahoo. If the first
    // GN call trips the breaker (cooling), the second call is a no-op
    // — saves a duplicate proxy-chain cascade per symbol-analysis.
    const [first, yahoo] = await Promise.allSettled([
        fetchGoogleNews(queries[0], market.locale),
        fetchYahooNews(symbol),
    ]);
    const sources = [first, yahoo];
    if (first.status === 'fulfilled' && first.value && first.value.length > 0) {
        const second = await fetchGoogleNews(queries[1], market.locale).catch(() => []);
        sources.push({ status: 'fulfilled', value: second });
    }

    sources.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(...s.value); });
    const filtered = filterRelevantNews(results, symbol, companyName);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

export async function fetchCryptoNews(coinNameOrSymbol) {
    const results = [];
    const queries = [`"${coinNameOrSymbol}" crypto price`, `"${coinNameOrSymbol}" cryptocurrency`];
    const first = await fetchGoogleNews(queries[0], { gl: 'US', hl: 'en-US' }).catch(() => []);
    const sources = [{ status: 'fulfilled', value: first }];
    if (first && first.length > 0) {
        const second = await fetchGoogleNews(queries[1], { gl: 'US', hl: 'en-US' }).catch(() => []);
        sources.push({ status: 'fulfilled', value: second });
    }
    sources.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(...s.value); });
    const filtered = filterRelevantNews(results, coinNameOrSymbol, coinNameOrSymbol);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

function filterRelevantNews(items, symbol, name) {
    const sym = symbol.toUpperCase();
    const nameLower = (name || symbol).toLowerCase();
    const variations = [sym, nameLower, sym.toLowerCase(), sym.split('.')[0]];
    return items.filter(item => {
        const titleLower = item.title.toLowerCase();
        return variations.some(v => titleLower.includes(v.toLowerCase()));
    });
}

// Google News RSS is CORS-blocked at origin and the free CORS proxies
// rate-limit it. Shared breaker — first failure trips for 10 min,
// then re-probes. Yahoo News covers the gap.
async function fetchGoogleNews(query, locale = { gl: 'US', hl: 'en-US' }) {
    if (isCooling('google-news')) return [];
    try {
        const ceid = `${locale.gl}:${locale.hl.split('-')[0] || 'en'}`;
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${ceid}`;
        const res = await fetchWithProxy(rssUrl);
        const text = await res.text();
        recordSuccess('google-news');
        return parseRSS(text);
    } catch (e) {
        recordFailure('google-news');
        return [];
    }
}

function parseRSS(xml) {
    const items = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const entries = doc.querySelectorAll('item');
    entries.forEach((item, i) => {
        if (i >= 15) return;
        const title = item.querySelector('title')?.textContent || '';
        const pubDate = item.querySelector('pubDate')?.textContent || '';
        const source = item.querySelector('source')?.textContent || '';
        const link = (item.querySelector('link')?.textContent || '').trim();
        if (title) items.push({
            title: cleanTitle(title),
            date: pubDate ? new Date(pubDate) : new Date(),
            source,
            url: link || null,
        });
    });
    return items;
}

async function fetchYahooNews(symbol) {
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=8&quotesCount=0`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.news || []).map(n => ({
            title: n.title,
            date: new Date(n.providerPublishTime * 1000),
            source: n.publisher || 'Yahoo Finance',
            url: n.link || null,
        }));
    } catch (e) { return []; }
}

function cleanTitle(title) { return title.replace(/\s*-\s*[^-]+$/, '').trim(); }
function deduplicateNews(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = item.title.substring(0, 40).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => b.date - a.date);
}
