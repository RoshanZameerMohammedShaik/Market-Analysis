// Suggested Decision — the hero takeaway of the analysis section.
//
// Roshan's spec: stop showing a bare one-word signal (esp. the cold
// "NEUTRAL"/"DON'T BUY"). Instead, tell the user — in plain language with REAL
// numbers — what the engine predicts and what to DO given whether they own it:
//
//   • Strong up   → "predicted to rise ~X% from $cur to ~$high by Today/Tomorrow"
//                   Signal: BUY (if not owned) · HOLD (if owned)
//   • Strong down → "predicted to fall ~X% from $cur to ~$low by Today/Tomorrow"
//                   Signal: SELL (if owned) · DON'T BUY (if not owned)
//   • No strong move → "predicted to move only ~X%, within its usual ~Y% — no
//                   clear edge"  Signal: HOLD (if owned) · DON'T BUY (if not)
//
// Everything is DYNAMIC and works for stocks AND crypto:
//   - predicted move %  = the engine's own committed directional target
//     (priceTargets.highPercent for an up-lean, lowPercent for a down-lean).
//   - "usual move" %    = expectedMove / currentPrice * 100 — the per-symbol
//     ATR-based typical move. No hardcoded 5% (would mislabel pennies/crypto).
//   - "strong" is decided by comparing those two NUMBERS the user can see:
//     the predicted move is strong when its magnitude >= the stock's own usual
//     move. We show both numbers so the threshold is self-evident, never a "bar".
//
// Honesty guard: when calibrated confidence < 50% (worse than a coin flip on
// direction by the engine's grounded data), we append an "exploratory" caveat
// so a weak call never reads as conviction.

import { fmtPriceTag } from './format.js';

// Round a % for display: 1 decimal under 10, whole number above.
function pct(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    return (a < 10 ? a.toFixed(1) : Math.round(a).toString());
}

/**
 * Build the Suggested Decision block.
 * @param {object} view      the render view: { signal, confidence, priceTargets }
 * @param {object} opts      { timeframe, ticker, name, owned, currency }
 * @returns {string} HTML (empty string if we lack price targets to reason on)
 */
export function renderSuggestedDecision(view, opts = {}) {
    const { signal, confidence, priceTargets: pt } = view;
    if (!pt || !Number.isFinite(pt.currentPrice) || pt.currentPrice <= 0) return '';

    const tfWord = opts.timeframe === 'today' ? 'Today' : 'Tomorrow';
    const co = { srcCurrency: (opts.currency || 'USD').toUpperCase() };
    const owned = !!opts.owned;
    const ticker = opts.ticker || '';
    const name = opts.name || '';
    const who = name ? `${ticker} (${name})` : ticker || 'This asset';

    // The stock's OWN usual move (ATR-based, per-symbol, works for crypto too).
    const usualPct = (pt.expectedMove != null && pt.currentPrice)
        ? (pt.expectedMove / pt.currentPrice) * 100
        : null;

    // The engine's committed directional lean + its magnitude.
    // BUY → upside target; SELL → downside target; NEUTRAL → whichever side
    // the predicted range leans toward (net of the two % targets).
    const up = Number(pt.highPercent);    // signed, usually +
    const down = Number(pt.lowPercent);   // signed, usually −
    let dir;            // 'up' | 'down' | 'flat'
    let movePct;        // signed predicted move % we headline
    let targetPrice;    // the price we headline
    if (signal === 'BUY') { dir = 'up'; movePct = up; targetPrice = pt.predictedHigh; }
    else if (signal === 'SELL') { dir = 'down'; movePct = down; targetPrice = pt.predictedLow; }
    else {
        // NEUTRAL / NO_TRADE: lean toward the bigger-magnitude side of the range.
        if (Math.abs(up) >= Math.abs(down)) { dir = 'up'; movePct = up; targetPrice = pt.predictedHigh; }
        else { dir = 'down'; movePct = down; targetPrice = pt.predictedLow; }
    }

    // STRONG = the predicted move's magnitude meets/exceeds the stock's own
    // usual move. When we don't have a usual-move number, fall back to the raw
    // signal (BUY/SELL = strong, else not) so the block still works.
    const mag = Math.abs(movePct);
    const strong = (usualPct != null && Number.isFinite(usualPct))
        ? mag >= usualPct
        : (signal === 'BUY' || signal === 'SELL');

    // Decide the state + the two-branch signal.
    let state, sentence, sigOwned, sigNotOwned, toneClass, arrow;
    if (strong && dir === 'up') {
        state = 'strong-up'; toneClass = 'sd-up'; arrow = '▲';
        sentence = `<strong>${who}</strong> is predicted to rise about <strong class="sd-num up">+${pct(movePct)}%</strong> — from ${fmtPriceTag(pt.currentPrice, co)} to around <strong>${fmtPriceTag(targetPrice, co)}</strong> by ${tfWord}.`
            + (usualPct != null ? ` That's a bigger move than ${ticker ? ticker + "'s" : 'its'} usual ±${pct(usualPct)}% ${tfWord === 'Today' ? 'day' : 'session'}.` : '');
        sigOwned = 'HOLD'; sigNotOwned = 'BUY';
    } else if (strong && dir === 'down') {
        state = 'strong-down'; toneClass = 'sd-down'; arrow = '▼';
        sentence = `<strong>${who}</strong> is predicted to fall about <strong class="sd-num down">${pct(movePct)}%</strong> — from ${fmtPriceTag(pt.currentPrice, co)} down to around <strong>${fmtPriceTag(targetPrice, co)}</strong> by ${tfWord}.`
            + (usualPct != null ? ` That's a bigger drop than ${ticker ? ticker + "'s" : 'its'} usual ±${pct(usualPct)}% ${tfWord === 'Today' ? 'day' : 'session'}.` : '');
        sigOwned = 'SELL'; sigNotOwned = "DON'T BUY";
    } else {
        // No strong move either way.
        state = 'no-edge'; toneClass = 'sd-flat'; arrow = '◆';
        const moveTxt = `${movePct >= 0 ? '+' : ''}${pct(movePct)}%`;
        sentence = `<strong>${who}</strong> is predicted to move only about <strong class="sd-num">${moveTxt}</strong> — from ${fmtPriceTag(pt.currentPrice, co)} to around <strong>${fmtPriceTag(targetPrice, co)}</strong> by ${tfWord}.`
            + (usualPct != null ? ` That's within its usual ±${pct(usualPct)}% move, so there's no clear edge right now.` : ` No clear edge right now.`);
        sigOwned = 'HOLD'; sigNotOwned = "DON'T BUY";
    }

    // Honesty hedge: low calibrated confidence on a directional call.
    const lowTrust = (state !== 'no-edge') && Number.isFinite(confidence) && confidence < 50;
    const hedge = lowTrust
        ? `<div class="sd-hedge" title="Calibrated confidence is below 50% — the engine's track record for setups like this (under the current engine) is still rebuilding. Treat this as exploratory, not high-conviction.">⚠ Low track record — treat this as exploratory, not a high-conviction call (calibrated confidence ${Math.round(confidence)}%).</div>`
        : '';

    // The two-branch signal line. Highlight the branch that applies to the
    // user when we know whether they hold the symbol.
    const ownedFirst = (state === 'strong-down'); // SELL/HOLD reads owned-first
    const ownedChip = `<span class="sd-chip ${ownedHl(owned, true)}">${sigOwned}<span class="sd-chip-cond">if you own it</span></span>`;
    const notOwnedChip = `<span class="sd-chip ${ownedHl(owned, false)}">${sigNotOwned}<span class="sd-chip-cond">if you haven't bought</span></span>`;
    const chips = ownedFirst ? `${ownedChip}${notOwnedChip}` : `${notOwnedChip}${ownedChip}`;

    return `
        <div class="suggested-decision ${toneClass}" data-state="${state}">
            <div class="sd-head">
                <span class="sd-arrow">${arrow}</span>
                <span class="sd-title">Suggested Decision</span>
                ${owned ? '<span class="sd-owned-tag" title="You hold this in your practice portfolio">you own this</span>' : ''}
            </div>
            <div class="sd-body">${sentence}</div>
            ${hedge}
            <div class="sd-signal">
                <span class="sd-signal-label">Signal</span>
                <div class="sd-chips">${chips}</div>
            </div>
        </div>`;
}

// Which branch to visually highlight: the one matching the user's ownership.
// When ownership is unknown (no portfolio), neither is dimmed.
function ownedHl(owned, isOwnedBranch) {
    if (owned == null) return '';
    return owned === isOwnedBranch ? 'sd-chip-active' : 'sd-chip-dim';
}
