// "Why should I trust this %?" — turns the confidence number into a
// defensible claim by showing the evidence behind it:
//   1. Ensemble consensus: how many sources back the committed signal
//      (and which ones point the other way).
//   2. Live track record: this confidence band's historical hit rate
//      per horizon, with sample size, straight from the ledger.
//   3. The honest caveat when the ledger is still too thin to prove
//      anything — we say so rather than implying empirical backing.
//
// All inputs come off the prediction object already computed by the
// engine (confidence.js): prediction.consensus and prediction.horizonBands.
// No new fetches, no new magic numbers.

import { getTrackRecordStatus } from '../calibration.js';

const SOURCE_LABEL = {
    ai: 'AI model',
    technical: 'Technicals',
    sentiment: 'Sentiment',
    market: 'Market',
};

const HORIZON_LABEL = { 1: '1 day', 3: '3 days', 5: '5 days', 10: '10 days', 20: '20 days' };

function renderConsensus(consensus, signal) {
    if (!consensus || !consensus.total) return '';
    // Order: agree first, then neutral, then against — reads like a tally.
    const order = { agree: 0, neutral: 1, against: 2, 'n/a': 3 };
    const chips = Object.entries(consensus.votes)
        .filter(([, v]) => v !== 'n/a')
        .sort((a, b) => order[a[1]] - order[b[1]])
        .map(([src, v]) => {
            const label = SOURCE_LABEL[src] || src;
            const icon = v === 'agree' ? '✓' : v === 'against' ? '✕' : '–';
            return `<span class="trust-vote ${v}" title="${label} ${v === 'agree' ? 'agrees with' : v === 'against' ? 'contradicts' : 'is neutral on'} this ${signal}">${icon} ${label}</span>`;
        }).join('');

    const headline = consensus.against > 0
        ? `${consensus.for} of ${consensus.total} sources back this call — ${consensus.against} disagree`
        : consensus.for === consensus.total
            ? `All ${consensus.total} sources agree`
            : `${consensus.for} of ${consensus.total} sources back this call`;
    const dock = consensus.confidenceDock > 0
        ? `<div class="trust-note">Confidence was reduced by ${consensus.confidenceDock} pts because sources disagree.</div>`
        : '';

    return `
        <div class="trust-block">
            <div class="trust-block-title">Source consensus</div>
            <div class="trust-headline">${headline}</div>
            <div class="trust-votes">${chips}</div>
            ${dock}
        </div>`;
}

function renderTrackRecord(bands, confidence) {
    if (!bands || !bands.length) {
        // Distinguish two honest empty states: (a) the engine was just
        // improved and is rebuilding its record under the new logic, vs
        // (b) a genuinely fresh ledger. Both are truthful; (a) is the right
        // story right after a scoring change so we don't imply the new
        // engine has no edge — only that it hasn't re-proven it YET.
        const status = getTrackRecordStatus();
        if (status && status.rebuilding) {
            return `
            <div class="trust-block">
                <div class="trust-block-title">Live track record</div>
                <div class="trust-headline thin">The engine was just improved — rebuilding its track record under the updated logic.</div>
                <div class="trust-note">Older predictions came from the previous engine, so they no longer reflect how it calls now and are set aside. Verified hit-rates reappear here as fresh calls resolve (1-day fills within days; longer horizons take longer). Until then this % is the engine's calibrated estimate, not yet a measured rate.</div>
            </div>`;
        }
        return `
            <div class="trust-block">
                <div class="trust-block-title">Live track record</div>
                <div class="trust-headline thin">Not enough resolved predictions in this confidence band yet.</div>
                <div class="trust-note">This % is the engine's calibrated estimate. Once the live ledger has 30+ resolved calls near ${confidence}%, real hit-rates will appear here.</div>
            </div>`;
    }
    const rows = bands.map(b => {
        const label = HORIZON_LABEL[b.horizonDays] || `${b.horizonDays}d`;
        const tier = b.hitRate >= 60 ? 'high' : b.hitRate >= 50 ? 'mid' : 'low';
        return `
            <div class="trust-band">
                <span class="trust-band-label">${label}</span>
                <div class="trust-band-track"><div class="trust-band-fill ${tier}" style="width:${Math.min(100, b.hitRate)}%"></div></div>
                <span class="trust-band-rate ${tier}">${b.hitRate}%</span>
                <span class="trust-band-n">n=${b.n}</span>
            </div>`;
    }).join('');
    return `
        <div class="trust-block">
            <div class="trust-block-title">Live track record — this confidence band</div>
            <div class="trust-note">How often the engine has actually been right at each horizon when this confident, from real resolved outcomes:</div>
            <div class="trust-bands">${rows}</div>
            ${edgeHorizonNote(bands)}
        </div>`;
}

// Honest "trust it more at the horizon where it has edge" note. When the
// 1-day read is at/near coin-flip but a longer horizon is meaningfully
// better on the same confidence band, say so — instead of letting the
// displayed (often 1-day-anchored) call imply equal strength across
// horizons. Only fires when the data actually supports it (both horizons
// resolved at n>=30, already guaranteed by getHorizonCalibrations).
function edgeHorizonNote(bands) {
    const oneDay = bands.find(b => b.horizonDays === 1);
    const best = bands.reduce((a, b) => (b.hitRate > a.hitRate ? b : a), bands[0]);
    if (!oneDay || !best || best.horizonDays === 1) return '';
    // Only nudge if 1d is weak (<=52%) AND a longer horizon beats it by >=5pts.
    if (oneDay.hitRate > 52 || best.hitRate - oneDay.hitRate < 5) return '';
    // Significance guard: don't assert an edge the samples can't support. The
    // gap must exceed the combined 1σ binomial SE of the two rates, else a
    // thin-sample 58%-vs-51% (whose CIs overlap) would over-claim.
    const se = (r, n) => Math.sqrt(((r / 100) * (1 - r / 100)) / Math.max(1, n)) * 100;
    const combinedSe = Math.sqrt(se(best.hitRate, best.n) ** 2 + se(oneDay.hitRate, oneDay.n) ** 2);
    if ((best.hitRate - oneDay.hitRate) < combinedSe) return '';
    const bestLabel = HORIZON_LABEL[best.horizonDays] || `${best.horizonDays}d`;
    return `<div class="trust-note trust-edge-note">⏳ The engine reads this band best at <b>${bestLabel}</b> (${best.hitRate}% historically) — its <b>1-day</b> read here is near coin-flip (${oneDay.hitRate}%). Lean on the longer horizon.</div>`;
}

// Returns the full <details> HTML for the trust panel, or '' when
// there's nothing meaningful to show (e.g. a NEUTRAL/AVOID call where
// consensus doesn't apply and no bands exist).
export function renderTrustPanel(prediction) {
    const { consensus, horizonBands, confidence, signal } = prediction;
    const committed = signal === 'BUY' || signal === 'SELL';
    const consensusHTML = committed ? renderConsensus(consensus, signal) : '';
    const trackHTML = renderTrackRecord(horizonBands, confidence);
    if (!consensusHTML && !trackHTML) return '';
    return `
        <details class="trust-panel">
            <summary class="trust-summary">
                <span class="trust-summary-icon">🛡️</span>
                <span class="trust-summary-text">Why trust this ${confidence}%?</span>
                <span class="trust-summary-chevron">▸</span>
            </summary>
            <div class="trust-body">
                ${consensusHTML}
                ${trackHTML}
            </div>
        </details>`;
}
