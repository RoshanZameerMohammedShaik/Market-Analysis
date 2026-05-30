// AI Sentiment Analysis — HuggingFace FinBERT with keyword fallback,
// weighted by recency so stale news doesn't dominate.
//
// Recency decay: each headline's contribution is multiplied by
// exp(-age_hours / 48). 1h → 0.98, 12h → 0.78, 24h → 0.61, 48h → 0.37, 7d → 0.03.
// Tunes how fast yesterday's narrative fades vs. today's.

import { fetchWithProxy } from './data.js';

const HF_API_URL = 'https://api-inference.huggingface.co/models/ProsusAI/finbert';
const RECENCY_HALF_LIFE_HOURS = 48;

// HuggingFace's free inference endpoint gates browser-direct requests
// inconsistently (403/429/DNS-block depending on region/time). We don't
// want to permanently disable FinBERT for the whole session on a
// transient failure, but we also don't want to spam retries every
// analysis. Compromise: cool-down only AFTER 2 failures within a
// 5-minute window. After the cool-down expires (10 min), the next
// analysis tries again. Keyword fallback covers the cool-down period.
const HF_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const HF_COOLDOWN_MS = 10 * 60 * 1000;
const HF_FAILURE_THRESHOLD = 2;
let hfFailureTimestamps = [];
let hfCooldownUntil = 0;

function recordHfFailure() {
    const now = Date.now();
    hfFailureTimestamps = hfFailureTimestamps.filter(ts => now - ts < HF_FAILURE_WINDOW_MS);
    hfFailureTimestamps.push(now);
    if (hfFailureTimestamps.length >= HF_FAILURE_THRESHOLD) {
        hfCooldownUntil = now + HF_COOLDOWN_MS;
        hfFailureTimestamps = [];
    }
}

async function analyzeWithFinBERT(texts) {
    if (Date.now() < hfCooldownUntil) return null;
    try {
        const res = await fetch(HF_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: texts }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            // 503 = HF model warming up — record one failure but it
            // typically succeeds on the very next call.
            // 401/403/429 = harder gating; same recording, but two of
            // these in 5 min triggers the 10-min cool-down.
            if ([401, 403, 429, 503].includes(res.status)) recordHfFailure();
            return null;
        }
        return await res.json();
    } catch (_) {
        recordHfFailure();
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
