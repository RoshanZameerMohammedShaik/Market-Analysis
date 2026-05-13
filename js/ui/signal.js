import { state } from './state.js';
import { fmtPrice } from './format.js';
import { humanizeReason, generateTechnicalExplanation } from './reasons.js';
import { renderNews } from './news.js';
import { isDev } from '../dev-mode.js';

export function renderSignal(prediction, newsData = [], sentiment = null) {
    const section = document.getElementById('signal-section');
    const { signal, confidence, rawConfidence, calibrationApplied, reasons, priceTargets } = prediction;

    const signalClass = signal.toLowerCase();
    const arrow = signal === 'BUY' ? '▲' : signal === 'SELL' ? '▼' : '◆';
    const arrowClass = signal === 'BUY' ? 'up' : signal === 'SELL' ? 'down' : 'neutral';
    const confidenceClass = confidence >= 65 ? 'high' : confidence >= 50 ? 'medium' : 'low';

    let priceTargetHTML = '';
    if (priceTargets) {
        const tfLabel = state.timeframe === 'today' ? 'Today' : 'Tomorrow';
        priceTargetHTML = `
            <div class="price-targets fade-in">
                <div class="price-targets-title">Predicted Price Range — ${tfLabel}</div>
                <div class="price-targets-grid">
                    <div class="price-target-card high">
                        <div class="price-target-label">Predicted High</div>
                        <div class="price-target-value high">${fmtPrice(priceTargets.predictedHigh)}</div>
                        <div class="price-target-pct up">▲ +${priceTargets.highPercent}%</div>
                    </div>
                    <div class="price-target-card current">
                        <div class="price-target-label">Current Price</div>
                        <div class="price-target-value">${fmtPrice(priceTargets.currentPrice)}</div>
                        <div class="price-target-pct">ATR: $${priceTargets.atr}</div>
                    </div>
                    <div class="price-target-card low">
                        <div class="price-target-label">Predicted Low</div>
                        <div class="price-target-value low">${fmtPrice(priceTargets.predictedLow)}</div>
                        <div class="price-target-pct down">▼ ${priceTargets.lowPercent}%</div>
                    </div>
                </div>
                <div class="price-targets-meta">
                    Support: $${priceTargets.support} · Resistance: $${priceTargets.resistance} · Expected Move: ±$${priceTargets.expectedMove}
                </div>
            </div>`;
    }

    const insightSummary = generateHumanInsight(prediction, sentiment);
    const newsHTML = renderNews(newsData, sentiment);

    const technicalHTML = `
        <div class="technical-section">
            <div class="section-subtitle">Technical Indicators</div>
            <div class="accordion-list">
                ${reasons.map(r => {
                    const humanized = humanizeReason(r);
                    const explanation = generateTechnicalExplanation(r, signal, state.currentSymbol);
                    const indicatorClass = /(bull|BUY|oversold|positive|upward)/i.test(r) ? 'positive'
                        : /(bear|SELL|overbought|negative|downward)/i.test(r) ? 'negative' : 'neutral';
                    return `<details class="accordion-item tech-accordion">
                        <summary class="accordion-header">
                            <span class="accordion-dot ${indicatorClass}"></span>
                            <div class="accordion-header-content"><div class="accordion-title">${humanized}</div></div>
                            <span class="accordion-chevron">▸</span>
                        </summary>
                        <div class="accordion-body"><div class="accordion-explanation">${explanation}</div></div>
                    </details>`;
                }).join('')}
            </div>
        </div>`;

    let breakdownHTML = '';
    if (prediction.breakdown) {
        const bd = prediction.breakdown;
        const row = (label, score, weight, color) => `
            <div class="breakdown-item">
                <span class="breakdown-label">${label} (${weight}%)</span>
                <div class="breakdown-bar"><div class="breakdown-fill" style="width: ${score}%; background: ${color};"></div></div>
                <span class="breakdown-score">${score}</span>
            </div>`;
        breakdownHTML = `
            <div class="source-breakdown">
                <div class="breakdown-title">Confidence Sources</div>
                <div class="breakdown-bars">
                    ${bd.ai.available ? row('AI Model', bd.ai.score, bd.ai.weight, 'var(--accent)') : ''}
                    ${row('Technicals', bd.technical.score, bd.technical.weight, 'var(--green)')}
                    ${row('Sentiment', bd.sentiment.score, bd.sentiment.weight, 'var(--yellow)')}
                    ${row('Market', bd.market.score, bd.market.weight, '#a371f7')}
                </div>
            </div>`;
    }

    // Calibration meta-info: only operators (?dev=1) need to see whether
    // the displayed confidence is calibrated or raw. Public users get
    // the calibrated number itself — they just don't get the badge
    // explaining how it was produced.
    const calibrationBadge = isDev()
        ? (calibrationApplied
            ? `<span class="cal-badge calibrated" title="Confidence adjusted to match backtested hit rate">✓ calibrated</span>`
            : `<span class="cal-badge raw" title="No backtest data yet — confidence is heuristic, not empirical. Run backtest.py to calibrate.">! raw</span>`)
        : '';

    const calibrationDelta = (isDev() && calibrationApplied && rawConfidence !== confidence)
        ? `<span class="cal-delta">heuristic ${rawConfidence}% → historical ${confidence}%</span>`
        : '';

    const methodLabel = prediction.method || 'Technical + News + Multi-Timeframe';

    section.innerHTML = `
        <div class="signal-box ${signalClass} fade-in">
            <div class="signal-header">
                <span class="signal-arrow ${arrowClass}">${arrow}</span>
                <span class="signal-label ${signalClass}">${signal}</span>
                <span class="signal-confidence">${confidence}%</span>
                ${calibrationBadge}
                <button class="refresh-btn small" id="refresh-analysis" title="Re-run analysis">↻</button>
            </div>
            ${calibrationDelta ? `<div class="cal-delta-row">${calibrationDelta}</div>` : ''}
            <div class="confidence-bar">
                <div class="confidence-fill ${confidenceClass}" style="width: ${confidence}%"></div>
            </div>
            ${breakdownHTML}
            <div class="insight-summary">${insightSummary}</div>
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
}

function generateHumanInsight(prediction, sentiment) {
    const { signal, confidence, priceTargets } = prediction;
    const tfWord = state.timeframe === 'today' ? 'today' : 'tomorrow';
    let insight = '';

    if (signal === 'BUY') {
        if (confidence >= 70) insight = `<strong>Strong bullish signal.</strong> Multiple indicators align upward. `;
        else if (confidence >= 55) insight = `<strong>Moderate buy signal.</strong> More indicators point up than down. `;
        else insight = `<strong>Weak buy signal.</strong> Slight bullish edge but low conviction. `;
        if (priceTargets) {
            insight += `Price could reach <span class="highlight-green">$${priceTargets.predictedHigh}</span> ${tfWord} (+${priceTargets.highPercent}%). Downside risk to $${priceTargets.predictedLow} (${priceTargets.lowPercent}%).`;
        }
    } else if (signal === 'SELL') {
        if (confidence >= 70) insight = `<strong>Strong bearish signal.</strong> Multiple indicators point to decline. `;
        else if (confidence >= 55) insight = `<strong>Moderate sell signal.</strong> Bearish pressure building. `;
        else insight = `<strong>Weak sell signal.</strong> Slight bearish edge but uncertain. `;
        if (priceTargets) {
            insight += `Price may drop to <span class="highlight-red">$${priceTargets.predictedLow}</span> ${tfWord} (${priceTargets.lowPercent}%). Upside capped around $${priceTargets.predictedHigh} (+${priceTargets.highPercent}%).`;
        }
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
