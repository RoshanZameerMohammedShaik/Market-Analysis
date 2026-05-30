// News Fetching Module — STRICT relevance filtering, locale-aware.
// Pulls Google News RSS for the active market's locale + Yahoo Finance.

import { fetchWithProxy } from './data.js';
import { getMarket } from './markets.js';

export async function fetchStockNews(symbol, companyName = '') {
    const results = [];
    const market = getMarket();
    const queries = [
        `"${symbol}" stock`,
        companyName ? `"${companyName}" stock price` : `${symbol} earnings price`,
    ];

    const sources = await Promise.allSettled([
        fetchGoogleNews(queries[0], market.locale),
        fetchGoogleNews(queries[1], market.locale),
        fetchYahooNews(symbol),
    ]);

    sources.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(...s.value); });
    const filtered = filterRelevantNews(results, symbol, companyName);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

export async function fetchCryptoNews(coinNameOrSymbol) {
    const results = [];
    const queries = [`"${coinNameOrSymbol}" crypto price`, `"${coinNameOrSymbol}" cryptocurrency`];
    const sources = await Promise.allSettled([
        fetchGoogleNews(queries[0], { gl: 'US', hl: 'en-US' }),
        fetchGoogleNews(queries[1], { gl: 'US', hl: 'en-US' }),
    ]);
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
// rate-limit it. We use a windowed cool-down rather than a permanent
// session kill so a single proxy 503 doesn't permanently halve the
// news corpus — after 2 failures inside 5 min, sit out for 10 min,
// then try again. Yahoo News still feeds sentiment during cool-down.
const GN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const GN_COOLDOWN_MS = 10 * 60 * 1000;
const GN_FAILURE_THRESHOLD = 2;
let gnFailureTimestamps = [];
let gnCooldownUntil = 0;

function recordGoogleNewsFailure() {
    const now = Date.now();
    gnFailureTimestamps = gnFailureTimestamps.filter(ts => now - ts < GN_FAILURE_WINDOW_MS);
    gnFailureTimestamps.push(now);
    if (gnFailureTimestamps.length >= GN_FAILURE_THRESHOLD) {
        gnCooldownUntil = now + GN_COOLDOWN_MS;
        gnFailureTimestamps = [];
    }
}

async function fetchGoogleNews(query, locale = { gl: 'US', hl: 'en-US' }) {
    if (Date.now() < gnCooldownUntil) return [];
    try {
        const ceid = `${locale.gl}:${locale.hl.split('-')[0] || 'en'}`;
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${ceid}`;
        const res = await fetchWithProxy(rssUrl);
        const text = await res.text();
        return parseRSS(text);
    } catch (e) {
        recordGoogleNewsFailure();
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
        if (title) items.push({ title: cleanTitle(title), date: pubDate ? new Date(pubDate) : new Date(), source });
    });
    return items;
}

async function fetchYahooNews(symbol) {
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=8&quotesCount=0`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.news || []).map(n => ({
            title: n.title, date: new Date(n.providerPublishTime * 1000), source: n.publisher || 'Yahoo Finance',
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
