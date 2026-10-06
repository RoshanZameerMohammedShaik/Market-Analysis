// Suggested Decision, the hero takeaway of the analysis section.
//
// Roshan's spec: stop showing a bare one-word signal (esp. the cold
// "NEUTRAL"/"DON'T BUY"). Instead, tell the user, in plain language with REAL
// numbers, what the engine predicts and what to DO given whether they own it:
//
//   • Strong up   → "predicted to rise ~X% from $cur to ~$high by Today/Tomorrow"
//                   Signal: BUY (if not owned) · HOLD (if owned)
//   • Strong down → "predicted to fall ~X% from $cur to ~$low by Today/Tomorrow"
//                   Signal: SELL (if owned) · DON'T BUY (if not owned)
//   • No strong move → "predicted to move only ~X%, within its usual ~Y%, no
//                   clear edge"  Signal: HOLD (if owned) · DON'T BUY (if not)
//
// Everything is DYNAMIC and works for stocks AND crypto:
//   - predicted move %  = the engine's own committed directional target
//     (priceTargets.highPercent for an up-lean, lowPercent for a down-lean).
//   - "usual move" %    = expectedMove / currentPrice * 100, the per-symbol
//     ATR-based typical move. No hardcoded 5% (would mislabel pennies/crypto).
//   - "strong" is decided by comparing those two NUMBERS the user can see:
//     the predicted move is strong when its magnitude >= the stock's own usual
//     move. We show both numbers so the threshold is self-evident, never a "bar".
//
// Honesty guard: when calibrated confidence < 50% (worse than a coin flip on
// direction by the engine's grounded data), we append an "exploratory" caveat
// so a weak call never reads as conviction.
//
// LEAD WITH WHAT IS MEASURED (2026-10-02). For US stocks the headline is no longer the direction
// call, which said "no clear edge" on nearly every stock because next-day direction IS a coin flip
// (the engine's live BUY/SELL record is shown beside it, from model/live_calibration.json). In
// order: an active pullback setup (a buy/sell rule that recovered ~67% of the time, held out),
// else the volatility forecast (calibrated: its 80%+ calls were right 84-94% on unseen years),
// with direction reduced to one line. Crypto and non-US stocks, which the volatility model was
// not trained on, keep the direction text below.

import { fmtPriceTag } from './format.js';
import { escapeHtml } from './escape.js';
import { getLiveCalibration } from '../calibration.js';
import { shortDate } from './setups-record.js';

// Round a % for display: 1 decimal under 10, whole number above.
function pct(v) {
    if (!Number.isFinite(v)) return '';
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
    if (!Number.isFinite(v)) return '';
    return (v < 0 ? '−' : '+') + pct(v);
}

/** The engine's live BUY/SELL record, next-day horizon, current engine version only. */
export function directionRecord(live = getLiveCalibration()) {
    const h = live?.byHorizon?.['1'];
    if (!h) return null;
    let n = 0, right = 0;
    for (const side of ['BUY', 'SELL']) {
        for (const b of Object.values(h[side] || {})) {
            if (!Number.isFinite(b?.n) || !Number.isFinite(b?.actual)) continue;
            n += b.n;
            right += b.n * b.actual / 100;
        }
    }
    return n ? { n, hitRate: right / n } : null;
}

const pct1 = (x) => `${(x * 100).toFixed(1)}%`;

function directionLine(view, rec) {
    const sig = view.signal;
    const lean = sig === 'BUY' || sig === 'SELL'
        ? `The direction engine leans ${sig} at ${Math.round(view.confidence)}%, but`
        : 'The direction engine has no lean, and';
    const record = rec && rec.n >= 30
        ? ` its BUY/SELL calls have been right ${pct1(rec.hitRate)} of the time live (${rec.n.toLocaleString()} graded)`
        : ' next-day direction tested at a coin flip over 12 years';
    return `<div class="sd-dir"><strong>Which way:</strong> no measurable edge. ${lean}${record}, so it is not a reason to trade.</div>`;
}

function chipPair(ownedLabel, ownedCond, notLabel, notCond, owned) {
    return `<span class="sd-chip ${ownedHl(owned, false)}"><span class="sd-chip-main">${notLabel}</span><span class="sd-chip-cond">${notCond}</span></span>`
        + `<span class="sd-chip ${ownedHl(owned, true)}"><span class="sd-chip-main">${ownedLabel}</span><span class="sd-chip-cond">${ownedCond}</span></span>`;
}

function shell({ toneClass, state, arrow, title, owned, body, extra = '', chips, chipLabel = 'For you' }) {
    return `
        <div class="suggested-decision ${toneClass}" data-state="${state}">
            <div class="sd-head">
                <span class="sd-arrow">${arrow}</span>
                <span class="sd-title">${title}</span>
                ${owned ? '<span class="sd-owned-tag" title="You hold this in your practice portfolio">you own this</span>' : ''}
            </div>
            <div class="sd-body">${body}</div>
            ${extra}
            <div class="sd-signal">
                <span class="sd-signal-label">${chipLabel}</span>
                <div class="sd-chips">${chips}</div>
            </div>
        </div>`;
}

/** Active, reliable pullback setup: the one short-horizon BUY with a measured edge. */
function setupDecision(view, rs, { who, co, owned }) {
    const c = rs.cell;
    const vf = view.volForecast;
    const cond = rs.forming ? ' if it holds into the close' : '';
    const body = `<strong>${who}</strong> is in a <strong class="sd-num up">pullback setup</strong>: an uptrending stock
        after a sharp dip. <strong>${pct1(c.hitRate)}</strong> of setups like this recovered to their 5-day average within
        10 sessions, averaging <strong>${c.netBps >= 0 ? '+' : ''}${Math.round(c.netBps)} bps</strong> a trade after costs
        (${c.n.toLocaleString()} trades over 12 years).${rs.forming ? ' It is still forming and confirms at today\'s close.' : ''}
        ${vf ? ` Expect about <strong>±${pct1(vf.sigma)} a day</strong> while you wait.` : ''}`;
    return shell({
        toneClass: 'sd-up', state: 'setup', arrow: '↺', title: 'Suggested Decision', owned, body,
        extra: '<div class="sd-dir">That is a recovery rate for the trade, not a forecast that it rises tomorrow. Full rule and record below.</div>',
        chipLabel: 'Signal',
        chips: chipPair('HOLD', `until a close above ${fmtPriceTag(rs.trigger, co)}`,
                        'BUY', `at the next open${cond}`, owned),
    });
}

/**
 * A setup this app PUBLISHED that is still inside its trade: someone who followed the list holds
 * it now, so the headline is the exit rule, not tonight's (absent) signal. The measured edge is
 * from the published entry; buying later was not measured, and the card says so.
 */
function openTradeDecision(view, e, rs, { who, co, owned }) {
    const vf = view.volForecast;
    const day = e.status === 'open' && e.held != null ? ` It is on day ${e.held} of 10` : '';
    const mark = day && e.markPct != null ? `, ${e.markPct >= 0 ? '+' : ''}${e.markPct.toFixed(1)}% from its entry` : '';
    const progress = day ? `${day}${mark}.` : '';
    const exiting = e.status === 'exiting';
    const body = exiting
        ? `<strong>${who}</strong> was flagged as a <strong class="sd-num up">pullback setup</strong> at the ${shortDate(e.session)} close,
            and its exit trigger has fired: the published rule sells at the next open.`
        : `<strong>${who}</strong> was flagged as a <strong class="sd-num up">pullback setup</strong> at the ${shortDate(e.session)} close
            and that trade is still open.${progress} The rule: sell at the open after the first close above the 5-day
            average${rs?.trigger ? ` (about ${fmtPriceTag(rs.trigger, co)} now)` : ''}, by the 10th session at the latest.
            ${e.hitRate ? `${pct1(e.hitRate)} of trades like it recovered.` : ''}`;
    return shell({
        toneClass: 'sd-up', state: 'setup-open', arrow: '↺', title: 'Suggested Decision', owned,
        body: `${body}${vf ? ` Expect about <strong>±${pct1(vf.sigma)} a day</strong> meanwhile.` : ''}`,
        extra: '<div class="sd-dir">The recovery rate was measured from the published entry, the open after the signal. Buying later is a different trade that was not tested.</div>',
        chipLabel: 'Signal',
        chips: chipPair(exiting ? 'SELL' : 'HOLD', exiting ? 'at the next open, if you own it' : 'until the exit rule fires', 'Late to enter', "if you haven't bought: the measured entry has passed", owned),
    });
}

/** The volatility forecast as the headline. */
function volDecision(view, vf, { who, co, owned, price }) {
    const week = price ? vf.sigma * Math.sqrt(5) * price : null;
    const b = vf.bucket;
    const sure = vf.call !== 'similar' && b
        ? ` <strong>${Math.round(vf.confidence * 100)}% confident</strong>; past calls this sure were right ${pct1(b.hitRate)}.`
        : '';
    let lead, toneClass, arrow, state;
    if (vf.call === 'choppier') {
        lead = `Expect a <strong class="sd-num warn">choppier week</strong> for <strong>${who}</strong>: about
            <strong>±${pct1(vf.sigma)} a day</strong> over the next 5 sessions, up from ±${pct1(vf.past20)} recently.`;
        toneClass = 'sd-warn'; arrow = '〰'; state = 'vol-up';
    } else if (vf.call === 'calmer') {
        lead = `Expect a <strong class="sd-num up">calmer week</strong> for <strong>${who}</strong>: about
            <strong>±${pct1(vf.sigma)} a day</strong> over the next 5 sessions, down from ±${pct1(vf.past20)} recently.`;
        toneClass = 'sd-calm'; arrow = '〰'; state = 'vol-down';
    } else {
        lead = `Expect a <strong class="sd-num">typical week</strong> for <strong>${who}</strong>: about
            <strong>±${pct1(vf.sigma)} a day</strong> over the next 5 sessions, close to the last 20 sessions' ±${pct1(vf.past20)}.
            No confident call on calmer or choppier.`;
        toneClass = 'sd-flat'; arrow = '〰'; state = 'vol-flat';
    }
    const earn = vf.earnIn ? ' <strong>Earnings land inside this window</strong>, which is most of the jump.' : '';
    const plan = week
        ? `<div class="sd-dir"><strong>Plan for:</strong> about ±${fmtPriceTag(week, co)} over the week (one standard deviation),
            and twice that about one week in twenty. The week's typical daily move should land between ${pct1(vf.lo)} and ${pct1(vf.hi)} (80% range).</div>`
        : '';
    const swing = week ? `±${fmtPriceTag(week, co)}` : `±${pct1(vf.sigma)}/day`;
    return shell({
        toneClass, state, arrow, title: 'What to expect', owned,
        body: `${lead}${sure}${earn}`,
        extra: plan + directionLine(view, directionRecord()),
        chips: chipPair(`Expect ${swing}`, 'swings this week, if you own it', 'No timing edge', "if you haven't bought: size for the swing", owned),
    });
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

    // What is measured comes first (see the header). The setup is defined at today's close, so it
    // leads only on the Today view.
    const rs = view.reversionSetup;
    if (opts.timeframe === 'today' && rs?.active && rs?.reliable && rs?.cell) {
        return setupDecision(view, rs, { who, co, owned });
    }
    const openTrade = (rs?.record?.symbol || []).find(e => e.status === 'open' || e.status === 'exiting' || e.status === 'pending');
    if (openTrade) {
        return openTradeDecision(view, openTrade, rs, { who, co, owned });
    }
    if (view.volForecast) {
        return volDecision(view, view.volForecast, { who, co, owned, price: pt.currentPrice });
    }

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

    // THE ENGINE'S SIGNAL IS THE SOURCE OF TRUTH, the Suggested Decision must
    // never contradict it. (Earlier this derived direction from the price-target
    // RANGE, which manufactured a "BUY" on a NEUTRAL whose noise band happened to
    // lean up, the card said "DON'T BUY" up top and "BUY" here. Never again.)
    // So state is decided by `signal`; the predicted move % + the symbol's usual
    // move are DESCRIPTIVE context (how big a move the engine sees), not the
    // decider. predictedHigh = the upside the engine sketches, predictedLow the
    // downside, we headline the side that matches the call.
    const up = Number(pt.highPercent);    // signed, usually +
    const down = Number(pt.lowPercent);   // signed, usually −

    // Decide the state STRICTLY from the engine signal + the two-branch advice.
    let state, sentence, sigOwned, sigNotOwned, toneClass, arrow;
    const usualTail = usualPct != null
        ? ` The move ${ticker ? ticker : 'it'} is expected to make is about ±${pct(usualPct)}% this ${tfWord === 'Today' ? 'day' : 'session'}.`
        : '';

    if (signal === 'BUY') {
        state = 'buy'; toneClass = 'sd-up'; arrow = '▲';
        sentence = `<strong>${who}</strong> looks like a <strong class="sd-num up">BUY</strong> for ${tfWord}, the engine sees upside toward <strong>${fmtPriceTag(pt.predictedHigh, co)}</strong> (<strong class="sd-num up">+${pct(up)}%</strong>) from ${fmtPriceTag(anchorPx, co)}.${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = 'BUY';
    } else if (signal === 'SELL') {
        state = 'sell'; toneClass = 'sd-down'; arrow = '▼';
        sentence = `<strong>${who}</strong> looks like a <strong class="sd-num down">SELL</strong> for ${tfWord}, the engine sees downside toward <strong>${fmtPriceTag(pt.predictedLow, co)}</strong> (<strong class="sd-num down">${pctSigned(down)}%</strong>) from ${fmtPriceTag(anchorPx, co)}.${usualTail}`;
        sigOwned = 'SELL'; sigNotOwned = "DON'T BUY";
    } else if (signal === 'NO_TRADE') {
        // The engine ABSTAINED: its indicators disagree, the edge is too thin, or the market is
        // ranging. This used to say "there's event risk (e.g. earnings or a big gap)" for every
        // AVOID, which was never what the gate tests (see the abstain gate in analysis.js), and
        // told BTC holders to watch for earnings. Say what it actually is.
        state = 'avoid'; toneClass = 'sd-flat'; arrow = '⊘';
        const why = String(view.meta?.abstainReason || '').trim().replace(/\.$/, '');
        sentence = `<strong>${who}</strong> is best <strong class="sd-num">AVOIDED</strong> for ${tfWord}, the engine found no edge worth taking and is sitting it out${why ? `: ${escapeHtml(why)}.` : '.'}${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = "DON'T BUY";
    } else {
        // NEUTRAL, genuinely no directional edge. Describe the range honestly
        // (it can swing either way) but DO NOT pick a side.
        state = 'no-edge'; toneClass = 'sd-flat'; arrow = '◆';
        sentence = `<strong>${who}</strong> has <strong class="sd-num">no clear edge</strong> for ${tfWord}, the engine could see it anywhere from <strong>${fmtPriceTag(pt.predictedLow, co)}</strong> (${pctSigned(down)}%) to <strong>${fmtPriceTag(pt.predictedHigh, co)}</strong> (${pctSigned(up)}%) around ${fmtPriceTag(anchorPx, co)}, with no convincing lean either way.${usualTail}`;
        sigOwned = 'HOLD'; sigNotOwned = "DON'T BUY";
    }

    // Honesty hedge: low calibrated confidence on a directional call.
    const lowTrust = (signal === 'BUY' || signal === 'SELL') && Number.isFinite(confidence) && confidence < 50;
    const hedge = lowTrust
        ? `<div class="sd-hedge" title="Calibrated confidence is below 50%, the engine's track record for setups like this (under the current engine) is still rebuilding. Treat this as exploratory, not high-conviction.">⚠ Low track record, treat this as exploratory, not a high-conviction call (calibrated confidence ${Math.round(confidence)}%).</div>`
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
