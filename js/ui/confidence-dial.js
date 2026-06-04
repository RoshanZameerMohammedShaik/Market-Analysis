// Radial confidence gauge — a 270° SVG arc that sweeps from the floor
// to the confidence value with eased animation, color-graded by tier.
// Replaces (well, augments) the flat confidence bar in the signal card.
//
// Pure presentational + dependency-free so it can be reused anywhere a
// 0–100 confidence needs a visceral readout (signal card, earnings
// calendar pre-reads, options scanner rows).
//
// Usage:
//   container.innerHTML = renderConfidenceDial({ value: 67, signal: 'BUY' });
//   animateDials(container);   // call after it's in the DOM to trigger the sweep

const ARC_DEG = 270;                       // gap at the bottom
const START_DEG = 135;                     // start at lower-left
const R = 52;                              // arc radius within a 120-box
const CX = 60, CY = 60;
const CIRC = 2 * Math.PI * R;
const ARC_LEN = CIRC * (ARC_DEG / 360);    // length of the visible track

function tierFor(value) {
    if (value >= 65) return 'high';
    if (value >= 50) return 'mid';
    return 'low';
}

// Convert a polar angle (deg, 0 = +x axis, CCW) to an SVG x/y.
function polar(deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

// Build the "d" for the full 270° track (start lower-left, sweep CW
// through the top to lower-right).
function trackPath() {
    const start = polar(START_DEG);
    const end = polar(START_DEG - ARC_DEG);
    // large-arc-flag = 1 (270° > 180°), sweep-flag = 1 (clockwise, screen coords)
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 1 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

const TRACK_D = trackPath();

// Render one dial. The value arc uses stroke-dasharray/offset so we can
// animate the sweep purely via a CSS transition on stroke-dashoffset.
// data-dial-target carries the final fraction so animateDials() can set
// the offset after a reflow (otherwise the browser paints it filled).
export function renderConfidenceDial({ value, signal, label = 'confidence', size = 120 }) {
    const v = Math.max(0, Math.min(100, Math.round(value) || 0));
    const tier = tierFor(v);
    const frac = v / 100;
    const sweep = ARC_LEN * frac;
    const gap = ARC_LEN - sweep;
    const sublabel = signal === 'BUY' || signal === 'SELL' ? signal : '';
    return `
        <div class="conf-dial tier-${tier}" style="--dial-size:${size}px" data-conf-dial>
            <svg viewBox="0 0 120 120" class="conf-dial-svg" aria-label="${v}% ${label}">
                <path class="conf-dial-track" d="${TRACK_D}" />
                <path class="conf-dial-value ${tier}" d="${TRACK_D}"
                      stroke-dasharray="${ARC_LEN.toFixed(2)} ${CIRC.toFixed(2)}"
                      stroke-dashoffset="${ARC_LEN.toFixed(2)}"
                      data-dial-fill="${(ARC_LEN - sweep).toFixed(2)}" />
            </svg>
            <div class="conf-dial-center">
                <span class="conf-dial-num" data-dial-num data-dial-target="${v}">0</span>
                <span class="conf-dial-pct">%</span>
                ${sublabel ? `<span class="conf-dial-sub ${tier}">${sublabel}</span>` : ''}
            </div>
        </div>`;
}

// Trigger the sweep + number count-up on every dial inside `root`.
// Must run after the markup is attached to the DOM.
export function animateDials(root = document) {
    const dials = root.querySelectorAll('[data-conf-dial]');
    dials.forEach(dial => {
        const arc = dial.querySelector('[data-dial-fill]');
        const num = dial.querySelector('[data-dial-num]');
        if (arc) {
            const target = arc.getAttribute('data-dial-fill');
            // Double rAF so the initial (empty) dashoffset is painted
            // before we transition to the filled value.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                arc.style.strokeDashoffset = target;
            }));
        }
        if (num) {
            const target = parseInt(num.getAttribute('data-dial-target'), 10) || 0;
            countUp(num, target, 900);
        }
    });
}

function countUp(el, target, durationMs) {
    const startTs = performance.now();
    function frame(now) {
        const t = Math.min(1, (now - startTs) / durationMs);
        // easeOutCubic — fast then settle, matches the arc sweep.
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(target * eased).toString();
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = target.toString();
    }
    requestAnimationFrame(frame);
}
