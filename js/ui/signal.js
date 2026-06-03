import { state } from './state.js';
import { fmtPriceTag, fmtPrice } from './format.js';
import { humanizeReason, generateTechnicalExplanation } from './reasons.js';
import { renderNews } from './news.js';
import { isDev } from '../dev-mode.js';
import { animateNumber } from './animate.js';
import { renderPennyDashboard } from './penny-dashboard.js';
import { getCalibrationSource } from '../calibration.js';

let lastShownConfidence = null;
let lastShownSymbol = null;

export function renderSignal(prediction, newsData = [], sentiment = null) {
    const section = document.getElementById('signal-section');
    const { signal, confidence, confidenceRange, rawConfidence, calibrationApplied, reasons, priceTargets, trendRegime, regime, sector, earnings } = prediction;
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
    const confidenceClass = confidence >= 65 ? 'high' : confidence >= 50 ? 'medium' : 'low';

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
            <div class="price-targets fade-in">
                <div class="price-targets-title">Predicted Price Range — ${tfLabel}</div>
                ${probableStrip}
                <div class="price-targets-grid">
                    <div class="price-target-card high">
                        <div class="price-target-label">Possible High</div>
                        <div class="price-target-value high">${fmtPriceTag(priceTargets.predictedHigh, co)}</div>
                        <div class="price-target-pct up">▲ +${priceTargets.highPercent}%</div>
                    </div>
                    <div class="price-target-card current">
                        <div class="price-target-label">Current Price</div>
                        <div class="price-target-value">${fmtPriceTag(priceTargets.currentPrice, co)}</div>
                        <div class="price-target-pct">ATR: ${fmtPriceTag(priceTargets.atr, co)}</div>
                    </div>
                    <div class="price-target-card low">
                        <div class="price-target-label">Possible Low</div>
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

    const technicalHTML = `
        <div class="technical-section">
            <div class="section-subtitle">Technical Indicators</div>
            <div class="accordion-list">
                ${reasons.map(r => {
                    const humanized = humanizeReason(r);
                    // Try for a textbook explanation; fall back to the
                    // raw reason if no rule matches. The engine's reason
                    // strings are already specific ("Sector: Tech rising
                    // 1.2%/5d — aligned"), so showing them verbatim is
                    // far better than rendering an identical generic
                    // placeholder ten times in a row.
                    const explanation = generateTechnicalExplanation(r, signal, state.currentSymbol);
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

    section.innerHTML = `
        <div class="signal-box ${signalClass} fade-in">
            <div class="signal-header">
                <span class="signal-arrow ${arrowClass}">${arrow}</span>
                <span class="signal-label ${signalClass}">${signalDisplay}</span>
                <span class="signal-confidence" id="signal-conf-num">${confidence}%</span>
                ${rangeHTML}
                ${trendChip}
                ${macroChip}
                ${calibrationBadge}
                <button class="refresh-btn small" id="refresh-analysis" title="Re-run analysis">↻</button>
            </div>
            ${calibrationDelta ? `<div class="cal-delta-row">${calibrationDelta}</div>` : ''}
            <div class="confidence-bar">
                <div class="confidence-fill ${confidenceClass}" style="width: ${confidence}%"></div>
            </div>
            ${breakdownHTML}
            ${pennyDashboardHTML}
            <div class="insight-summary">${insightSummary}</div>
            ${attributionHTML}
            ${priceTargetHTML}
            ${newsHTML}
            ${technicalHTML}
            <div class="signal-meta" style="margin-top: 12px;">
                Timeframe: ${state.timeframe === 'today' ? 'Today' : 'Tomorrow'} · ${methodLabel}
            </div>
            <div class="risk-disclaimer">
                <strong>Not financial advice.</strong> Predictions are statistical signals, not guarantees. Past performance does not predict future results. Trade at your own risk.
            </div>
        </div>`;

    if (lastShownSymbol === state.currentSymbol && lastShownConfidence !== null && lastShownConfidence !== confidence) {
        animateNumber(document.getElementById('signal-conf-num'), lastShownConfidence, confidence);
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
