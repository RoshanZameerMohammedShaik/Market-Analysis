// Phase 7 — Reddit + StockTwits social-velocity pump detector.
//
// Penny stocks (and meme stocks generally) are pump-prone. Tracking how
// FAST a name's mention rate is rising in retail-trader hubs detects the
// pump cycle in time to either (a) ride the early phase or (b) avoid
// buying right before the dump.
//
// Two free, keyless sources:
//   - Reddit's old.reddit.com search.json (already used in news pipeline)
//   - StockTwits' /api/2/streams/symbol/<sym>.json (no auth, no proxy needed)
//
// We compute mentions-per-hour over the last 24h and compare to a baseline
// 14d average from cached snapshots. A 3x+ velocity spike = pump in progress.
//
// Universal: activates for ALL stocks (not just penny). Pump risk is biggest
// on small caps but mid/large caps also get social pumps occasionally.
// Bounded ±3 pts (capped lower because pump signals decay fast and we don't
// want to over-weight noise).

import { isCooling, recordFailure, recordSuccess } from './breaker.js';

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

// Reddit search.json — direct fetch first (fastest when CORS is open),
// fall back to proxy chain. Both paths share a single breaker so a
// dead Reddit endpoint doesn't run a 4-proxy chain on every symbol.
async function fetchRedditMentions(symbol) {
    if (isCooling('reddit')) return null;
    const sub = 'wallstreetbets+stocks+pennystocks+stockmarket';
    const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(symbol)}&restrict_sr=1&sort=new&limit=100`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const json = await res.json();
            recordSuccess('reddit');
            return (json?.data?.children || []).map(c => c.data).filter(Boolean);
        }
    } catch (_) { /* fall through to proxy */ }
    try {
        const { fetchWithProxy } = await import('./data.js');
        const res = await fetchWithProxy(url);
        const json = await res.json();
        recordSuccess('reddit');
        return (json?.data?.children || []).map(c => c.data).filter(Boolean);
    } catch (_) {
        recordFailure('reddit');
        return null;
    }
}

async function fetchStockTwitsMessages(symbol) {
    if (isCooling('stocktwits')) return null;
    const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json?limit=30`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
            recordFailure('stocktwits');
            return null;
        }
        const json = await res.json();
        recordSuccess('stocktwits');
        return json?.messages || [];
    } catch (_) {
        recordFailure('stocktwits');
        return null;
    }
}

function agedMentions(items, getEpoch) {
    const now = Date.now();
    let last1h = 0, last4h = 0, last24h = 0;
    for (const item of items || []) {
        const ts = getEpoch(item);
        if (!ts) continue;
        const ageMs = now - ts;
        if (ageMs < 60 * 60 * 1000) last1h++;
        if (ageMs < 4 * 60 * 60 * 1000) last4h++;
        if (ageMs < 24 * 60 * 60 * 1000) last24h++;
    }
    return { last1h, last4h, last24h };
}

export async function getSocialVelocity(symbol) {
    if (!symbol) return null;
    const key = symbol.toUpperCase();
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

    const [redditPosts, twitsMessages] = await Promise.all([
        fetchRedditMentions(symbol),
        fetchStockTwitsMessages(symbol),
    ]);

    const reddit = agedMentions(redditPosts, p => (p.created_utc * 1000));
    const twits = agedMentions(twitsMessages, m => new Date(m.created_at).getTime());

    // Velocity score: mentions in last hour vs hour-rate over last 24h.
    // Score >3 means current hour is more than 3x the 24h baseline.
    const redditBaseline = reddit.last24h / 24;
    const twitsBaseline = twits.last24h / 24;
    const redditVelocity = redditBaseline > 0 ? reddit.last1h / redditBaseline : 0;
    const twitsVelocity = twitsBaseline > 0 ? twits.last1h / twitsBaseline : 0;
    const peakVelocity = Math.max(redditVelocity, twitsVelocity);

    let label = 'normal';
    if (peakVelocity >= 5) label = 'extreme';
    else if (peakVelocity >= 3) label = 'high';
    else if (peakVelocity >= 1.5) label = 'elevated';
    else if (reddit.last24h + twits.last24h < 3) label = 'quiet';

    const data = {
        reddit, twits,
        redditVelocity: +redditVelocity.toFixed(2),
        twitsVelocity: +twitsVelocity.toFixed(2),
        peakVelocity: +peakVelocity.toFixed(2),
        totalLast24h: reddit.last24h + twits.last24h,
        label,
    };
    CACHE.set(key, { ts: Date.now(), data });
    return data;
}

/**
 * Confidence adjustment. Universal (all tiers). Bounded ±3.
 *
 * Logic:
 *   - extreme velocity (5x+) + BUY: -3 (likely pump near peak, BUY is late)
 *   - extreme velocity + SELL: +2 (pump exhaustion supports SELL)
 *   - high velocity (3x-5x) + BUY: -1 (caution; may be early-mid pump)
 *   - quiet (<3 mentions/24h): no adjust (signal too noisy to rely on)
 */
export function socialVelocityAdjustment(signal, vel) {
    if (!vel || vel.label === 'quiet') return { adjust: 0, reasons: [] };
    const reasons = [];
    let adjust = 0;

    if (vel.label === 'extreme') {
        if (signal === 'BUY') {
            adjust -= 3;
            reasons.push(`Social velocity extreme (${vel.peakVelocity}x baseline) — likely pump near peak, BUY is risky entry`);
        } else if (signal === 'SELL') {
            adjust += 2;
            reasons.push(`Social velocity extreme (${vel.peakVelocity}x baseline) — pump exhaustion supports SELL`);
        }
    } else if (vel.label === 'high') {
        if (signal === 'BUY') {
            adjust -= 1;
            reasons.push(`Social velocity high (${vel.peakVelocity}x baseline) — mid-pump caution on BUY`);
        }
    }

    if (adjust > 3) adjust = 3;
    if (adjust < -3) adjust = -3;
    return { adjust, reasons };
}
