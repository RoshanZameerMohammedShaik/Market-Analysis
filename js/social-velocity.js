// Phase 7. StockTwits social-velocity pump detector.
//
// Penny stocks (and meme stocks generally) are pump-prone. Tracking how
// FAST a name's mention rate is rising in retail-trader hubs detects the
// pump cycle in time to either (a) ride the early phase or (b) avoid
// buying right before the dump.
//
// Source: StockTwits' /api/2/streams/symbol/<sym>.json (keyless; a browser reaches it through
// our Worker because StockTwits sends no CORS header).
//
// Velocity compares how fast the newest half of the latest 30 messages arrived against the oldest
// half (see sampleVelocity). A 3x+ burst = pump in progress.
//
// Universal: activates for ALL stocks (not just penny). Pump risk is biggest
// on small caps but mid/large caps also get social pumps occasionally.
// Bounded ±3 pts (capped lower because pump signals decay fast and we don't
// want to over-weight noise).

import { isCooling, recordFailure, recordSuccess } from './breaker.js';

const WORKER_BASE = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';
const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

// Reddit USED to be a second source here. Its anonymous search.json now answers 403 ("Blocked")
// to browsers, to GitHub's runners and to server fetches alike, and every public CORS proxy that
// once relayed it is dead (measured 2026-09-28). All it still produced was up to four failed
// proxy requests per symbol per scan, so it is gone; StockTwits (through our Worker) remains.
async function fetchStockTwitsMessages(symbol) {
    if (isCooling('stocktwits')) return null;
    // StockTwits carries US listings. A Yahoo exchange suffix (.NS, .T, .L) names a listing it does
    // not have, so asking is a guaranteed miss (the tour asked for "6594.T").
    const sym = String(symbol || '').toUpperCase();
    if (/\.[A-Z]{1,3}$/.test(sym) || !/^[A-Z][A-Z0-9-]{0,9}$/.test(sym)) return null;
    // A browser cannot read StockTwits directly (no CORS header on its responses), so it goes
    // through our Worker, which returns only the message timestamps. Node has no CORS.
    const url = isBrowser()
        ? `${WORKER_BASE}/stocktwits?symbol=${encodeURIComponent(sym)}`
        : `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json?limit=30`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        // An unknown symbol is an answer, not an outage. Tripping the breaker on it would silence
        // the source for every symbol that follows.
        if (res.status === 404) return [];
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

/**
 * How much faster the newest half of a sample arrived than the oldest half, each measured over
 * its own time span. 1 means a steady stream; 5 means the latest messages came five times faster.
 *
 * This replaces "mentions in the last hour / (mentions in 24h / 24)", which cannot work on these
 * feeds because both return a CAPPED sample: 30 StockTwits messages, 100 Reddit posts. For any
 * name people are actively discussing, the whole sample falls inside the last hour, so last1h =
 * last24h = 30 and the ratio is 30 / 1.25 = 24x -- "extreme" -- and every BUY on a popular stock
 * took the pump penalty for being popular. Comparing the sample against itself is immune to the
 * cap. It cannot see a pump that has already run longer than the sample spans, which is the
 * honest limit of 30 messages.
 */
export function sampleVelocity(epochs, now = Date.now()) {
    const ts = (epochs || []).filter(t => Number.isFinite(t) && t <= now).sort((a, b) => b - a);
    const n = ts.length;
    if (n < 6) return 0;
    const half = Math.floor(n / 2);
    const tMid = ts[half - 1];              // oldest message of the newest half
    const tOld = ts[n - 1];
    const MIN_HOURS = 1 / 60;               // one minute floor, so a burst cannot divide by zero
    const newRate = half / Math.max((now - tMid) / 3.6e6, MIN_HOURS);
    const oldRate = (n - half) / Math.max((tMid - tOld) / 3.6e6, MIN_HOURS);
    return oldRate > 0 ? newRate / oldRate : 0;
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

    const twitsMessages = await fetchStockTwitsMessages(symbol);
    // No data is not the same as quiet: an unreachable feed must not read as "nobody is talking".
    if (twitsMessages == null) return null;

    const twitsEpoch = m => new Date(m.created_at).getTime();
    const reddit = { last1h: 0, last4h: 0, last24h: 0 };
    const twits = agedMentions(twitsMessages, twitsEpoch);

    // Velocity: newest half of the sample against its oldest half (see sampleVelocity).
    const redditVelocity = 0;
    const twitsVelocity = sampleVelocity(twitsMessages.map(twitsEpoch));
    const peakVelocity = twitsVelocity;

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
            reasons.push(`Social velocity extreme (${vel.peakVelocity}x baseline), likely pump near peak, BUY is risky entry`);
        } else if (signal === 'SELL') {
            adjust += 2;
            reasons.push(`Social velocity extreme (${vel.peakVelocity}x baseline), pump exhaustion supports SELL`);
        }
    } else if (vel.label === 'high') {
        if (signal === 'BUY') {
            adjust -= 1;
            reasons.push(`Social velocity high (${vel.peakVelocity}x baseline), mid-pump caution on BUY`);
        }
    }

    if (adjust > 3) adjust = 3;
    if (adjust < -3) adjust = -3;
    return { adjust, reasons };
}
