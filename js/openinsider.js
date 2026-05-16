// Phase 7 — OpenInsider net insider buy/sell signal.
//
// Insider buying on penny stocks is a HUGE signal because:
//   - Officers/directors have material non-public info on small companies
//   - Cluster buys (multiple insiders in same window) historically precede 30d returns
//   - Insider sells on pennies are weaker (often just diversification, not bearish)
//
// We call OpenInsider via our Worker, parse last-30-day rows, and emit:
//   - Net buy value (USD), buy count vs sell count
//   - Adjustment based on cluster-buy patterns
//
// Activates only on tier='penny'. Bounded ±6 pts.

const WORKER_URL = 'https://market-analysis-yahoo-proxy.roshanzameer7866.workers.dev';

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;

export async function getOpenInsider(symbol) {
    if (!symbol) return null;
    const key = symbol.toUpperCase();
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
    try {
        const url = `${WORKER_URL}/openinsider?symbol=${encodeURIComponent(symbol)}&t=${Date.now()}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || !json.found) {
            CACHE.set(key, { ts: Date.now(), data: null });
            return null;
        }
        CACHE.set(key, { ts: Date.now(), data: json });
        return json;
    } catch (_) { return null; }
}

/**
 * Confidence adjustment. Penny tier only. Bounded ±6.
 *
 * Logic:
 *   - 3+ insider buys in 30d + BUY signal: +5 (cluster-buy momentum)
 *   - Net positive insider buy value > $100K + BUY: +3
 *   - 3+ insider sells + BUY signal: -3 (caution but not killing the trade)
 *   - Heavy insider selling (>$500K net) + any signal: -2 (diversification noise mostly)
 */
export function openInsiderAdjustment(signal, oi, currentTier) {
    if (currentTier !== 'penny') return { adjust: 0, reasons: [] };
    if (!oi || !oi.found) return { adjust: 0, reasons: [] };
    const reasons = [];
    let adjust = 0;

    if (oi.buyCount >= 3 && signal === 'BUY') {
        adjust += 5;
        reasons.push(`OpenInsider: ${oi.buyCount} insider buys in last 30d — cluster-buy pattern, BUY tailwind`);
    } else if (oi.netBuyValue > 100000 && signal === 'BUY') {
        adjust += 3;
        reasons.push(`OpenInsider: net insider buys $${formatUsd(oi.netBuyValue)} — BUY supported`);
    }

    if (oi.sellCount >= 3 && signal === 'BUY') {
        adjust -= 3;
        reasons.push(`OpenInsider: ${oi.sellCount} insider sells in last 30d — BUY confidence reduced`);
    }

    if (oi.netBuyValue < -500000) {
        adjust -= 2;
        reasons.push(`OpenInsider: net insider sells $${formatUsd(-oi.netBuyValue)} — caution`);
    }

    if (adjust > 6) adjust = 6;
    if (adjust < -6) adjust = -6;
    return { adjust, reasons };
}

function formatUsd(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return String(Math.round(n));
}
