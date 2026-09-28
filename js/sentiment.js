// News sentiment — word-based headline scoring, weighted by recency and source tier so stale or
// low-grade news doesn't dominate.
//
// There used to be a HuggingFace FinBERT call in front of this. It could never have worked: the
// anonymous inference endpoint is gone (api-inference.huggingface.co), its replacement
// router.huggingface.co answers 401 without a token, and this app has never held one. Every
// score in the ledger came from the word-based fallback below, so that is now simply the method.
//
// Recency decay: each headline's contribution is multiplied by
// exp(-age_hours / 48). 1h → 0.98, 12h → 0.78, 24h → 0.61, 48h → 0.37, 7d → 0.03.
// Tunes how fast yesterday's narrative fades vs. today's.

const RECENCY_HALF_LIFE_HOURS = 48;

const BULLISH_WORDS = ['surge', 'surges', 'rally', 'soar', 'jump', 'gain', 'rise', 'high', 'record', 'boom', 'bull', 'breakout', 'upgrade', 'beat', 'strong', 'growth', 'profit', 'buy', 'outperform', 'optimistic', 'boost', 'recover', 'recovery', 'momentum', 'upside', 'milestone', 'approval'];
const BEARISH_WORDS = ['crash', 'plunge', 'drop', 'fall', 'decline', 'low', 'sell', 'bear', 'loss', 'miss', 'weak', 'warning', 'fear', 'risk', 'cut', 'downgrade', 'layoff', 'bankruptcy', 'debt', 'recession', 'crisis', 'lawsuit', 'fraud', 'hack', 'worst', 'collapse', 'dump', 'tank'];

const BULLISH_SET = new Set(BULLISH_WORDS);
const BEARISH_SET = new Set(BEARISH_WORDS);

// Exact matching missed almost every real headline, because headlines inflect: "gained",
// "rallies", "soared", "plunged", "downgraded", "misses". Map a word back to a list entry by
// undoing the regular English endings instead of enumerating every form.
function inflectedIn(word, set) {
    if (set.has(word)) return true;
    if (word.length > 4 && word.endsWith('ies') && set.has(word.slice(0, -3) + 'y')) return true;   // rallies
    for (const suf of ['ing', 'ed', 'es', 's', 'd']) {
        if (word.length <= suf.length + 2 || !word.endsWith(suf)) continue;
        const base = word.slice(0, -suf.length);
        if (set.has(base) || set.has(base + 'e')) return true;                                     // gains, surging
        const n = base.length;
        if (n > 3 && base[n - 1] === base[n - 2] && set.has(base.slice(0, -1))) return true;      // dropped, cutting
    }
    return false;
}

function keywordSentiment(text) {
    const lower = String(text || '').toLowerCase();
    const words = lower.split(/\W+/).filter(Boolean);
    let bull = 0, bear = 0;
    words.forEach(word => {
        if (inflectedIn(word, BULLISH_SET)) bull++;
        if (inflectedIn(word, BEARISH_SET)) bear++;
    });
    const score = Math.max(-1, Math.min(1, (bull - bear) / 3));
    let label;
    if (score > 0.2) label = 'positive';
    else if (score < -0.2) label = 'negative';
    else label = 'neutral';
    return { score, label };
}

function recencyWeight(date) {
    if (!date) return 0.5;
    const ageHours = (Date.now() - date.getTime()) / 3_600_000;
    if (ageHours < 0) return 1;
    return Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
}

export async function analyzeNewsSentiment(newsItems, opts = {}) {
    if (!newsItems || newsItems.length === 0) {
        // available:false is the load-bearing field. score 50 here means "we have nothing
        // to say", NOT "we looked and it is balanced", and those must not be treated alike:
        // a source with no information was still taking 25% of the weighted score and
        // dragging every symbol toward neutral. computeFullConfidence now renormalises over
        // available sources, so this abstains instead of voting 50.
        return {
            overall: 'neutral',
            score: 50,
            available: false,
            items: [],
            reasons: ['No recent news available'],
            method: 'none',
        };
    }

    const items = newsItems.slice(0, 8);

    // BULK SCANS DO NOT ENRICH. Headline-only sentiment, no article fetches.
    //
    // The enrichment below costs up to ELEVEN Cloudflare Worker requests per symbol: a
    // source-tier lookup for each of 8 items plus full text for the top 3. That was harmless
    // while sentiment only ran for one symbol the user was looking at. Once sentiment started
    // working under Node, the desk began scanning ~400 tradeable names per cycle and this
    // became ~4,400 Worker requests per cycle, which is what exhausted the quota.
    //
    // Headlines alone are what the other 5 items already use, so a bulk scan loses the
    // full-text nuance on 3 headlines per symbol and keeps the signal. The on-demand path,
    // where a human is reading one symbol, still enriches.
    const bulk = opts.bulkScan === true;

    // PHASE 2: enrich top-3 most-recent articles with full body text +
    // source-tier classification. The remaining 5 stay headline-only
    // to keep extraction cost bounded (3 × ~200ms = ~600ms added to
    // the per-symbol analysis path; acceptable for on-demand). Each
    // extraction failure silently falls back to that item's headline.
    const { fetchFullArticle, tierForUrl, tierWeight } = bulk
        ? { fetchFullArticle: async () => null, tierForUrl: async () => null,
            tierWeight: () => 1 }
        : await import('./article-extractor.js');
    const sortedByRecency = items
        .map((it, idx) => ({ it, idx, when: +(new Date(it.date instanceof Date ? it.date : it.date || 0)) }))
        .sort((a, b) => b.when - a.when);
    const enrichTargets = new Set(sortedByRecency.slice(0, 3).map(x => x.idx));

    const enrichedTexts = new Array(items.length).fill(null);
    const tiers = new Array(items.length).fill(null);
    await Promise.all(items.map(async (item, i) => {
        // Source-tier always fetched (cheap; cached 24h).
        if (item.url) {
            tiers[i] = await tierForUrl(item.url).catch(() => null);
        }
        // Full-text only for top-3 by recency.
        if (enrichTargets.has(i) && item.url) {
            const article = await fetchFullArticle(item.url).catch(() => null);
            if (article?.mainText) {
                // Score the LEAD (first 1800 chars), where the article's thesis usually lives.
                // Beyond it, long bodies pile up incidental words and drown the tone.
                enrichedTexts[i] = article.mainText.slice(0, 1800);
            }
        }
    }));

    // Score the article lead where one was extracted, else the headline plus the feed's own
    // one-line summary when it sent one (Bing does), else the headline alone.
    const inputs = items.map((n, i) => enrichedTexts[i] || (n.summary ? `${n.title}. ${n.summary}` : n.title));
    const method = enrichedTexts.some(Boolean) ? 'keyword-fulltext' : 'keyword';
    const sentimentResults = inputs.map(t => [keywordSentiment(t)]);

    const analyzed = [];
    let weightedScoreSum = 0;
    let totalWeight = 0;
    let positiveCount = 0;
    let negativeCount = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const sentiment = sentimentResults[i][0];
        // Combined weight: recency × source-tier. A Tier-1 story from
        // 2 hours ago should carry more weight than a Tier-4 social
        // post from 30 minutes ago. tierWeight ranges 1.0 (Tier 1) →
        // 0.20 (Tier 4), so Tier-4 stories effectively get 80% docked.
        const recency = recencyWeight(item.date instanceof Date ? item.date : new Date(item.date));
        const tierMul = tiers[i]?.tier ? tierWeight(tiers[i].tier) : tierWeight(4);
        const weight = recency * tierMul;
        weightedScoreSum += sentiment.score * weight;
        totalWeight += weight;
        if (sentiment.label === 'positive') positiveCount++;
        if (sentiment.label === 'negative') negativeCount++;
        analyzed.push({
            title: item.title,
            date: item.date,
            source: item.source,
            url: item.url || null,
            sentiment,
            recencyWeight: +recency.toFixed(2),
            sourceTier: tiers[i]?.tier ?? 4,
            sourceDomain: tiers[i]?.domain ?? null,
            tierWeight: +tierMul.toFixed(2),
            usedFullText: !!enrichedTexts[i],
        });
    }

    const avgScore = totalWeight > 0 ? weightedScoreSum / totalWeight : 0;
    const score100 = Math.round((avgScore + 1) * 50);
    let overall;
    if (avgScore > 0.2) overall = 'positive';
    else if (avgScore < -0.2) overall = 'negative';
    else overall = 'neutral';

    const reasons = [];
    const n = items.length;
    if (overall === 'positive') reasons.push(`Headlines lean positive: ${positiveCount} of ${n} upbeat, ${negativeCount} downbeat`);
    else if (overall === 'negative') reasons.push(`Headlines lean negative: ${negativeCount} of ${n} downbeat, ${positiveCount} upbeat`);
    else reasons.push(`Headlines are mixed: ${positiveCount} of ${n} upbeat, ${negativeCount} downbeat`);

    return {
        overall,
        score: score100,
        // Real headlines were read and scored, so this source has earned its weight.
        available: true,
        items: analyzed,
        reasons,
        method,
        positiveCount,
        negativeCount,
        neutralCount: items.length - positiveCount - negativeCount,
    };
}
