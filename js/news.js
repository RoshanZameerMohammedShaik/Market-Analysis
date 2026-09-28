// News Fetching Module — STRICT relevance filtering, locale-aware.
// Pulls RSS news search (Bing, then Google) for the active market's locale + Yahoo Finance.

import { fetchWithProxy } from './data.js';
import { getMarket } from './markets.js';
import { isCooling, recordFailure, recordSuccess } from './breaker.js';

const WORKER_BASE = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';
const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

export async function fetchStockNews(symbol, companyName = '', { rss = true } = {}) {
    const results = [];
    const market = getMarket();
    const core = coreCompanyName(companyName);
    const queries = [
        `"${symbol}" stock`,
        core ? `"${core}" stock` : `${symbol} earnings price`,
    ];

    // First RSS query in parallel with Yahoo. If the first call trips the breaker
    // (cooling), the second call is a no-op.
    const [first, yahoo] = await Promise.allSettled([
        rss ? fetchRssNews(queries[0], market.locale) : Promise.resolve([]),
        fetchYahooNews(symbol),
    ]);
    const sources = [first, yahoo];
    if (first.status === 'fulfilled' && first.value && first.value.length > 0) {
        const second = await fetchRssNews(queries[1], market.locale).catch(() => []);
        sources.push({ status: 'fulfilled', value: second });
    }

    sources.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(...s.value); });
    const filtered = filterRelevantNews(results, symbol, companyName);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

/**
 * @param coinName  display name ("Bitcoin"). A CoinGecko id ("the-open-network") also works, it
 *                  is just a worse search query.
 * @param ticker    optional base ticker ("BTC"), accepted as a mention in headlines.
 */
export async function fetchCryptoNews(coinName, ticker = '', { rss = true } = {}) {
    const results = [];
    // Crypto headlines come only from RSS search (Yahoo's news search has none for coins).
    if (!rss) return results;
    // Yahoo names crypto "Bitcoin USD"; headlines say "Bitcoin". A CoinGecko id arrives hyphenated.
    const name = String(coinName || ticker || '').replace(/-/g, ' ').replace(/\s+USD$/i, '').trim();
    if (!name) return [];
    const queries = [`"${name}" crypto price`, `"${name}" cryptocurrency`];
    const first = await fetchRssNews(queries[0], { gl: 'US', hl: 'en-US' }).catch(() => []);
    const sources = [{ status: 'fulfilled', value: first }];
    if (first && first.length > 0) {
        const second = await fetchRssNews(queries[1], { gl: 'US', hl: 'en-US' }).catch(() => []);
        sources.push({ status: 'fulfilled', value: second });
    }
    sources.forEach(s => { if (s.status === 'fulfilled' && s.value) results.push(...s.value); });
    const filtered = filterRelevantNews(results, ticker || name, name);
    const unique = deduplicateNews(filtered);
    return unique.slice(0, 8);
}

// Legal-form words that a headline almost never repeats. Yahoo names Apple "Apple Inc.", and the
// filter used to require that exact string (or the ticker) in the title, so "Apple's iPhone
// sales..." was discarded as irrelevant. On 2026-09-28 every one of AAPL's Yahoo headlines failed
// the filter and the card said "No recent news available" for the most-covered stock there is.
const LEGAL_FORM = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|plc|llc|lp|holdings?|group|n\.?\s?v|s\.?\s?a|ag|se|oyj|asa|ab|s\.?p\.?a|kgaa|bhd|tbk|pcl|adr|ads|class\s+[a-c])\b\.?/gi;

/** "Credo Technology Group Holding Ltd" -> "Credo Technology"; "Apple Inc." -> "Apple". */
export function coreCompanyName(name) {
    let s = String(name || '').replace(/&amp;/g, '&');
    s = s.replace(/^the\s+/i, '').replace(LEGAL_FORM, ' ');
    s = s.replace(/[,.()]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length >= 2 ? s : '';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this headline name the company? Whole words only, so "ON" does not match "on" and "Apple"
 * does not match "Pineapple". Tickers of three letters or fewer must appear in capitals, because
 * as lowercase they are ordinary English words.
 */
export function mentionsCompany(title, { symbol = '', name = '', allowFirstWord = false } = {}) {
    const t = String(title || '');
    if (!t) return false;
    const sym = String(symbol || '').toUpperCase();
    const bases = [...new Set([sym, sym.split('.')[0], sym.split('-')[0]].filter(Boolean))];
    for (const b of bases) {
        const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(b)}([^A-Za-z0-9]|$)`, b.length <= 3 ? '' : 'i');
        if (re.test(t)) return true;
    }
    const core = coreCompanyName(name) || String(name || '').trim();
    if (core && new RegExp(`\\b${escapeRe(core)}\\b`, 'i').test(t)) return true;
    // "Credo" for "Credo Technology". Only for items the SOURCE already tied to this ticker (Yahoo's
    // relatedTickers), because a bare first word like "First" or "General" would match anything.
    if (allowFirstWord) {
        const first = core.split(' ')[0];
        if (first && first.length >= 4 && core.includes(' ')
            && new RegExp(`\\b${escapeRe(first)}\\b`).test(t)) return true;
    }
    return false;
}

function filterRelevantNews(items, symbol, name) {
    const sym = String(symbol || '').toUpperCase();
    return items.filter(item => mentionsCompany(item.title, {
        symbol: sym,
        name: name || symbol,
        allowFirstWord: Array.isArray(item.tickers) && item.tickers.some(x => String(x).toUpperCase() === sym),
    }));
}

// RSS news search. In a browser this goes through our Worker's /news-rss route (Bing News, then
// Google News, fetched server-side): both feeds send no CORS headers, and the public CORS proxies
// this used to rely on were all dead when measured on 2026-09-28 (corsproxy.io 401, allorigins
// and codetabs aborted, thingproxy gone from DNS). Outside a browser there is no CORS, so Node
// fetches Google News directly. Shared breaker: first failure trips it for a cooldown.
// Three misses in a row before the breaker trips, not one. A Hot Picks scan asks for ~140 feeds in
// a burst and Bing sheds a few of them; tripping on the first shed switched news off for ten
// minutes, including for the symbol the user opened next.
let rssFailStreak = 0;
async function fetchRssNews(query, locale = { gl: 'US', hl: 'en-US' }) {
    if (isCooling('news-rss')) return [];
    try {
        let text;
        if (isBrowser()) {
            const u = `${WORKER_BASE}/news-rss?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(locale.hl)}&gl=${encodeURIComponent(locale.gl)}`;
            const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) throw new Error(`news-rss ${res.status}`);
            text = await res.text();
        } else {
            const ceid = `${locale.gl}:${locale.hl.split('-')[0] || 'en'}`;
            const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${ceid}`;
            const res = await fetchWithProxy(rssUrl);
            text = await res.text();
        }
        rssFailStreak = 0;
        recordSuccess('news-rss');
        return parseRSS(text);
    } catch (e) {
        if (++rssFailStreak >= 3) { rssFailStreak = 0; recordFailure('news-rss'); }
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
        title: cleanTitle(r.title, r.source),
        date: r.pubDate ? new Date(r.pubDate) : new Date(),
        source: r.source,
        url: realLink(r.link) || null,
        summary: r.description ? r.description.replace(/<[^>]+>/g, '').trim().slice(0, 400) : '',
    })).filter(r => r.title);
}

// Bing wraps every link in a click tracker (bing.com/news/apiclick.aspx?...&url=<real>). The real
// URL is what the source-tier lookup and the article extractor need; the tracker would classify
// every story as "bing.com" and fetch Bing's redirect page instead of the article.
function realLink(link) {
    const l = String(link || '').trim();
    if (!l) return '';
    try {
        const u = new URL(l);
        if (/(^|\.)bing\.com$/i.test(u.hostname) && u.searchParams.get('url')) return u.searchParams.get('url');
    } catch (_) { /* not a URL; return as-is */ }
    return l;
}

function parseRSSWithDom(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    // Google News names the outlet in <source>; Bing uses <News:Source>. querySelector cannot
    // address a prefixed tag, so match on the local name.
    const child = (item, local) => [...item.children].find(c => (c.localName || c.nodeName).toLowerCase() === local.toLowerCase());
    return [...doc.querySelectorAll('item')].map(item => ({
        title: child(item, 'title')?.textContent || '',
        pubDate: child(item, 'pubDate')?.textContent || '',
        source: (child(item, 'source') || [...item.children].find(c => /(^|:)source$/i.test(c.nodeName)))?.textContent || '',
        link: (child(item, 'link')?.textContent || '').trim(),
        description: child(item, 'description')?.textContent || '',
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
            source: field(block, 'source') || field(block, 'News:Source'),
            link: field(block, 'link'),
            description: field(block, 'description'),
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
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&quotesCount=0`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.news || []).map(n => ({
            title: n.title,
            date: new Date(n.providerPublishTime * 1000),
            source: n.publisher || 'Yahoo Finance',
            url: n.link || null,
            // Yahoo's own tagging of which tickers the story concerns. Lets the relevance filter
            // accept "Credo" for Credo Technology without accepting "First" for First Solar.
            tickers: Array.isArray(n.relatedTickers) ? n.relatedTickers : [],
        }));
    } catch (e) { return []; }
}

// Google News appends " - Publisher" to every title. Strip exactly that, and only when it is
// there: the old /\s*-\s*[^-]+$/ also cut real titles at their last hyphen, so a Bing headline
// "T-Mobile rises on subscriber growth" would have come back as "T".
function cleanTitle(title, source = '') {
    const t = String(title || '').trim();
    const src = String(source || '').trim();
    if (src && t.toLowerCase().endsWith(` - ${src}`.toLowerCase())) return t.slice(0, t.length - src.length - 3).trim();
    return t;
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
