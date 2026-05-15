// Level 3 — keyless web search via DuckDuckGo HTML.
//
// Why DuckDuckGo HTML: no API key, returns a parseable HTML SERP, and is
// reasonably reliable for breaking-news lookups. Fed through the existing
// CORS-proxy chain (data.js) so we don't need a backend.
//
// Risk surface:
//   - Returned content is untrusted internet text. Mia must cite the source
//     and treat results as 'reportedly' rather than ground truth.
//   - Result size is capped (5 results, 200 chars per snippet) so a malicious
//     SERP can't blow our prompt budget.
//
// Prompt-side defenses (in prompt.js): when web_search results are present,
// require an explicit "according to <domain>" attribution in the answer,
// and never echo a number that came from web_search without that attribution.

import { fetchWithProxy } from '../data.js';

const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 220;

function extractDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

function cleanText(s) {
    return String(s || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseDdgHtml(html) {
    const out = [];
    // DuckDuckGo HTML SERP: each result block has a class containing 'result__'.
    const blockRe = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div class="result)/gi;
    let m;
    while ((m = blockRe.exec(html)) && out.length < MAX_RESULTS) {
        const block = m[1];
        const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;
        let url = titleMatch[1];
        // DDG wraps URLs in /l/?uddg= redirect; unwrap.
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) {
            try { url = decodeURIComponent(uddg[1]); } catch (_) {}
        }
        const title = cleanText(titleMatch[2]);
        const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        const snippet = snippetMatch ? cleanText(snippetMatch[1]).slice(0, MAX_SNIPPET_CHARS) : '';
        const domain = extractDomain(url) || '';
        if (title && domain) out.push({ title, url, domain, snippet });
    }
    return out;
}

/**
 * args: { query: string, maxResults?: number }
 * Returns: { query, results: [{title, url, domain, snippet}] }
 */
export async function webSearch({ query, maxResults = MAX_RESULTS }) {
    if (!query || typeof query !== 'string') return { error: 'query required' };
    const cap = Math.min(MAX_RESULTS, Math.max(1, Number(maxResults) || MAX_RESULTS));
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const res = await fetchWithProxy(url);
        const html = await res.text();
        const results = parseDdgHtml(html).slice(0, cap);
        if (!results.length) return { query, results: [], note: 'no results parsed' };
        return { query, results };
    } catch (e) {
        return { query, error: String(e.message || e) };
    }
}
