// Renders the live accuracy strip + calibration table. The strip is
// always visible at the top of the signal area when there's enough data.

import { getStats } from '../outcome-tracker.js';
import { getCalibrationCurve, getCalibrationStatus } from '../calibration.js';

export function renderAccuracyStrip() {
    const container = document.getElementById('accuracy-strip');
    if (!container) return;

    const stats = getStats();
    const calCurve = getCalibrationCurve();
    const calStatus = getCalibrationStatus();

    if (!stats.total && calStatus !== 'loaded') {
        container.innerHTML = '';
        return;
    }

    const liveBlock = stats.total > 0 ? `
        <div class="acc-block">
            <div class="acc-label">Your live hit rate</div>
            <div class="acc-value ${stats.hitRate >= 55 ? 'good' : stats.hitRate >= 45 ? 'meh' : 'bad'}">${stats.hitRate}%</div>
            <div class="acc-meta">${stats.hits}/${stats.total} resolved · ${stats.pending} pending</div>
        </div>` : `
        <div class="acc-block">
            <div class="acc-label">Your live hit rate</div>
            <div class="acc-value muted">—</div>
            <div class="acc-meta">${stats.pending} prediction${stats.pending === 1 ? '' : 's'} pending</div>
        </div>`;

    const backtestBlock = calStatus === 'loaded' ? `
        <div class="acc-block">
            <div class="acc-label">Historical (backtest)</div>
            <div class="acc-value good">✓ calibrated</div>
            <div class="acc-meta">Confidence shown reflects backtested hit rate</div>
        </div>` : `
        <div class="acc-block">
            <div class="acc-label">Historical (backtest)</div>
            <div class="acc-value muted">not loaded</div>
            <div class="acc-meta"><code>python backtest.py</code> to enable</div>
        </div>`;

    container.innerHTML = `<div class="accuracy-strip-inner">${liveBlock}${backtestBlock}</div>`;
}
