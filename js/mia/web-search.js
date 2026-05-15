// Level 3 — keyless web search via Google News RSS.
//
// Why not DuckDuckGo HTML: every CORS proxy in our chain is blocked from
// fetching html.duckduckgo.com (they detect proxy UAs and refuse). Tested
// live, returned 0 parseable results.
//
// Why Google News RSS instead:
//   - Same proxy chain works fine (already used by news.js)
//   - Returns a clean XML SERP; no fragile HTML scraping
//   - News-focused — exactly the right tool for "what's happening with X"
//   - 100 results per query so we can rank/filter cheaply
//
// Trade-off: this isn't general-purpose web search anymore. It's news-only.
// For Mia's job (filling gaps the engine doesn't track — breaking news,
// macro events, narrative shifts), news is the highest-value lookup.
//
// Risk surface: untrusted internet text. Mia must:
//   - Cite source domains in the answer
//   - Use "reportedly" prefix for any claim
//   - Never echo a number from web_search without attribution
//
// Result shape preserved as { query, results: [{title, url, domain, snippet}] }
// so callers don't need to change.

import { fetchWithProxy } from '../data.js';

const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 220;

function extractDomain(s) {
    if (!s) return null;
    // Some Google News items embed the source as plain text. Otherwise parse URL.
    try { return new URL(s).hostname.replace(/^www\./, ''); }
    catch (_) { return s.toLowerCase().replace(/^www\./, '').slice(0, 60); }
}

function unwrapGoogleNewsLink(href) {
    if (!href) return href;
    // Google News /rss/articles/<base64> redirects through articles.google.com.
    // We pass the link through as-is; it resolves to the publisher when clicked.
    return href;
}

/**
 * args: { query: string, maxResults?: number }
 * Returns: { query, results: [{title, url, domain, snippet}] }
 */
export async function webSearch({ query, maxResults = MAX_RESULTS }) {
    if (!query || typeof query !== 'string') return { error: 'query required' };
    const cap = Math.min(MAX_RESULTS, Math.max(1, Number(maxResults) || MAX_RESULTS));
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    try {
        const res = await fetchWithProxy(url);
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const items = doc.querySelectorAll('item');
        if (!items.length) return { query, results: [], note: 'no results parsed' };
        const results = [];
        items.forEach(item => {
            if (results.length >= cap) return;
            const title = (item.querySelector('title')?.textContent || '').trim();
            const link = unwrapGoogleNewsLink((item.querySelector('link')?.textContent || '').trim());
            const sourceText = (item.querySelector('source')?.textContent || '').trim();
            const description = (item.querySelector('description')?.textContent || '')
                .replace(/<[^>]+>/g, '')
                .replace(/&[a-z]+;/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, MAX_SNIPPET_CHARS);
            const domain = sourceText || extractDomain(link) || '';
            if (title && domain) {
                results.push({
                    title: title.slice(0, 160),
                    url: link,
                    domain,
                    snippet: description,
                });
            }
        });
        return { query, results };
    } catch (e) {
        return { query, error: String(e.message || e) };
    }
}
