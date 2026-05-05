// News Fetching Module — STRICT relevance filtering
// Only returns news that ACTUALLY mentions the stock/crypto being analyzed

import { fetchWithProxy } from './data.js';

// ─── STOCK NEWS ──────────────────────────────────────────────────────────────

export async function fetchStockNews(symbol, companyName = '') {
    const results = [];

    // Search with symbol explicitly in quotes for precision
    const queries = [
        `"${symbol}" stock`,
        companyName ? `"${companyName}" stock price` : `${symbol} earnings price`,
    ];

    const sources = await Promise.allSettled([
        fetchGoogleNews(queries[0]),
        fetchGoogleNews(queries[1]),
        fetchYahooNews(symbol),
    ]);

    sources.forEach(s => {
        if (s.status === 'fulfilled' && s.value) {
            results.push(...s.value);
        }
    });

    // STRICT FILTER: only keep articles that mention the symbol or company name
    const filtered = filterRelevantNews(results, symbol, companyName);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

// ─── CRYPTO NEWS ─────────────────────────────────────────────────────────────

export async function fetchCryptoNews(coinNameOrSymbol) {
    const results = [];
    const name = coinNameOrSymbol.toLowerCase();

    const queries = [
        `"${coinNameOrSymbol}" crypto price`,
        `"${coinNameOrSymbol}" cryptocurrency`,
    ];

    const sources = await Promise.allSettled([
        fetchGoogleNews(queries[0]),
        fetchGoogleNews(queries[1]),
    ]);

    sources.forEach(s => {
        if (s.status === 'fulfilled' && s.value) {
            results.push(...s.value);
        }
    });

    // Filter for relevance
    const filtered = filterRelevantNews(results, coinNameOrSymbol, coinNameOrSymbol);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

// ─── RELEVANCE FILTER ────────────────────────────────────────────────────────

function filterRelevantNews(items, symbol, name) {
    const sym = symbol.toUpperCase();
    const nameLower = (name || symbol).toLowerCase();
    // Also check common variations
    const variations = [sym, nameLower, sym.toLowerCase()];

    return items.filter(item => {
        const titleLower = item.title.toLowerCase();
        // Article must mention the symbol or company name in the title
        return variations.some(v => titleLower.includes(v.toLowerCase()));
    });
}

// ─── GOOGLE NEWS RSS ─────────────────────────────────────────────────────────

async function fetchGoogleNews(query) {
    try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
        const res = await fetchWithProxy(rssUrl);
        const text = await res.text();
        return parseRSS(text);
    } catch (e) {
        return [];
    }
}

function parseRSS(xml) {
    const items = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const entries = doc.querySelectorAll('item');

    entries.forEach((item, i) => {
        if (i >= 15) return; // Fetch more, filter later
        const title = item.querySelector('title')?.textContent || '';
        const pubDate = item.querySelector('pubDate')?.textContent || '';
        const source = item.querySelector('source')?.textContent || '';

        if (title) {
            items.push({
                title: cleanTitle(title),
                date: pubDate ? new Date(pubDate) : new Date(),
                source,
            });
        }
    });

    return items;
}

// ─── YAHOO FINANCE NEWS ──────────────────────────────────────────────────────

async function fetchYahooNews(symbol) {
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=8&quotesCount=0`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.news || []).map(n => ({
            title: n.title,
            date: new Date(n.providerPublishTime * 1000),
            source: n.publisher || 'Yahoo Finance',
        }));
    } catch (e) {
        return [];
    }
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function cleanTitle(title) {
    return title.replace(/\s*-\s*[^-]+$/, '').trim();
}

function deduplicateNews(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = item.title.substring(0, 40).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => b.date - a.date);
}
