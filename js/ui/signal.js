import { state } from './state.js';
import { fmtPriceTag, fmtPrice } from './format.js';
import { humanizeReason, generateTechnicalExplanation } from './reasons.js';
import { renderNews } from './news.js';
import { isDev } from '../dev-mode.js';
import { renderPennyDashboard } from './penny-dashboard.js';
import { getCalibrationSource } from '../calibration.js';
import { renderTrustPanel } from './trust-panel.js';
import { renderForecastBand } from './forecast-band-panel.js';
import { renderConfidenceDial, animateDials } from './confidence-dial.js';
import { renderConfidenceTrendPlaceholder, mountConfidenceTrend } from './confidence-trend.js';
import { sharePredictionCard } from './share-card.js';
import { getEffectiveLock, computeStatus } from './daily-lock.js';
import { revealUp, revealText, revealStagger, canAnimate } from './motion.js';
import { signalLanded } from './ui-sound.js';
import { renderSuggestedDecision } from './suggested-decision.js';

let lastShownConfidence = null;
let lastShownSymbol = null;

export async function renderSignal(prediction, newsData = [], sentiment = null) {
    const section = document.getElementById('signal-section');

    // TODAY'S LOCKED CALL — anchored to the MARKET OPEN, not the page visit.
    // The day's prediction of record is the one the Python cron committed at
    // market open (open price = entry), read from the ledger via
    // getEffectiveLock. The on-screen engine still recomputes live, but the
    // LOCKED signal / confidence / target band is what's displayed as the hero
    // — stable all day, identical regardless of when the user opens the page.
    // The live price drives only the STATUS line below ("on track" / "target
    // reached" / "stopped"), never a competing call. If the symbol isn't in the
    // cron universe (or the market hasn't opened yet today), getEffectiveLock
    // falls back to a visit-time local lock so every symbol still shows a held
    // call. (Skip when the live prediction has no signal.)
    const lockSym = state.currentSymbol;
    const locked = lockSym ? await getEffectiveLock(lockSym, prediction) : null;
    // Build the view object: locked values win for the decision fields
    // (signal, confidence, the predicted high/low targets); everything else
    // (reasons, breakdown, news, support/resistance/ATR context) comes from
    // the live computation since those are explanatory, not the commitment.
    let view = prediction;
    if (locked) {
        let pinnedTargets = prediction.priceTargets;
        if (locked.priceTargets && Number.isFinite(locked.priceTargets.predictedHigh)) {
            // BEST CASE: the cron locked a FULL band at market open (possible +
            // probable high/low, anchored to the open entry). Use it wholesale
            // — this is the engine's own committed band, identical for everyone
            // all day. Keep only the LIVE currentPrice so the card still shows
            // where price is NOW relative to the locked band.
            pinnedTargets = {
                ...locked.priceTargets,
                currentPrice: prediction.priceTargets?.currentPrice ?? locked.priceTargets.currentPrice,
            };
        } else if (pinnedTargets && locked.predictedHigh != null && locked.predictedLow != null && Number.isFinite(locked.entry) && locked.entry > 0) {
            // FALLBACK (legacy ledger row / visit-time lock): pin only the
            // headline possible high/low to the locked values + recompute their
            // % against the locked entry, so the range doesn't drift with live
            // price. Keep the live currentPrice for the "where price is NOW" read.
            pinnedTargets = {
                ...pinnedTargets,
                predictedHigh: locked.predictedHigh,
                predictedLow: locked.predictedLow,
                highPercent: +(((locked.predictedHigh - locked.entry) / locked.entry) * 100).toFixed(2),
                lowPercent: +(((locked.predictedLow - locked.entry) / locked.entry) * 100).toFixed(2),
            };
        }
        view = {
            ...prediction,
            signal: locked.signal,
            confidence: locked.confidence,
            priceTargets: pinnedTargets,
        };
    }

    const { signal, confidence, confidenceRange, rawConfidence, calibrationApplied, reasons, priceTargets, trendRegime, regime, sector, earnings } = view;
    // Native currency of the symbol (USD for US tickers, INR for .NS,
    // GBP for .L, JPY for .T, etc). Threaded into every fmtPrice call
    // below so the formatter knows whether to FX-convert or render as-is.
    const cur = (prediction.currency || 'USD').toUpperCase();
    const co = { srcCurrency: cur };

    const signalClass = signal.toLowerCase();
    const arrow = signal === 'BUY' ? '▲'
        : signal === 'SELL' ? '▼'
        : signal === 'NO_TRADE' ? '⊘'
        : '◆';
    const arrowClass = signal === 'BUY' ? 'up'
        : signal === 'SELL' ? 'down'
        : signal === 'NO_TRADE' ? 'abstain'
        : 'neutral';
    // User-facing label translation. The engine still uses BUY / SELL /
    // NEUTRAL / NO_TRADE internally (so the live ledger, calibration
    // tables, and 2,363 resolved-horizon dataset stay valid), but the
    // UI surfaces them as decisive labels per Roshan's "say things
    // with conviction" requirement:
    //   BUY      → BUY     (clear bullish edge)
    //   SELL     → SELL    (clear bearish edge)
    //   NEUTRAL  → DON'T BUY  (no edge, sit out)
    //   NO_TRADE → AVOID   (hard event-risk cap — earnings, gap, etc)
    const signalDisplay = signal === 'NO_TRADE' ? 'AVOID'
        : signal === 'NEUTRAL' ? "DON'T BUY"
        : signal;

    let priceTargetHTML = '';
    if (priceTargets) {
        const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
        const hasProbable = priceTargets.probableHigh != null && priceTargets.probableLow != null;
        const probableStrip = hasProbable
            ? `<div class="probable-strip" title="The narrower target zone — where the price most likely lands">
                    <span class="probable-label">Probable</span>
                    <span class="probable-low">${fmtPriceTag(priceTargets.probableLow, co)}</span>
                    <span class="probable-arrow">→</span>
                    <span class="probable-high">${fmtPriceTag(priceTargets.probableHigh, co)}</span>
                    <span class="probable-pct">(${priceTargets.probableLowPercent >= 0 ? '+' : ''}${priceTargets.probableLowPercent}% to ${priceTargets.probableHighPercent >= 0 ? '+' : ''}${priceTargets.probableHighPercent}%)</span>
               </div>`
            : '';
        priceTargetHTML = `
            <div class="price-targets">
                <div class="price-targets-title">Expected Price Range — ${tfLabel}${priceTargets.source === "calibrated-band" ? `<span class="pt-cal-badge" title="Derived from the calibrated 7-day band, not an ATR heuristic. Coverage is measured, not assumed.">${priceTargets.bandConfidence}% band</span>` : ""}</div>
                ${probableStrip}
                <div class="price-targets-grid">
                    <div class="price-target-card high">
                        <div class="price-target-label">${priceTargets.source === "calibrated-band" ? "Expected High" : "Possible High"}</div>
                        <div class="price-target-value high">${fmtPriceTag(priceTargets.predictedHigh, co)}</div>
                        <div class="price-target-pct up">▲ +${priceTargets.highPercent}%</div>
                    </div>
                    <div class="price-target-card current">
                        <div class="price-target-label">Current Price</div>
                        <div class="price-target-value">${fmtPriceTag(priceTargets.currentPrice, co)}</div>
                        <div class="price-target-pct">ATR: ${fmtPriceTag(priceTargets.atr, co)}</div>
                    </div>
                    <div class="price-target-card low">
                        <div class="price-target-label">${priceTargets.source === "calibrated-band" ? "Expected Low" : "Possible Low"}</div>
                        <div class="price-target-value low">${fmtPriceTag(priceTargets.predictedLow, co)}</div>
                        <div class="price-target-pct down">▼ ${priceTargets.lowPercent}%</div>
                    </div>
                </div>
                <div class="price-targets-meta">
                    Support: ${fmtPriceTag(priceTargets.support, co)} · Resistance: ${fmtPriceTag(priceTargets.resistance, co)} · Expected Move: ±${fmtPriceTag(priceTargets.expectedMove, co)}
                </div>
            </div>`;
    }

    const insightSummary = generateHumanInsight(prediction, sentiment);
    const newsHTML = renderNews(newsData, sentiment);
    const pennyDashboardHTML = renderPennyDashboard(prediction);
    const attributionHTML = renderAttribution(prediction.attribution);
    // Horizon-bands strip removed — the per-symbol Prediction Accuracy
    // column in the Full Ledger already shows past hit rate, and it's
    // per-symbol rather than pooled across the whole universe like the
    // strip was. Keeping the renderHorizonBands() function in case we
    // ever want to bring it back, but not wiring it in.

    // Live indicator snapshot chips — the actual computed values for THIS
    // symbol, shown at a glance above the explanations. Each chip is tinted by
    // whether the value reads bull / bear / neutral, so the panel is concretely
    // symbol-specific even before you expand a row. Omitted entirely when the
    // engine didn't surface a snapshot (e.g. too few candles).
    const snap = prediction.indicatorSnapshot;
    let snapChipsHTML = '';
    if (snap) {
        const chip = (label, val, tone) =>
            `<span class="tech-chip ${tone}"><span class="tech-chip-k">${label}</span><span class="tech-chip-v">${val}</span></span>`;
        const chips = [];
        if (snap.rsi != null) chips.push(chip('RSI', snap.rsi, snap.rsi < 30 ? 'positive' : snap.rsi > 70 ? 'negative' : 'neutral'));
        if (snap.macd && snap.macd.hist != null) chips.push(chip('MACD hist', (snap.macd.hist >= 0 ? '+' : '') + snap.macd.hist, snap.macd.hist > 0 ? 'positive' : snap.macd.hist < 0 ? 'negative' : 'neutral'));
        if (snap.bb && snap.bb.percentB != null) chips.push(chip('%B', snap.bb.percentB, snap.bb.percentB < 0 ? 'positive' : snap.bb.percentB > 1 ? 'negative' : 'neutral'));
        if (snap.adx != null) chips.push(chip('ADX', snap.adx, snap.adx > 25 ? 'neutral-strong' : 'neutral'));
        if (snap.mfi != null) chips.push(chip('MFI', snap.mfi, snap.mfi < 20 ? 'positive' : snap.mfi > 80 ? 'negative' : 'neutral'));
        if (snap.volRatio != null) chips.push(chip('Vol', snap.volRatio + '×', snap.volRatio > 1.4 ? 'neutral-strong' : 'neutral'));
        if (snap.atrPct != null) chips.push(chip('ATR', snap.atrPct + '%', 'neutral'));
        if (snap.momentumPct != null) chips.push(chip('Mom 5p', (snap.momentumPct >= 0 ? '+' : '') + snap.momentumPct + '%', snap.momentumPct > 0 ? 'positive' : snap.momentumPct < 0 ? 'negative' : 'neutral'));
        if (chips.length) snapChipsHTML = `<div class="tech-chips" title="Live indicator readings for ${state.currentSymbol || 'this symbol'}">${chips.join('')}</div>`;
    }

    const technicalHTML = `
        <div class="technical-section">
            <div class="section-subtitle">Technical Indicators</div>
            ${snapChipsHTML}
            <div class="accordion-list">
                ${reasons.map(r => {
                    const humanized = humanizeReason(r);
                    // Try for a textbook explanation; fall back to the
                    // raw reason if no rule matches. The engine's reason
                    // strings are already specific ("Sector: Tech rising
                    // 1.2%/5d — aligned"), so showing them verbatim is
                    // far better than rendering an identical generic
                    // placeholder ten times in a row.
                    const explanation = generateTechnicalExplanation(r, signal, state.currentSymbol, prediction.indicatorSnapshot);
                    const body = explanation || (humanized !== r ? r : null);
                    const indicatorClass = /(bull|BUY|oversold|positive|upward)/i.test(r) ? 'positive'
                        : /(bear|SELL|overbought|negative|downward)/i.test(r) ? 'negative' : 'neutral';
                    // If we have neither a textbook explanation nor
                    // extra detail beyond the humanized title, render
                    // a non-expandable row (no chevron) so we don't
                    // tease an empty accordion body.
                    if (!body) {
                        return `<div class="accordion-item tech-accordion tech-accordion-flat">
                            <div class="accordion-header">
                                <span class="accordion-dot ${indicatorClass}"></span>
                                <div class="accordion-header-content"><div class="accordion-title">${humanized}</div></div>
                            </div>
                        </div>`;
                    }
                    return `<details class="accordion-item tech-accordion">
                        <summary class="accordion-header">
                            <span class="accordion-dot ${indicatorClass}"></span>
                            <div class="accordion-header-content"><div class="accordion-title">${humanized}</div></div>
                            <span class="accordion-chevron">▸</span>
                        </summary>
                        <div class="accordion-body"><div class="accordion-explanation">${body}</div></div>
                    </details>`;
                }).join('')}
            </div>
        </div>`;

    let breakdownHTML = '';
    if (prediction.breakdown) {
        const bd = prediction.breakdown;
        const aiLabel = bd.ai?.modelTier === 'penny' ? 'AI (Penny model)' : 'AI Model';
        const fmtWeight = (w) => Number.isFinite(w) ? (Math.round(w * 10) / 10).toString() : '0';
        const row = (label, score, weight, color) => `
            <div class="breakdown-item">
                <span class="breakdown-label">${label} (${fmtWeight(weight)}%)</span>
                <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${score}%; background: ${color};"></div></div>
                <span class="breakdown-score">${score}</span>
            </div>`;
        breakdownHTML = `
            <div class="source-breakdown">
                <div class="breakdown-title">Confidence Sources</div>
                <div class="breakdown-bars">
                    ${bd.ai.available ? row(aiLabel, bd.ai.score, bd.ai.weight, 'var(--accent)') : ''}
                    ${row('Technicals', bd.technical.score, bd.technical.weight, 'var(--green)')}
                    ${row('Sentiment', bd.sentiment.score, bd.sentiment.weight, 'var(--yellow)')}
                    ${row('Market', bd.market.score, bd.market.weight, '#a371f7')}
                </div>
            </div>`;
    }

    // Surface which calibration source actually answered: live ledger, backtest,
    // or raw. Live = real-world hit rates; backtest = historical replay; raw =
    // not enough data either way.
    const calSrc = getCalibrationSource();
    const isLive = calSrc && calSrc.startsWith('live-');
    const calibrationBadge = isDev()
        ? (calibrationApplied
            ? `<span class="cal-badge ${isLive ? 'live' : 'calibrated'}" title="${isLive ? 'Confidence from LIVE ledger (real-world outcomes)' : 'Confidence from backtest calibration (historical replay)'}">${isLive ? '◉ live' : '✓ calibrated'}</span>`
            : `<span class="cal-badge raw" title="No calibration data yet — confidence is heuristic, not empirical">! raw</span>`)
        : '';
    const calibrationDelta = (isDev() && calibrationApplied && rawConfidence !== confidence)
        ? `<span class="cal-delta">heuristic ${rawConfidence}% → historical ${confidence}%</span>` : '';

    const trendChip = trendRegime && trendRegime !== 'unknown'
        ? `<span class="trend-chip ${trendRegime}" title="Market regime detected by ADX">${trendRegime}</span>` : '';
    const macroChip = regime && regime !== 'neutral'
        ? `<span class="trend-chip ${regime === 'risk-on' ? 'trending' : regime === 'risk-off' ? 'ranging' : 'transitional'}" title="Macro regime">${regime}</span>` : '';

    const rangeHTML = confidenceRange
        ? `<span class="conf-range" title="Confidence range reflects engine uncertainty">${confidenceRange.lo}–${confidenceRange.hi}%</span>`
        : '';

    const methodLabel = prediction.method || 'Technical + News + Multi-Timeframe';

    // Live status of today's locked call (on-track / target-reached /
    // stopped), computed from the current price vs the LOCKED targets. This
    // is how the prediction "moves" now — as a status of the held call, not
    // a new prediction. Only when we have a lock + a live price to compare.
    let statusHTML = '';
    if (locked && Number.isFinite(state.currentPrice)) {
        const st = computeStatus(locked, Number(state.currentPrice));
        if (st) {
            const lockedTime = (() => { try { return new Date(locked.lockedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } })();
            // Say WHICH lock this is. getEffectiveLock prefers the cron's
            // market-open ledger row and falls back to a lock taken when the user
            // first opened the symbol today. Those are not the same claim: an open
            // lock is a commitment made before the session, a visit lock is just
            // "the price when you looked". Labelling both "today's call" implied
            // the engine had committed at the open when it had not, which is how a
            // $309.61 call on DY read as an open lock at 11:18 AM.
            const fromLedger = locked.source === 'ledger';
            const lockLabel = fromLedger
                ? `today's call · locked ${lockedTime}`
                : `locked ${lockedTime} when you opened it`;
            const lockTitle = fromLedger
                ? 'Locked by the engine at this market’s open, before the session — the same baseline for everyone.'
                : 'Not in the daily cron universe, so there is no market-open row for it. '
                  + 'This baseline was taken when you first opened the symbol today, so it '
                  + 'differs from what someone opening it at another time would see.';
            statusHTML = `
                <div class="call-status ${st.tone}" title="Live status of today's locked call">
                    <div class="call-status-row">
                        <span class="call-status-label">${st.label}</span>
                        <span class="call-status-locked${fromLedger ? '' : ' is-visit-lock'}"
                              title="${lockTitle}">${lockLabel}</span>
                    </div>
                    <div class="call-status-detail">${st.detail}</div>
                </div>`;
        }
    }

    const dialHTML = renderConfidenceDial({ value: confidence, signal, label: 'confidence' });

    // ── Suggested Decision — the HERO takeaway of the analysis section ──
    // Plain-language, real-numbers "what should I do" framing that replaces a
    // cold one-word signal. Dynamic per symbol (stocks + crypto): predicted
    // move % and the symbol's own "usual move" come straight from priceTargets.
    // Ticker + company name read from the chart header (set just before this
    // render); ownership read from the practice portfolio so we highlight the
    // branch that applies to the user. Folds in the sub-50% confidence hedge,
    // so the older standalone low-trust banner is no longer needed here.
    let suggestedDecisionHTML = '';
    try {
        const sym = state.currentSymbol;
        const headerTxt = document.getElementById('chart-symbol')?.textContent || '';
        // "AAPL — Apple Inc. · NASDAQ — USA" → ticker before " — ", name between.
        let ticker = sym || (headerTxt.split('—')[0] || '').trim();
        let name = '';
        const m = headerTxt.match(/^[^—]+—\s*([^·]+?)\s*(?:·|$)/);
        if (m) name = m[1].trim();
        let owned = null;
        try {
            const { isInstantiated, heldSymbols } = await import('../portfolio/state.js');
            if (isInstantiated()) {
                const held = heldSymbols().map(s => String(s).toUpperCase());
                const key = String(sym || ticker).toUpperCase();
                // crypto positions are stored as e.g. BTC-USD; match either form.
                owned = held.includes(key) || held.includes(`${key}-USD`) || held.includes(key.replace(/-USD$/, ''));
            }
        } catch (_) { owned = null; }
        suggestedDecisionHTML = renderSuggestedDecision(view, {
            timeframe: state.timeframe, ticker, name, owned, currency: cur,
        });
    } catch (_) { suggestedDecisionHTML = ''; }

    // Justify the LOCKED number the dial shows, not the live recompute — the
    // trust panel header literally says "Why trust this {confidence}%?", so
    // it must reason about the same confidence/consensus the user sees.
    const trustHTML = renderTrustPanel(view);
    // 7-day expected trading range. Sits right after the price targets because
    // both are about price levels; the band is the calibrated, direction-free one.
    let bandHTML = '';
    try {
        bandHTML = renderForecastBand(view.forecastBand, {
            currency: cur, currentPrice: view.priceTargets?.currentPrice ?? null,
        });
    } catch (_) { bandHTML = ''; }
    // Per-symbol confidence-trend placeholder — filled async after paint
    // from the live ledger (removed if there isn't enough history).
    const trendHTML = renderConfidenceTrendPlaceholder(state.currentSymbol);

    section.innerHTML = `
        <div class="signal-box ${signalClass}">
            <div class="signal-header">
                <span class="signal-arrow ${arrowClass}">${arrow}</span>
                <span class="signal-label ${signalClass}">${signalDisplay}</span>
                ${rangeHTML}
                ${trendChip}
                ${macroChip}
                ${calibrationBadge}
                <button class="refresh-btn small" id="share-prediction" title="Share this prediction as an image">⤴</button>
                <button class="refresh-btn small" id="refresh-analysis" title="Re-run analysis">↻</button>
            </div>
            ${calibrationDelta ? `<div class="cal-delta-row">${calibrationDelta}</div>` : ''}
            ${suggestedDecisionHTML}
            <div class="signal-dial-row">
                ${dialHTML}
            </div>
            ${statusHTML}
            ${trustHTML}
            ${trendHTML}
            ${breakdownHTML}
            ${pennyDashboardHTML}
            <div class="insight-summary">${insightSummary}</div>
            ${attributionHTML}
            ${priceTargetHTML}
            ${bandHTML}
            ${newsHTML}
            ${technicalHTML}
            <div class="signal-meta" style="margin-top: 12px;">
                Timeframe: ${state.timeframe === 'today' ? 'Today' : 'Tomorrow'} · ${methodLabel}
            </div>
            <div class="risk-disclaimer">
                <strong>Not financial advice.</strong> Predictions are statistical signals, not guarantees. Past performance does not predict future results. Trade at your own risk.
            </div>
        </div>`;

    // GSAP entrance — the card lifts in, the signal label resolves word-by-word,
    // and the secondary sections cascade in just behind the dial sweep. Sets
    // [data-gsap] on the box (only inside canAnimate()) so premium.css's CSS
    // card-rise doesn't double-run; revealUp's clearProps:'transform' default
    // hands the box back to the 3D cursor-tilt at rest. No-ops under
    // reduced-motion / no-GSAP (the CSS fallback + dial's own fallback play).
    const box = section.querySelector('.signal-box');
    if (box && canAnimate()) {
        box.setAttribute('data-gsap', '1');
        revealUp(box, { y: 16, duration: 0.5 });
        const label = box.querySelector('.signal-label');
        if (label) revealText(label, { type: 'words', duration: 0.55, stagger: 0.06 });
        const secondary = [...section.querySelectorAll('.price-targets, .trust-panel, .insight-summary, .attribution-section, .technical-section')];
        if (secondary.length) revealStagger(secondary, { y: 12, duration: 0.45, stagger: 0.07, delay: 0.30 });
    }
    // "Signal landed" chord — distinct per direction, once per analysis.
    signalLanded(signal);

    // The radial dial owns the confidence readout now. Sweep the arc +
    // count up the number on every render (also covers re-runs where the
    // value changed — the dial always animates from 0 to the new value,
    // which reads as a deliberate "recomputing" beat).
    animateDials(section);
    // Fill the confidence-trend chart from the live ledger (async; the
    // block self-removes if there isn't enough resolved history).
    mountConfidenceTrend(section, state.currentSymbol);
    // Share button → render + share/download a branded prediction PNG.
    // Closure-captures the current prediction so there's no global state.
    const shareBtn = section.querySelector('#share-prediction');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            // Share the LOCKED view (what's on screen / today's call), not
            // the drifting live recompute, so the card matches the card.
            sharePredictionCard(view, state.currentSymbol).catch(() => {});
        });
    }
    lastShownConfidence = confidence;
    lastShownSymbol = state.currentSymbol;

    // Pulse the chart-price ring to match the signal direction. Pulse rate
    // scales with confidence — high-conviction signals breathe faster, the
    // engine literally feels more excited about the call.
    const priceEl = document.getElementById('chart-price');
    if (priceEl) {
        priceEl.classList.remove('chart-price-buy', 'chart-price-sell', 'chart-price-neutral', 'chart-price-no_trade');
        priceEl.classList.add(`chart-price-${signalClass}`);
        // Confidence drives the period: 88% → 1.6s, 38% → 4s. Inverse linear.
        const period = 4 - ((confidence - 38) / 50) * 2.4;
        priceEl.style.setProperty('--price-pulse-period', `${period.toFixed(2)}s`);
    }
}

function generateHumanInsight(prediction, sentiment) {
    const { signal, confidence, priceTargets, meta } = prediction;
    const tfWord = state.timeframe === 'today' ? 'today' : 'tomorrow';
    const co = { srcCurrency: (prediction.currency || 'USD').toUpperCase() };
    let insight = '';
    if (signal === 'NO_TRADE') {
        const why = meta?.abstainReason || 'The setup isn\'t clean enough to commit either way.';
        const wouldHaveBeen = meta?.abstainedFrom && meta.abstainedFrom !== 'NEUTRAL'
            ? ` <span class="highlight-yellow">If forced to call: ${meta.abstainedFrom.toLowerCase()}, but conviction is too low.</span>` : '';
        insight = `<strong>Sit this one out.</strong> ${why}${wouldHaveBeen} The honest move ${tfWord} is to wait for a cleaner setup.`;
        return insight;
    }
    if (signal === 'BUY') {
        if (confidence >= 70) insight = `<strong>Strong bullish signal.</strong> Multiple indicators align upward. `;
        else if (confidence >= 55) insight = `<strong>Moderate buy signal.</strong> More indicators point up than down. `;
        else insight = `<strong>Weak buy signal.</strong> Slight bullish edge but low conviction. `;
        if (priceTargets) insight += `Price could reach <span class="highlight-green">${fmtPrice(priceTargets.predictedHigh, co)}</span> ${tfWord} (+${priceTargets.highPercent}%). Downside risk to ${fmtPrice(priceTargets.predictedLow, co)} (${priceTargets.lowPercent}%).`;
    } else if (signal === 'SELL') {
        if (confidence >= 70) insight = `<strong>Strong bearish signal.</strong> Multiple indicators point to decline. `;
        else if (confidence >= 55) insight = `<strong>Moderate sell signal.</strong> Bearish pressure building. `;
        else insight = `<strong>Weak sell signal.</strong> Slight bearish edge but uncertain. `;
        if (priceTargets) insight += `Price may drop to <span class="highlight-red">${fmtPrice(priceTargets.predictedLow, co)}</span> ${tfWord} (${priceTargets.lowPercent}%). Upside capped around ${fmtPrice(priceTargets.predictedHigh, co)} (+${priceTargets.highPercent}%).`;
    } else {
        insight = `<strong>No clear direction.</strong> Indicators are conflicting — the market is undecided. Consider waiting for a clearer setup before entering a position.`;
    }
    if (sentiment && sentiment.overall !== 'neutral') {
        if (sentiment.overall === 'positive' && signal === 'BUY') insight += ` <span class="highlight-green">News sentiment confirms bullish bias.</span>`;
        else if (sentiment.overall === 'negative' && signal === 'SELL') insight += ` <span class="highlight-red">Negative news reinforces bearish outlook.</span>`;
        else if (sentiment.overall === 'negative' && signal === 'BUY') insight += ` <span class="highlight-yellow">Caution: news sentiment is negative despite bullish technicals.</span>`;
        else if (sentiment.overall === 'positive' && signal === 'SELL') insight += ` <span class="highlight-yellow">Note: positive news may limit downside despite bearish technicals.</span>`;
    }
    return insight;
}

// Maps an indicator key (used internally) to a human display name.
// Kept tight here so future indicator additions just need an entry.
const INDICATOR_LABEL = {
    rsi: 'RSI',
    macd: 'MACD',
    bb: 'Bollinger Bands',
    maCross: 'Moving Avg Cross',
    volume: 'Volume',
    adx: 'ADX (trend strength)',
    mfi: 'Money Flow Index',
    divergence: 'Divergence',
    failedBreak: 'Failed breakout',
    momentum: '5-bar momentum',
};

// Per-horizon confidence bands. Sourced from the live ledger; null
// until the ledger accumulates enough resolved horizons (>=30 per
// horizon at this confidence band). Renders a tight 5-cell strip
// directly under the main confidence bar.
function renderHorizonBands(bands) {
    if (!bands || !bands.length) return '';
    const HORIZON_LABEL = { 1: '1d', 3: '3d', 5: '5d', 10: '10d', 20: '20d' };
    const cells = bands.map(b => {
        const label = HORIZON_LABEL[b.horizonDays] || `${b.horizonDays}d`;
        // Color tier: high (>=60), mid (50-59), low (<50). 50 is coin-flip.
        const tier = b.hitRate >= 60 ? 'high' : b.hitRate >= 50 ? 'mid' : 'low';
        return `
            <div class="horizon-band ${tier}" title="Engine has been ${b.hitRate}% accurate at ${label} in this confidence band (n=${b.n}).">
                <div class="horizon-band-label">${label}</div>
                <div class="horizon-band-rate">${b.hitRate}%</div>
                <div class="horizon-band-bar"><div class="horizon-band-fill ${tier}" style="width: ${Math.min(100, b.hitRate)}%"></div></div>
            </div>`;
    }).join('');
    return `
        <div class="horizon-bands" title="Live ledger hit-rates per horizon at this confidence band">
            <div class="horizon-bands-title">Live accuracy by horizon</div>
            <div class="horizon-bands-row">${cells}</div>
        </div>`;
}

function renderAttribution(attribution) {
    if (!attribution || !attribution.length) return '';
    // Find the largest absolute contribution to scale bars relative to it.
    const maxAbs = Math.max(...attribution.map(a => Math.abs(a.netContribution)), 0.0001);
    const rows = attribution.slice(0, 4).map(a => {
        const label = INDICATOR_LABEL[a.indicator] || a.indicator;
        const dirClass = a.direction === 'bullish' ? 'positive' : a.direction === 'bearish' ? 'negative' : 'neutral';
        const arrow = a.direction === 'bullish' ? '▲' : a.direction === 'bearish' ? '▼' : '◆';
        const widthPct = Math.round((Math.abs(a.netContribution) / maxAbs) * 100);
        // Pull a short evidence line from the most-weighted timeframe source.
        const heaviest = a.sources.slice().sort((s1, s2) => Math.abs(s2.raw) - Math.abs(s1.raw))[0];
        const evidence = heaviest?.reason || '';
        return `
            <div class="attribution-row ${dirClass}">
                <span class="attribution-arrow ${dirClass}">${arrow}</span>
                <div class="attribution-body">
                    <div class="attribution-label">${label}</div>
                    <div class="attribution-bar"><div class="attribution-fill ${dirClass}" style="width: ${widthPct}%"></div></div>
                    <div class="attribution-evidence">${evidence}</div>
                </div>
            </div>`;
    }).join('');
    return `
        <div class="attribution-section" title="Which indicators pushed the score most. Bullish in green, bearish in red.">
            <div class="attribution-title">Why this signal — top drivers</div>
            ${rows}
        </div>`;
}
