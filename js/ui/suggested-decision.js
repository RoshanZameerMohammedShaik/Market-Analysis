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

// SIGNED, for anywhere the sign is the whole meaning.
//
// pct() deliberately strips the sign because most call sites supply their own ("+" in the BUY
// branch) or colour the number red. The NEUTRAL sentence did neither, so a downside of -6.94%
// rendered as "from $138.15 (6.9%)" -- indistinguishable from +6.9% in plain text, on the one
// branch of this card that has no directional styling at all.
function pctSigned(v) {
    if (!Number.isFinite(v)) return '—';
    return (v < 0 ? '−' : '+') + pct(v);
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

    // The price the quoted percentages are actually measured FROM. highPercent/lowPercent are
    // computed against the locked session open, so quoting them "around <live price>" paired two
    // numbers that do not belong together: SPCX read "$138.15 (−6.9%) to $159.51 (+7.5%) around
    // $144.18" when both percentages were measured from $148.45.
    const anchorPx = Number.isFinite(pt.baselinePrice) && pt.baselinePrice > 0
        ? pt.baselinePrice : pt.currentPrice;

    // The stock's own expected one-day move. NOTE the wording downstream says "expected move",
    // not "typical move": the band header separately shows a daily VOLATILITY figure (rangeSigma,
    // e.g. "wild · 5.14%/day") and these are different measurements of different things. SPCX
    // showed 5.14%/day next to "typical move is about ±4.1% a day" with nothing to tell the reader
    // they were not the same quantity contradicting itself.
    const usualPct = (pt.expectedMove != null && pt.currentPrice)
        ? (pt.expectedMove / pt.currentPrice) * 100
        : null;

    // THE ENGINE'S SIGNAL IS THE SOURCE OF TRUTH — the Suggested Decision must
    // never contradict it. (Earlier this derived direction from the price-target
    // RANGE, which manufactured a "BUY" on a NEUTRAL whose noise band happened to
    // lean up — the card said "DON'T BUY" up top and "BUY" here. Never again.)
    // So state is decided by `signal`; the predicted move % + the symbol's usual
    // move are DESCRIPTIVE context (how big a move the engine sees), not the
    // decider. predictedHigh = the upside the engine sketches, predictedLow the
    // downside — we headline the side that matches the call.
    const up = Number(pt.highPercent);    // signed, usually +
    const down = Number(pt.lowPercent);   // signed, usually −

    // Decide the state STRICTLY from the engine signal + the two-branch advice.
    let state, sentence, sigOwned, sigNotOwned, toneClass, arrow;
    const usualTail = usualPct != null
        ? ` The move ${ticker ? ticker : 'it'} is expected to make is about ±${pct(usualPct)}% this ${tfWord === 'Today' ? 'day' : 'session'}.`
        : '';

    if (signal === 'BUY') {
        state = 'buy'; toneClass = 'sd-up'; arrow = '▲';
        sentence = `<strong>${who}</strong> looks like a <strong class="sd-num up">BUY</strong> for ${tfWord} — the engine sees upside toward <strong>${fmtPriceTag(pt.predictedHigh, co)}</strong> (<strong class="sd-num up">+${pct(up)}%</strong>) from ${fmtPriceTag(anchorPx, co)}.${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = 'BUY';
    } else if (signal === 'SELL') {
        state = 'sell'; toneClass = 'sd-down'; arrow = '▼';
        sentence = `<strong>${who}</strong> looks like a <strong class="sd-num down">SELL</strong> for ${tfWord} — the engine sees downside toward <strong>${fmtPriceTag(pt.predictedLow, co)}</strong> (<strong class="sd-num down">${pctSigned(down)}%</strong>) from ${fmtPriceTag(anchorPx, co)}.${usualTail}`;
        sigOwned = 'SELL'; sigNotOwned = "DON'T BUY";
    } else if (signal === 'NO_TRADE') {
        // Hard event-risk cap (earnings/gap/etc.) — the engine is actively
        // telling you to stay out, which is stronger than "no edge".
        state = 'avoid'; toneClass = 'sd-flat'; arrow = '⊘';
        sentence = `<strong>${who}</strong> is best <strong class="sd-num">AVOIDED</strong> for ${tfWord} — there's event risk (e.g. earnings or a big gap) that makes the next move a coin toss. The engine is sitting it out.${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = "DON'T BUY";
    } else {
        // NEUTRAL — genuinely no directional edge. Describe the range honestly
        // (it can swing either way) but DO NOT pick a side.
        state = 'no-edge'; toneClass = 'sd-flat'; arrow = '◆';
        sentence = `<strong>${who}</strong> has <strong class="sd-num">no clear edge</strong> for ${tfWord} — the engine could see it anywhere from <strong>${fmtPriceTag(pt.predictedLow, co)}</strong> (${pctSigned(down)}%) to <strong>${fmtPriceTag(pt.predictedHigh, co)}</strong> (${pctSigned(up)}%) around ${fmtPriceTag(anchorPx, co)}, with no convincing lean either way.${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = "DON'T BUY";
    }

    // Honesty hedge: low calibrated confidence on a directional call.
    const lowTrust = (signal === 'BUY' || signal === 'SELL') && Number.isFinite(confidence) && confidence < 50;
    const hedge = lowTrust
        ? `<div class="sd-hedge" title="Calibrated confidence is below 50% — the engine's track record for setups like this (under the current engine) is still rebuilding. Treat this as exploratory, not high-conviction.">⚠ Low track record — treat this as exploratory, not a high-conviction call (calibrated confidence ${Math.round(confidence)}%).</div>`
        : '';

    // The two-branch signal line. Highlight the branch that applies to the
    // user when we know whether they hold the symbol.
    const ownedFirst = (state === 'sell'); // SELL/HOLD reads owned-first
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
