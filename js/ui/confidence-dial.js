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
// Position of the arc HEAD (the leading tip) at a given fill fraction.
// The arc starts at START_DEG and sweeps clockwise through ARC_DEG, so the
// head angle decreases as the fill grows.
function headXY(frac) {
    const f = Math.max(0, Math.min(1, frac));
    return polar(START_DEG - ARC_DEG * f);
}

// A per-dial unique-ish id so multiple dials on one page don't share a
// gradient/filter def. No Math.random (banned in some sandboxes) — derived
// from value + a module-scoped counter.
let _dialSeq = 0;

export function renderConfidenceDial({ value, signal, label = 'confidence', size = 120 }) {
    const v = Math.max(0, Math.min(100, Math.round(value) || 0));
    const tier = tierFor(v);
    const frac = v / 100;
    const sweep = ARC_LEN * frac;
    const sublabel = signal === 'BUY' || signal === 'SELL' ? signal : '';
    const uid = `cd${(_dialSeq++).toString(36)}`;
    const h0 = headXY(0);   // head starts at the empty (lower-left) end
    return `
        <div class="conf-dial tier-${tier}" style="--dial-size:${size}px" data-conf-dial>
            <svg viewBox="0 0 120 120" class="conf-dial-svg" aria-label="${v}% ${label}">
                <defs>
                    <linearGradient id="${uid}-grad" x1="0" y1="120" x2="120" y2="0" gradientUnits="userSpaceOnUse">
                        <stop offset="0" class="cd-grad-a" />
                        <stop offset="1" class="cd-grad-b" />
                    </linearGradient>
                    <filter id="${uid}-glow" x="-60%" y="-60%" width="220%" height="220%">
                        <feGaussianBlur stdDeviation="2.4" result="b" />
                        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                </defs>
                <path class="conf-dial-track" d="${TRACK_D}" />
                <path class="conf-dial-value ${tier}" d="${TRACK_D}"
                      stroke="url(#${uid}-grad)"
                      stroke-dasharray="${ARC_LEN.toFixed(2)} ${CIRC.toFixed(2)}"
                      stroke-dashoffset="${ARC_LEN.toFixed(2)}"
                      data-dial-fill="${(ARC_LEN - sweep).toFixed(2)}" />
                <circle class="conf-dial-head ${tier}" data-dial-head
                        cx="${h0.x.toFixed(2)}" cy="${h0.y.toFixed(2)}" r="5.5"
                        filter="url(#${uid}-glow)" />
            </svg>
            <div class="conf-dial-center">
                <span class="conf-dial-readout"><span class="conf-dial-num" data-dial-num data-dial-target="${v}">0</span><span class="conf-dial-pct">%</span></span>
                ${sublabel ? `<span class="conf-dial-sub ${tier}">${sublabel}</span>` : ''}
            </div>
        </div>`;
}

// Trigger the sweep + number count-up on every dial inside `root`.
// Must run after the markup is attached to the DOM.
//
// Prefers GSAP (motion.js) when available: DrawSVG sweeps the arc and a single
// eased tween counts the number, both on the shared `premium` ease so the arc
// and the number land in perfect sync. Falls back to the original CSS-transition
// + rAF counter when GSAP isn't loaded or the user prefers reduced motion — so
// behaviour is identical-or-better everywhere, never worse.
const DIAL_DUR = 1.05;   // seconds — slightly longer so the head travel reads

export function animateDials(root = document) {
    const dials = root.querySelectorAll('[data-conf-dial]');
    dials.forEach(dial => {
        const arc = dial.querySelector('[data-dial-fill]');
        const num = dial.querySelector('[data-dial-num]');
        const head = dial.querySelector('[data-dial-head]');
        const target = num ? (parseInt(num.getAttribute('data-dial-target'), 10) || 0) : 0;
        const targetFrac = target / 100;

        const g = (typeof window !== 'undefined') ? window.gsap : null;
        const reduce = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } })();
        const useGsap = !!g && !reduce && !!window.DrawSVGPlugin;

        // Move the glowing head to the arc tip for an eased fraction, fading it
        // out over the final stretch so it "arrives" and dissolves into the tip.
        const placeHead = (easedFrac) => {
            if (!head) return;
            const p = headXY(easedFrac * targetFrac);
            head.setAttribute('cx', p.x.toFixed(2));
            head.setAttribute('cy', p.y.toFixed(2));
            // visible while travelling, fades over the last 12%
            const op = easedFrac < 0.88 ? 1 : (1 - easedFrac) / 0.12;
            head.style.opacity = Math.max(0, op).toFixed(3);
        };
        const landPulse = () => {
            if (head) head.style.opacity = '0';
            // one-shot landing pulse on the whole dial — CSS animation class.
            dial.classList.remove('conf-dial-landed');
            // force reflow so re-adding restarts the animation
            void dial.offsetWidth;
            dial.classList.add('conf-dial-landed');
        };

        if (useGsap) {
            const ease = (g.parseEase && g.parseEase('premium')) ? 'premium' : 'power3.out';
            const obj = { v: 0 };
            g.to(obj, {
                v: 1, duration: DIAL_DUR, ease,
                onUpdate: () => {
                    if (num) num.textContent = Math.round(obj.v * target).toString();
                    placeHead(obj.v);
                },
                onComplete: () => { if (num) num.textContent = target.toString(); landPulse(); },
            });
            if (arc) {
                // DrawSVG handles the dash math; draw 0% → the visible-arc fraction.
                g.fromTo(arc, { drawSVG: '0%' }, { drawSVG: `${(targetFrac * (270 / 360) * 100).toFixed(2)}%`, duration: DIAL_DUR, ease });
            }
            return;
        }

        // ── Fallback: CSS-transition arc + rAF counter that also drives head ──
        if (arc) {
            if (reduce) {
                arc.style.strokeDashoffset = arc.getAttribute('data-dial-fill');
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    arc.style.strokeDashoffset = arc.getAttribute('data-dial-fill');
                }));
            }
        }
        if (reduce) {
            if (num) num.textContent = target.toString();
            if (head) head.style.opacity = '0';
            return;
        }
        runCountAndHead(num, target, placeHead, landPulse, DIAL_DUR * 1000);
    });
}

// Single rAF loop drives BOTH the number count-up and the head travel on the
// same eased clock, so they stay in lockstep with the CSS arc transition.
function runCountAndHead(numEl, target, placeHead, landPulse, durationMs) {
    const startTs = performance.now();
    function frame(now) {
        const t = Math.min(1, (now - startTs) / durationMs);
        // easeOutCubic — fast then settle, matches the arc's cubic-bezier.
        const eased = 1 - Math.pow(1 - t, 3);
        if (numEl) numEl.textContent = Math.round(target * eased).toString();
        placeHead(eased);
        if (t < 1) requestAnimationFrame(frame);
        else { if (numEl) numEl.textContent = target.toString(); landPulse(); }
    }
    requestAnimationFrame(frame);
}
