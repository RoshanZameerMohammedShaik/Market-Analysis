// Phase 8 — Penny Risk dashboard.
//
// Renders a focused panel ALONGSIDE the engine signal whenever
// liquidityTier === 'penny'. Surfaces the float / short / FINRA / Insider /
// Social signals that are otherwise buried in the reasons list.
//
// On non-penny stocks: returns empty string. The signal card stays clean.

import { fmtPriceTag } from './format.js';

function shareLabel(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return String(n);
}

function usdLabel(n) {
    if (!Number.isFinite(n)) return '?';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '+';
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
    return `${sign}$${Math.round(abs)}`;
}

function floatRow(p) {
    if (!p) return '';
    const bucket = p.floatBucket || '?';
    const arrow = bucket === 'micro' ? '▲ MICRO' : bucket === 'small' ? '▲ small' : bucket === 'mid' ? '◆ mid' : '⋯ normal';
    const cls = bucket === 'micro' ? 'risk-high' : bucket === 'small' ? 'risk-warn' : 'risk-ok';
    return `<div class="penny-row">
        <span class="penny-label">Float</span>
        <span class="penny-value">${shareLabel(p.floatShares)}</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

function shortRow(p) {
    if (!p || p.shortPercentOfFloat == null) return '';
    const pct = (p.shortPercentOfFloat * 100).toFixed(1) + '%';
    const bucket = p.shortBucket || '?';
    const arrow = bucket === 'extreme' ? '▲ EXTREME' : bucket === 'high' ? '▲ high' : bucket === 'normal' ? '⋯ normal' : '⋯ low';
    const cls = bucket === 'extreme' ? 'risk-high' : bucket === 'high' ? 'risk-warn' : 'risk-ok';
    return `<div class="penny-row">
        <span class="penny-label">Short Interest</span>
        <span class="penny-value">${pct}</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

function finraRow(f) {
    if (!f || !f.found) return '';
    const pct = f.shortVolumeRatio != null ? (f.shortVolumeRatio * 100).toFixed(0) + '%' : '?';
    const ratio = f.shortVolumeRatio || 0;
    const arrow = ratio > 0.55 ? '▲ aggressive' : ratio < 0.30 ? '▼ covering' : '⋯ normal';
    const cls = ratio > 0.55 ? 'risk-high' : ratio < 0.30 ? 'risk-good' : 'risk-ok';
    return `<div class="penny-row">
        <span class="penny-label">FINRA Today</span>
        <span class="penny-value">${pct}</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

function insiderRow(i) {
    if (!i || !i.found) return '';
    const buys = i.buyCount || 0;
    const sells = i.sellCount || 0;
    const net = i.netBuyValue || 0;
    let arrow = '⋯ neutral', cls = 'risk-ok';
    if (buys >= 3) { arrow = '★ cluster'; cls = 'risk-good'; }
    else if (sells >= 3) { arrow = '▼ selling'; cls = 'risk-warn'; }
    else if (net > 100000) { arrow = '▲ buying'; cls = 'risk-good'; }
    else if (net < -500000) { arrow = '▼ heavy sell'; cls = 'risk-warn'; }
    return `<div class="penny-row">
        <span class="penny-label">Insiders 30d</span>
        <span class="penny-value">${buys} buys / ${sells} sells • ${usdLabel(net)}</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

function socialRow(s) {
    if (!s) return '';
    const label = s.label || 'unknown';
    const total = s.totalLast24h || 0;
    const peak = s.peakVelocity || 0;
    const arrow = label === 'extreme' ? '▲ PUMP' : label === 'high' ? '▲ active' : label === 'elevated' ? '⋯ rising' : label === 'quiet' ? '⋯ quiet' : '⋯ normal';
    const cls = label === 'extreme' ? 'risk-high' : label === 'high' ? 'risk-warn' : 'risk-ok';
    const valTxt = label === 'quiet' ? 'no chatter' : `${total}/24h • ${peak}×`;
    return `<div class="penny-row">
        <span class="penny-label">Social</span>
        <span class="penny-value">${valTxt}</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

function squeezeRow(p) {
    if (!p || p.squeezeRisk == null) return '';
    const pct = Math.round(p.squeezeRisk * 100);
    let arrow = '⋯ low', cls = 'risk-ok';
    if (pct >= 70) { arrow = '▲ HIGH'; cls = 'risk-high'; }
    else if (pct >= 40) { arrow = '▲ elevated'; cls = 'risk-warn'; }
    return `<div class="penny-row">
        <span class="penny-label">Squeeze Risk</span>
        <span class="penny-value">${pct}/100</span>
        <span class="penny-tag ${cls}">${arrow}</span>
    </div>`;
}

export function renderPennyDashboard(prediction) {
    if (!prediction || prediction.liquidityTier !== 'penny') return '';

    const sections = [
        floatRow(prediction.penny),
        shortRow(prediction.penny),
        finraRow(prediction.finraShort),
        insiderRow(prediction.insider),
        socialRow(prediction.socialVelocity),
        squeezeRow(prediction.penny),
    ].filter(Boolean).join('');

    if (!sections) return '';

    return `
        <div class="penny-dashboard fade-in">
            <div class="penny-dashboard-header">
                <span class="penny-dashboard-icon">💸</span>
                <span class="penny-dashboard-title">Penny Risk</span>
                <span class="penny-dashboard-hint">Float • short interest • insiders • social</span>
            </div>
            <div class="penny-dashboard-body">${sections}</div>
        </div>`;
}
