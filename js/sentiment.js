// AI Sentiment Analysis — HuggingFace FinBERT with keyword fallback,
// weighted by recency so stale news doesn't dominate.
//
// Recency decay: each headline's contribution is multiplied by
// exp(-age_hours / 48). 1h → 0.98, 12h → 0.78, 24h → 0.61, 48h → 0.37, 7d → 0.03.
// Tunes how fast yesterday's narrative fades vs. today's.

import { fetchWithProxy } from './data.js';

const HF_API_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';
const RECENCY_HALF_LIFE_HOURS = 48;

// HuggingFace's free inference endpoint has been gating browser-direct
// requests (403, throttling, or DNS-level blocks depending on region).
// Once a call fails this session, we stop trying so the console isn't
// spammed with the same error on every analysis. Keyword fallback
// handles all sentiment in that case — quality drops a bit but the
// engine keeps working without 30+ seconds of failed retries.
let hfBlocked = false;
async function analyzeWithFinBERT(texts) {
    if (hfBlocked) return null;
    try {
        const res = await fetch(HF_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: texts }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            // 503 = HF model warming up (will succeed on retry)
            // 401/403/429 = gated; don't bother retrying this session.
            if ([401, 403, 429].includes(res.status)) hfBlocked = true;
            return null;
        }
        return await res.json();
    } catch (_) {
        // DNS failure / network block = treat as gated for the session.
        hfBlocked = true;
        return null;
    }
}

function parseFinBERTResult(result) {
    if (!result || !Array.isArray(result)) return { score: 0, label: 'neutral' };
    let positive = 0, negative = 0, neutral = 0;
    result.forEach(item => {
        if (item.label === 'positive') positive = item.score;
        else if (item.label === 'negative') negative = item.score;
        else neutral = item.score;
    });
    const score = positive - negative;
    let label;
    if (score > 0.3) label = 'positive';
    else if (score < -0.3) label = 'negative';
    else label = 'neutral';
    return { score, label, positive, negative, neutral };
}

const BULLISH_WORDS = ['surge', 'surges', 'rally', 'soar', 'jump', 'gain', 'rise', 'high', 'record', 'boom', 'bull', 'breakout', 'upgrade', 'beat', 'strong', 'growth', 'profit', 'buy', 'outperform', 'optimistic', 'boost', 'recover', 'recovery', 'momentum', 'upside', 'milestone', 'approval'];
const BEARISH_WORDS = ['crash', 'plunge', 'drop', 'fall', 'decline', 'low', 'sell', 'bear', 'loss', 'miss', 'weak', 'warning', 'fear', 'risk', 'cut', 'downgrade', 'layoff', 'bankruptcy', 'debt', 'recession', 'crisis', 'lawsuit', 'fraud', 'hack', 'worst', 'collapse', 'dump', 'tank'];

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

function recencyWeight(date) {
    if (!date) return 0.5;
    const ageHours = (Date.now() - date.getTime()) / 3_600_000;
    if (ageHours < 0) return 1;
    return Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
}

export async function analyzeNewsSentiment(newsItems) {
    if (!newsItems || newsItems.length === 0) {
        return {
            overall: 'neutral',
            score: 50,
            items: [],
            reasons: ['No recent news available'],
            method: 'none',
        };
    }

    const items = newsItems.slice(0, 8);
    const titles = items.map(n => n.title);
    let sentimentResults = await analyzeWithFinBERT(titles);
    let method = 'ai';
    if (!sentimentResults) {
        method = 'keyword';
        sentimentResults = titles.map(t => [keywordSentiment(t)]);
    }

    const analyzed = [];
    let weightedScoreSum = 0;
    let totalWeight = 0;
    let positiveCount = 0;
    let negativeCount = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const sentiment = method === 'ai' ? parseFinBERTResult(sentimentResults[i]) : sentimentResults[i][0];
        const weight = recencyWeight(item.date instanceof Date ? item.date : new Date(item.date));
        weightedScoreSum += sentiment.score * weight;
        totalWeight += weight;
        if (sentiment.label === 'positive') positiveCount++;
        if (sentiment.label === 'negative') negativeCount++;
        analyzed.push({
            title: item.title,
            date: item.date,
            source: item.source,
            sentiment,
            recencyWeight: +weight.toFixed(2),
        });
    }

    const avgScore = totalWeight > 0 ? weightedScoreSum / totalWeight : 0;
    const score100 = Math.round((avgScore + 1) * 50);
    let overall;
    if (avgScore > 0.2) overall = 'positive';
    else if (avgScore < -0.2) overall = 'negative';
    else overall = 'neutral';

    const reasons = [];
    if (overall === 'positive') reasons.push(`${positiveCount}/${items.length} headlines bullish, recency-weighted (${method === 'ai' ? 'FinBERT' : 'keyword'})`);
    else if (overall === 'negative') reasons.push(`${negativeCount}/${items.length} headlines bearish, recency-weighted (${method === 'ai' ? 'FinBERT' : 'keyword'})`);
    else reasons.push(`Mixed sentiment: ${positiveCount}+ ${negativeCount}- (recency-weighted ${method === 'ai' ? 'FinBERT' : 'keyword'})`);

    return {
        overall,
        score: score100,
        items: analyzed,
        reasons,
        method,
        positiveCount,
        negativeCount,
        neutralCount: items.length - positiveCount - negativeCount,
    };
}
