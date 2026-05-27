// Time-travel mode UI.
//
// Adds a date control to the chart header. When the user picks a past
// date, the analysis pipeline truncates all fetched candles at that
// date, rewrites currentPrice to the close on that day, and re-runs
// the engine. The result is "what the engine WOULD have said on that
// day, looking only at the bars available then".
//
// Why this is more interesting than a normal backtest: the user can
// pick any symbol and any date in their head, get the engine's read,
// and visually compare to what actually happened next on the chart.
// It's the single most distinctive feature this app can ship — no
// normal charting tool replays the engine's mind.
//
// Logged predictions are skipped while in time-travel mode (see
// core.js) so live calibration metrics aren't polluted by
// hypotheticals.

import { state } from './state.js';

let uiBuilt = false;

function todayIso() { return new Date().toISOString().slice(0, 10); }

function clampDate(iso) {
    const today = todayIso();
    if (!iso) return null;
    if (iso > today) return today;
    return iso;
}

function ensureUI() {
    if (uiBuilt) return;
    const headerEl = document.getElementById('chart-header');
    if (!headerEl) return;

    // The control sits next to the watch-toggle button. Compact:
    // a button that opens a tiny popover with a date input.
    const wrap = document.createElement('div');
    wrap.className = 'time-travel-wrap';
    wrap.innerHTML = `
        <button class="time-travel-btn" id="time-travel-btn" title="Replay engine on a past date">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"/>
                <polyline points="12 7 12 12 16 14"/>
                <path d="M3 12 a 9 9 0 0 1 -1.5 -4.5"/>
            </svg>
            <span class="time-travel-label">Live</span>
        </button>
        <div class="time-travel-popover" id="time-travel-popover" hidden>
            <div class="time-travel-row">
                <label for="time-travel-input">Replay engine on date:</label>
                <input type="date" id="time-travel-input" max="${todayIso()}">
            </div>
            <div class="time-travel-actions">
                <button class="tt-back-live" id="tt-back-live">Back to live</button>
                <button class="tt-apply" id="tt-apply">Apply</button>
            </div>
            <div class="time-travel-hint">Truncates the chart and re-runs the engine on bars available then. Predictions in this mode are hypothetical and not logged.</div>
        </div>`;
    headerEl.appendChild(wrap);

    const btn = document.getElementById('time-travel-btn');
    const pop = document.getElementById('time-travel-popover');
    const input = document.getElementById('time-travel-input');
    const apply = document.getElementById('tt-apply');
    const backLive = document.getElementById('tt-back-live');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const showing = !pop.hasAttribute('hidden');
        if (showing) pop.setAttribute('hidden', '');
        else pop.removeAttribute('hidden');
        input.value = state.timeTravelDate || '';
    });
    document.addEventListener('click', (e) => {
        if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            pop.setAttribute('hidden', '');
        }
    });
    apply.addEventListener('click', () => {
        const iso = clampDate(input.value);
        if (!iso) return;
        state.timeTravelDate = iso;
        pop.setAttribute('hidden', '');
        renderButtonLabel();
        // Re-run analysis on the current symbol if any. We do this by
        // dispatching the existing refresh handler.
        document.getElementById('refresh-analysis')?.click();
    });
    backLive.addEventListener('click', () => {
        state.timeTravelDate = null;
        pop.setAttribute('hidden', '');
        renderButtonLabel();
        document.getElementById('refresh-analysis')?.click();
    });

    uiBuilt = true;
}

function renderButtonLabel() {
    const btn = document.getElementById('time-travel-btn');
    if (!btn) return;
    const label = btn.querySelector('.time-travel-label');
    if (state.timeTravelDate) {
        btn.classList.add('active');
        label.textContent = state.timeTravelDate;
    } else {
        btn.classList.remove('active');
        label.textContent = 'Live';
    }
}

export function attachTimeTravel() {
    ensureUI();
    renderButtonLabel();
}
