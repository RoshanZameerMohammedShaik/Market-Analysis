// Full-article extraction client. Hits the Cloudflare Worker's
// /extract-article endpoint to fetch a news URL server-side and
// return cleaned-up main body text. Used by:
//   - js/sentiment.js: top-N articles per symbol get full-text
//     FinBERT scoring instead of headline-only.
//   - js/mia/tools.js: Mia's evaluate_news_for_symbol tool.
//
// Per Roshan's architecture: ON-DEMAND ONLY. We fetch full text for
// the symbol the user actually clicks/queries — never for the whole
// universe. Keeps the worker request budget small (50-100 fetches
// per active session vs. thousands).
//
// Honest caveats:
//   - Failure is non-fatal: any error returns null and the caller
//     falls back to headline-only behavior.
//   - 5-minute server-side cache (worker side) means repeated calls
//     for the same URL are free.
//   - Source-tier classification is a separate endpoint so callers
//     that just want the tier (without full text) don't pay the
//     extraction cost.

import { isCooling, recordFailure, recordSuccess } from './breaker.js';

const PROXY_BASE = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';
const TIER_CACHE = new Map();      // domain -> { tier, domain }
const TIER_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch + extract main body of an article URL. Returns the extraction
 * object on success, null on failure. Caller decides what to do with
 * null (typically: fall back to the headline).
 */
export async function fetchFullArticle(url) {
    if (!url) return null;
    if (isCooling('article-extractor')) return null;
    try {
        const u = `${PROXY_BASE}/extract-article?url=${encodeURIComponent(url)}`;
        const res = await fetch(u, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
            recordFailure('article-extractor');
            return null;
        }
        const data = await res.json();
        if (data?.error || !data?.mainText) {
            // Don't trip the breaker for per-article extraction failures —
            // one bad URL shouldn't kill all extractions site-wide.
            return null;
        }
        recordSuccess('article-extractor');
        return data;
    } catch (e) {
        recordFailure('article-extractor');
        return null;
    }
}

/**
 * Returns { tier: 1|2|3|4, domain } for a given domain string.
 * Aggressively cached (24h) since source taxonomy doesn't change often.
 */
export async function classifySourceDomain(domain) {
    if (!domain) return { tier: 4, domain: null };
    const norm = String(domain).toLowerCase().replace(/^www\./, '').trim();
    const cached = TIER_CACHE.get(norm);
    if (cached && Date.now() - cached.ts < TIER_CACHE_MS) return cached.data;
    try {
        const u = `${PROXY_BASE}/source-tier?domain=${encodeURIComponent(norm)}`;
        const res = await fetch(u, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return { tier: 4, domain: norm };
        const data = await res.json();
        TIER_CACHE.set(norm, { ts: Date.now(), data });
        return data;
    } catch (e) {
        return { tier: 4, domain: norm };
    }
}

/**
 * Multiplier applied to a news item's recency-weighted contribution
 * based on its source tier. Tier 1 = full weight, Tier 4 = heavily
 * discounted. Calibrated so a Tier-1 story counts ~5x a Tier-4 post.
 */
export function tierWeight(tier) {
    if (tier === 1) return 1.0;
    if (tier === 2) return 0.85;
    if (tier === 3) return 0.50;
    return 0.20;
}

/**
 * Convenience: given a news URL, return { domain, tier, weight } in
 * one shot. Used by sentiment.js to enrich each item before scoring.
 */
export async function tierForUrl(url) {
    if (!url) return { domain: null, tier: 4, weight: 0.20 };
    let domain;
    try { domain = new URL(url).hostname; } catch (_) { return { domain: null, tier: 4, weight: 0.20 }; }
    const result = await classifySourceDomain(domain);
    return {
        domain: result.domain || domain,
        tier: result.tier ?? 4,
        weight: tierWeight(result.tier ?? 4),
    };
}
