// Per-symbol confidence-trend mini chart.
//
// Plots the engine's confidence on ONE symbol over its recent ledger
// history as a line, dotting each resolved prediction green (hit) or
// red (miss). It answers "has the engine's conviction on this name been
// earned?" — a flat-high line full of red dots is overconfidence; a
// line that rises as green dots accumulate is the engine learning.
//
// Data comes from readSymbolConfidenceTrend (live ledger). The signal
// card renders a placeholder synchronously and calls mountConfidenceTrend
// after paint to fill it async — so a cold ledger fetch never blocks the
// card render.

import { readSymbolConfidenceTrend } from '../ledger-reader.js';

const W = 260, H = 80, PAD_L = 4, PAD_R = 4, PAD_T = 8, PAD_B = 14;

function buildSvg(points) {
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    // Confidence is a 0-100 metric but the engine lives in ~38-88; fit
    // the visible band to the data's own range (with a little padding)
    // so the line uses the vertical space instead of hugging the middle.
    const confs = points.map(p => p.confidence);
    let lo = Math.min(...confs), hi = Math.max(...confs);
    if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
    lo = Math.max(0, lo - 3); hi = Math.min(100, hi + 3);
    const range = hi - lo || 1;
    const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;

    const xy = points.map((p, i) => {
        const x = PAD_L + i * stepX;
        const y = PAD_T + plotH - ((p.confidence - lo) / range) * plotH;
        return { x, y, p };
    });

    const line = xy.map(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' ');
    // 50% coin-flip reference line, if within the visible band.
    let refLine = '';
    if (50 >= lo && 50 <= hi) {
        const refY = PAD_T + plotH - ((50 - lo) / range) * plotH;
        refLine = `<line x1="${PAD_L}" y1="${refY.toFixed(1)}" x2="${(W - PAD_R)}" y2="${refY.toFixed(1)}" class="ct-ref"/>`;
    }
    const dots = xy.map(d => {
        const cls = d.p.outcome === 'hit' ? 'hit' : d.p.outcome === 'miss' ? 'miss' : 'pending';
        const title = `${d.p.date}: ${d.p.confidence}% ${d.p.signal}${d.p.outcome ? ` — ${d.p.outcome.toUpperCase()}` : ' — unresolved'}`;
        return `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="3" class="ct-dot ${cls}"><title>${title}</title></circle>`;
    }).join('');

    return `<svg class="ct-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}" aria-label="Confidence trend">
        ${refLine}
        <polyline points="${line}" class="ct-line" fill="none"/>
        ${dots}
    </svg>`;
}

// Synchronous placeholder for the signal card to drop in immediately.
// `mountConfidenceTrend` swaps in the real chart (or removes the block).
export function renderConfidenceTrendPlaceholder(symbol) {
    if (!symbol) return '';
    return `<div class="ct-block" data-ct-symbol="${symbol}" hidden>
        <div class="ct-title">Confidence on ${symbol} — recent track</div>
        <div class="ct-host"></div>
        <div class="ct-legend">
            <span class="ct-legend-dot hit"></span> hit
            <span class="ct-legend-dot miss"></span> miss
            <span class="ct-legend-dot pending"></span> unresolved
        </div>
    </div>`;
}

// Fill the placeholder for `symbol` inside `root`. Hides the whole block
// when there isn't enough history (need >= 3 points to be a "trend").
export async function mountConfidenceTrend(root, symbol) {
    if (!root || !symbol) return;
    const block = root.querySelector(`.ct-block[data-ct-symbol="${symbol}"]`);
    if (!block) return;
    try {
        const { available, points } = await readSymbolConfidenceTrend({ symbol, limit: 30 });
        if (!available || !points || points.length < 3) {
            block.remove();
            return;
        }
        const host = block.querySelector('.ct-host');
        if (host) host.innerHTML = buildSvg(points);
        block.hidden = false;
    } catch (_) {
        block.remove();
    }
}
