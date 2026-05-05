// AI Sentiment Analysis — HuggingFace Inference API (free tier)
// Uses FinBERT (financial sentiment model) for real NLP analysis

import { fetchWithProxy } from './data.js';

const HF_API_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';

// ─── HUGGINGFACE NLP SENTIMENT ───────────────────────────────────────────────

async function analyzeWithFinBERT(texts) {
    try {
        const res = await fetch(HF_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: texts }),
            signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
            // Model might be loading (503) — fall back to keyword analysis
            if (res.status === 503) return null;
            return null;
        }

        const results = await res.json();
        return results;
    } catch (e) {
        return null;
    }
}

// ─── PROCESS SENTIMENT RESULTS ───────────────────────────────────────────────

function parseFinBERTResult(result) {
    // FinBERT returns: [{label: "positive", score: 0.9}, {label: "negative"...}, {label: "neutral"...}]
    if (!result || !Array.isArray(result)) return { score: 0, label: 'neutral' };

    let positive = 0, negative = 0, neutral = 0;

    result.forEach(item => {
        if (item.label === 'positive') positive = item.score;
        else if (item.label === 'negative') negative = item.score;
        else neutral = item.score;
    });

    // Convert to -1 to +1 scale
    const score = positive - negative;
    let label;
    if (score > 0.3) label = 'positive';
    else if (score < -0.3) label = 'negative';
    else label = 'neutral';

    return { score, label, positive, negative, neutral };
}

// ─── KEYWORD FALLBACK (when HF is unavailable) ──────────────────────────────

const BULLISH_WORDS = [
    'surge', 'surges', 'rally', 'soar', 'jump', 'gain', 'rise', 'high',
    'record', 'boom', 'bull', 'breakout', 'upgrade', 'beat', 'strong',
    'growth', 'profit', 'buy', 'outperform', 'optimistic', 'boost',
    'recover', 'recovery', 'momentum', 'upside', 'milestone', 'approval',
];

const BEARISH_WORDS = [
    'crash', 'plunge', 'drop', 'fall', 'decline', 'low', 'sell',
    'bear', 'loss', 'miss', 'weak', 'warning', 'fear', 'risk', 'cut',
    'downgrade', 'layoff', 'bankruptcy', 'debt', 'recession', 'crisis',
    'lawsuit', 'fraud', 'hack', 'worst', 'collapse', 'dump', 'tank',
];

function keywordSentiment(text) {
    const lower = text.toLowerCase();
    const words = lower.split(/\W+/);

    let bull = 0, bear = 0;
    words.forEach(word => {
        if (BULLISH_WORDS.includes(word)) bull++;
        if (BEARISH_WORDS.includes(word)) bear++;
    });

    const score = Math.max(-1, Math.min(1, (bull - bear) / 3));
    let label;
    if (score > 0.2) label = 'positive';
    else if (score < -0.2) label = 'negative';
    else label = 'neutral';

    return { score, label };
}

// ─── MAIN SENTIMENT ANALYSIS FUNCTION ────────────────────────────────────────

export async function analyzeNewsSentiment(newsItems) {
    if (!newsItems || newsItems.length === 0) {
        return {
            overall: 'neutral',
            score: 50,  // 0-100 scale (50 = neutral)
            items: [],
            reasons: ['No recent news available'],
            method: 'none',
        };
    }

    const titles = newsItems.map(item => item.title).slice(0, 8);
    let sentimentResults = null;
    let method = 'ai';

    // Try HuggingFace FinBERT first
    sentimentResults = await analyzeWithFinBERT(titles);

    // If HF failed, use keyword fallback
    if (!sentimentResults) {
        method = 'keyword';
        sentimentResults = titles.map(title => [keywordSentiment(title)]);
    }

    // Process results
    const analyzed = [];
    let totalScore = 0;
    let positiveCount = 0;
    let negativeCount = 0;

    for (let i = 0; i < titles.length; i++) {
        let sentiment;
        if (method === 'ai') {
            sentiment = parseFinBERTResult(sentimentResults[i]);
        } else {
            sentiment = sentimentResults[i][0];
        }

        analyzed.push({
            title: newsItems[i].title,
            date: newsItems[i].date,
            source: newsItems[i].source,
            sentiment,
        });

        totalScore += sentiment.score;
        if (sentiment.label === 'positive') positiveCount++;
        if (sentiment.label === 'negative') negativeCount++;
    }

    const avgScore = totalScore / titles.length;  // -1 to +1

    // Convert to 0-100 bullish scale
    const score100 = Math.round((avgScore + 1) * 50);  // -1→0, 0→50, +1→100

    let overall;
    if (avgScore > 0.2) overall = 'positive';
    else if (avgScore < -0.2) overall = 'negative';
    else overall = 'neutral';

    // Generate human-readable summary
    const reasons = [];
    if (overall === 'positive') {
        reasons.push(`${positiveCount}/${titles.length} headlines bullish — positive sentiment (${method === 'ai' ? 'AI' : 'keyword'} analysis)`);
    } else if (overall === 'negative') {
        reasons.push(`${negativeCount}/${titles.length} headlines bearish — negative pressure (${method === 'ai' ? 'AI' : 'keyword'} analysis)`);
    } else {
        reasons.push(`Mixed sentiment: ${positiveCount} positive, ${negativeCount} negative (${method === 'ai' ? 'AI' : 'keyword'} analysis)`);
    }

    return {
        overall,
        score: score100,  // 0-100 bullish scale
        items: analyzed,
        reasons,
        method,
        positiveCount,
        negativeCount,
        neutralCount: titles.length - positiveCount - negativeCount,
    };
}
