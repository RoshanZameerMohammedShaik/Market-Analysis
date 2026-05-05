// News & Sentiment Analysis Module
// Sources: Google News RSS (via proxy), CoinGecko trending, Yahoo Finance news

import { fetchWithProxy } from './data.js';

// ─── NEWS FETCHING ───────────────────────────────────────────────────────────

export async function fetchStockNews(symbol, companyName = '') {
    const query = companyName || symbol;
    const results = [];

    // Try multiple free news sources
    const sources = await Promise.allSettled([
        fetchGoogleNews(query + ' stock'),
        fetchYahooNews(symbol),
    ]);

    sources.forEach(s => {
        if (s.status === 'fulfilled' && s.value) {
            results.push(...s.value);
        }
    });

    // Deduplicate by title similarity and sort by date
    const unique = deduplicateNews(results);
    return unique.slice(0, 8);
}

export async function fetchCryptoNews(coinName) {
    const results = [];

    const sources = await Promise.allSettled([
        fetchGoogleNews(coinName + ' crypto'),
        fetchGoogleNews(coinName + ' price'),
    ]);

    sources.forEach(s => {
        if (s.status === 'fulfilled' && s.value) {
            results.push(...s.value);
        }
    });

    const unique = deduplicateNews(results);
    return unique.slice(0, 8);
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
        if (i >= 10) return;
        const title = item.querySelector('title')?.textContent || '';
        const pubDate = item.querySelector('pubDate')?.textContent || '';
        const source = item.querySelector('source')?.textContent || '';
        const link = item.querySelector('link')?.textContent || '';

        if (title) {
            items.push({
                title: cleanTitle(title),
                date: pubDate ? new Date(pubDate) : new Date(),
                source,
                link,
                sentiment: analyzeSentiment(title),
            });
        }
    });

    return items;
}

// ─── YAHOO FINANCE NEWS ──────────────────────────────────────────────────────

async function fetchYahooNews(symbol) {
    try {
        const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5&quotesCount=0`;
        const res = await fetchWithProxy(url);
        const json = await res.json();
        return (json.news || []).map(n => ({
            title: n.title,
            date: new Date(n.providerPublishTime * 1000),
            source: n.publisher || 'Yahoo Finance',
            link: n.link || '',
            sentiment: analyzeSentiment(n.title),
        }));
    } catch (e) {
        return [];
    }
}

// ─── SENTIMENT ANALYSIS ──────────────────────────────────────────────────────

const BULLISH_WORDS = [
    'surge', 'surges', 'surging', 'rally', 'rallies', 'rallying', 'soar', 'soars',
    'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'rising', 'up', 'high',
    'record', 'boom', 'bull', 'bullish', 'breakout', 'upgrade', 'beat', 'beats',
    'strong', 'growth', 'profit', 'profits', 'revenue', 'buy', 'outperform',
    'optimistic', 'positive', 'boost', 'recover', 'recovery', 'momentum',
    'upside', 'best', 'top', 'innovation', 'launch', 'partnership', 'deal',
    'approval', 'success', 'exceed', 'exceeds', 'impressive', 'milestone',
];

const BEARISH_WORDS = [
    'crash', 'crashes', 'crashing', 'plunge', 'plunges', 'drop', 'drops',
    'fall', 'falls', 'falling', 'decline', 'declines', 'down', 'low', 'sell',
    'bear', 'bearish', 'loss', 'losses', 'miss', 'misses', 'weak', 'warning',
    'fear', 'concern', 'risk', 'risks', 'cut', 'cuts', 'downgrade', 'layoff',
    'layoffs', 'bankruptcy', 'debt', 'recession', 'inflation', 'crisis',
    'investigation', 'lawsuit', 'fine', 'penalty', 'fraud', 'hack', 'breach',
    'worst', 'trouble', 'struggle', 'slump', 'dump', 'collapse', 'tank',
];

const STRONG_BULLISH = ['surge', 'soar', 'record high', 'breakout', 'skyrocket', 'moon'];
const STRONG_BEARISH = ['crash', 'plunge', 'collapse', 'bankruptcy', 'fraud', 'crisis'];

export function analyzeSentiment(text) {
    const lower = text.toLowerCase();
    const words = lower.split(/\W+/);

    let score = 0;
    let bullCount = 0;
    let bearCount = 0;

    words.forEach(word => {
        if (BULLISH_WORDS.includes(word)) {
            score += 1;
            bullCount++;
        }
        if (BEARISH_WORDS.includes(word)) {
            score -= 1;
            bearCount++;
        }
    });

    // Check for strong phrases
    STRONG_BULLISH.forEach(phrase => {
        if (lower.includes(phrase)) score += 2;
    });
    STRONG_BEARISH.forEach(phrase => {
        if (lower.includes(phrase)) score -= 2;
    });

    // Normalize to -1 to +1
    const normalized = Math.max(-1, Math.min(1, score / 3));

    let label;
    if (normalized > 0.3) label = 'positive';
    else if (normalized < -0.3) label = 'negative';
    else label = 'neutral';

    return { score: normalized, label, bullCount, bearCount };
}

// ─── AGGREGATE SENTIMENT ─────────────────────────────────────────────────────

export function aggregateNewsSentiment(newsItems) {
    if (!newsItems || newsItems.length === 0) {
        return { overall: 'neutral', score: 0, confidence: 0, summary: 'No recent news found' };
    }

    // Weight recent news more heavily
    const now = Date.now();
    let weightedScore = 0;
    let totalWeight = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;

    newsItems.forEach(item => {
        const ageHours = (now - item.date.getTime()) / (1000 * 60 * 60);
        // Exponential decay: news older than 48h gets less weight
        const recencyWeight = Math.exp(-ageHours / 48);
        const weight = recencyWeight;

        weightedScore += item.sentiment.score * weight;
        totalWeight += weight;

        if (item.sentiment.label === 'positive') positiveCount++;
        else if (item.sentiment.label === 'negative') negativeCount++;
        else neutralCount++;
    });

    const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    let overall;
    if (avgScore > 0.2) overall = 'positive';
    else if (avgScore < -0.2) overall = 'negative';
    else overall = 'neutral';

    // Confidence in sentiment read (0-100)
    const totalSentiment = positiveCount + negativeCount;
    const agreement = totalSentiment > 0
        ? Math.abs(positiveCount - negativeCount) / totalSentiment
        : 0;
    const confidence = Math.round(agreement * 100);

    // Generate human-readable summary
    const summary = generateNewsSummary(newsItems, overall, positiveCount, negativeCount);

    return { overall, score: avgScore, confidence, summary, positiveCount, negativeCount, neutralCount };
}

function generateNewsSummary(items, overall, posCount, negCount) {
    const total = items.length;

    if (overall === 'positive') {
        return `${posCount} of ${total} recent headlines are bullish — market sentiment favors upside`;
    } else if (overall === 'negative') {
        return `${negCount} of ${total} recent headlines are bearish — negative sentiment may pressure price`;
    } else {
        return `Mixed news sentiment (${posCount} positive, ${negCount} negative) — no clear directional bias from news`;
    }
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function cleanTitle(title) {
    // Remove source suffix that Google News appends
    return title.replace(/\s*-\s*[^-]+$/, '').trim();
}

function deduplicateNews(items) {
    const seen = new Set();
    return items.filter(item => {
        // Simple dedup by first 40 chars of title
        const key = item.title.substring(0, 40).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => b.date - a.date);
}
