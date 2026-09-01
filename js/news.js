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

// Google News RSS is XML, and this used to parse it with DOMParser -- which exists in a
// browser and NOT in Node. Mia's desk runs the same engine under Node (bot/advise.mjs), so
// every Google News fetch returned [] there, silently and forever.
//
// The visible symptom was two levels away and looked like nothing to do with parsing: the
// sentiment source scored a constant 50 on all 41 symbols, and because it still claimed a
// quarter of the weighted score, half of every score the desk computed was a fixed offset
// carrying no information. Stock symbols partially masked it, since fetchStockNews also
// calls fetchYahooNews (JSON, no DOM); crypto goes through Google News alone, so crypto
// sentiment was structurally impossible rather than merely unlucky.
function parseRSS(xml) {
    const raw = typeof DOMParser === 'function'
        ? parseRSSWithDom(xml)
        : parseRSSWithRegex(xml);
    return raw.slice(0, 15).map(r => ({
        title: cleanTitle(r.title),
        date: r.pubDate ? new Date(r.pubDate) : new Date(),
        source: r.source,
        url: r.link || null,
    })).filter(r => r.title);
}

function parseRSSWithDom(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return [...doc.querySelectorAll('item')].map(item => ({
        title: item.querySelector('title')?.textContent || '',
        pubDate: item.querySelector('pubDate')?.textContent || '',
        source: item.querySelector('source')?.textContent || '',
        link: (item.querySelector('link')?.textContent || '').trim(),
    }));
}

/** Node fallback. Deliberately no XML library: this parses ONE known feed shape, and a
 *  dependency for that would be a supply-chain risk in a public repo for no benefit. */
function parseRSSWithRegex(xml) {
    const out = [];
    const src = String(xml || '');
    // [\s\S] rather than the s flag so the intent is obvious: items span newlines.
    const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
    const field = (block, tag) => {
        // DOUBLE-escaped on purpose. Inside a template literal `\s` collapses to a bare
        // `s`, so `[\s\S]` would reach RegExp as `[sS]` -- a class matching only those two
        // letters, which silently extracts almost nothing. `\\s\\S` is what makes the
        // constructed pattern actually say "any character".
        const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        if (!m) return '';
        return decodeXmlEntities(
            m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                // Google News wraps titles in anchor markup; strip tags, keep the text.
                .replace(/<[^>]+>/g, '')
                .trim());
    };
    let m;
    while ((m = itemRe.exec(src)) !== null) {
        const block = m[0];
        out.push({
            title: field(block, 'title'),
            pubDate: field(block, 'pubDate'),
            source: field(block, 'source'),
            link: field(block, 'link'),
        });
        if (out.length >= 40) break;   // bounded: the caller only keeps 15
    }
    return out;
}

function decodeXmlEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
        // Ampersand LAST, or it would corrupt the entities decoded above.
        .replace(/&amp;/g, '&');
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
