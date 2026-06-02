// Mia toggle ↔ send-button morph — bouncy ball trajectory.
//
// Roshan's spec: "user clicks Mia toggle, the toggle immediately
// becomes a small dot like ball, falls and jumps toward the position
// of the Send button, and becomes that send button by getting
// expanded or taking the form of the send button. All of this should
// happen quickly as the Mia panel opens."
//
// Implementation:
//   1. Capture toggle bbox at click. Hide the real toggle.
//   2. Wait one frame for the panel render to mount the send button.
//   3. Capture the send button bbox. Hide the real send button.
//   4. Spawn a fixed-position clone over the toggle. Run a multi-stage
//      keyframe animation:
//        a. Compress the disc to a small dot (~35% scale) with a
//           tiny downward "drop" so it reads as a ball loading the
//           jump (Roshan's "falls" beat).
//        b. Two parabolic arcs forward — first arc reaches a high
//           peak, second arc smaller — landing at the send-button
//           position. Background colour fades white → accent across
//           the journey.
//        c. Expand the dot to send-button dimensions while staying
//           at the send-button position. Final frame matches the
//           real send button's box.
//   5. Reveal the real send button, remove the clone.
//
// Reverse direction (panel close): mirror the path. Send button
// compresses to a coloured dot, bounces back to the toggle corner,
// expands into the white toggle disc.
//
// Per-segment easing: each arc uses cubic-bezier with negative tail
// values to give the ball a slight "anticipation" before each jump
// (loads), and positive ease-out at peaks so the ball lingers
// momentarily at the top of each arc — the bouncy feel.

const CLONE_ID = 'mia-morph-clone';
const FORWARD_MS = 700;
const REVERSE_MS = 600;

function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

function removeClone() {
    document.getElementById(CLONE_ID)?.remove();
}

function getThemeColors() {
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '').trim() || '#4a9eff';
    const accentRgb = (css.getPropertyValue('--accent-rgb') || '').trim() || '74, 158, 255';
    return { accent, accentRgb };
}

function buildClone(rect, look) {
    const el = document.createElement('div');
    el.id = CLONE_ID;
    Object.assign(el.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        padding: '0',
        zIndex: '1500',
        pointerEvents: 'none',
        borderRadius: '50%',
        background: look.background,
        boxShadow: look.boxShadow,
        willChange: 'transform, background, box-shadow, border-radius',
        // Establish a positioned context so transforms don't fight
        // the body's layout.
        contain: 'layout',
    });
    return el;
}

function runAnimation(el, keyframes, durationMs) {
    return new Promise(resolve => {
        // Hard timeout fallback in case onfinish doesn't fire (browser
        // background-tab freeze, animation cancellation, etc.).
        const fallback = setTimeout(resolve, durationMs + 250);
        try {
            const anim = el.animate(keyframes, { duration: durationMs, fill: 'forwards' });
            anim.addEventListener('finish', () => {
                clearTimeout(fallback);
                resolve();
            }, { once: true });
        } catch (_) {
            // Element.animate not supported — just resolve so the
            // caller can clean up. The morph will be invisible but
            // the panel still opens correctly.
            clearTimeout(fallback);
            resolve();
        }
    });
}

/**
 * Forward morph: toggle → send button. Call right after openSidePanel
 * but before the panel fully settles, so the send button is mounted
 * by the next animation frame.
 */
export async function morphToggleToSend() {
    if (reducedMotion()) return;
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return;
    const fromRect = launcher.getBoundingClientRect();

    // Wait one frame so the panel render has placed the send button.
    await new Promise(r => requestAnimationFrame(r));

    const sendBtn = document.querySelector('#mia-panel .mia-action-btn');
    if (!sendBtn) return;
    const toRect = sendBtn.getBoundingClientRect();

    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    const sx = toRect.width / fromRect.width;
    const sy = toRect.height / fromRect.height;

    const { accent, accentRgb } = getThemeColors();

    removeClone();
    launcher.style.opacity = '0';
    sendBtn.style.opacity = '0';

    const clone = buildClone(fromRect, {
        background: '#ffffff',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.05)',
    });
    document.body.appendChild(clone);

    // Ball diameter during flight ≈ 35% of toggle size ≈ 18px.
    // Two arcs: first peaks high above the linear path, second
    // smaller. The "fall" beat is offset 0.08 — a 14px downward
    // squish that loads the jump (Roshan's "falls and jumps").
    const BALL = 0.35;
    const keyframes = [
        { offset: 0,
          transform: 'translate(0, 0) scale(1)',
          background: '#ffffff',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.05)',
          easing: 'cubic-bezier(0.55, 0, 0.55, 1)' },
        // 1. Compress to a ball + a 14px downward "load" before jumping.
        { offset: 0.08,
          transform: `translate(0, 14px) scale(${BALL})`,
          background: '#ffffff',
          boxShadow: '0 4px 10px rgba(0, 0, 0, 0.28)',
          easing: 'cubic-bezier(0.30, 0, 0.20, 1)' },
        // 2. First (big) arc peak — high above the linear path.
        { offset: 0.24,
          transform: `translate(${dx * 0.30}px, ${dy * 0.45 - 72}px) scale(${BALL})`,
          background: '#f0f3fa',
          easing: 'cubic-bezier(0.55, 0, 0.55, 1)' },
        // 3. First landing — slight squish below the path.
        { offset: 0.44,
          transform: `translate(${dx * 0.60}px, ${dy * 0.92 + 6}px) scaleX(${BALL * 1.08}) scaleY(${BALL * 0.92})`,
          background: '#dbe6ff',
          easing: 'cubic-bezier(0.30, 0, 0.20, 1)' },
        // 4. Second (smaller) arc peak — colour shifts to accent blue.
        { offset: 0.60,
          transform: `translate(${dx * 0.82}px, ${dy * 0.70 - 32}px) scale(${BALL})`,
          background: '#a8c1ff',
          easing: 'cubic-bezier(0.55, 0, 0.55, 1)' },
        // 5. Lands at destination as a coloured ball.
        { offset: 0.78,
          transform: `translate(${dx}px, ${dy + 4}px) scaleX(${BALL * 1.06}) scaleY(${BALL * 0.94})`,
          background: accent,
          boxShadow: `0 6px 16px rgba(${accentRgb}, 0.45)`,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
        // 6. Expands to send-button rect (final frame, held by fill: forwards).
        { offset: 1,
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          background: accent,
          boxShadow: `0 4px 12px rgba(${accentRgb}, 0.40)` },
    ];

    await runAnimation(clone, keyframes, FORWARD_MS);

    // Reveal the real send button, drop the clone.
    sendBtn.style.opacity = '';
    removeClone();
}

/**
 * Reverse morph: send button → toggle. Call BEFORE the panel slides
 * out so the send button is still mounted and reachable.
 */
export async function morphSendToToggle() {
    if (reducedMotion()) return;
    const launcher = document.getElementById('mia-launcher');
    const sendBtn = document.querySelector('#mia-panel .mia-action-btn');
    if (!launcher || !sendBtn) return;

    const fromRect = sendBtn.getBoundingClientRect();
    const toRect = launcher.getBoundingClientRect();

    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    const sx = toRect.width / fromRect.width;
    const sy = toRect.height / fromRect.height;

    const { accent, accentRgb } = getThemeColors();

    removeClone();
    sendBtn.style.opacity = '0';
    launcher.style.opacity = '0';

    const clone = buildClone(fromRect, {
        background: accent,
        boxShadow: `0 4px 12px rgba(${accentRgb}, 0.40)`,
    });
    document.body.appendChild(clone);

    // Ball ≈ 40% of send-button size ≈ 18px (roughly same physical
    // diameter as the forward direction).
    const BALL = 0.40;
    const keyframes = [
        { offset: 0,
          transform: 'translate(0, 0) scale(1, 1)',
          background: accent,
          boxShadow: `0 4px 12px rgba(${accentRgb}, 0.40)`,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
        // 1. Compress to a ball + tiny upward bob (the send button
        //    "lifts off" before launching back).
        { offset: 0.10,
          transform: `translate(0, -6px) scale(${BALL})`,
          background: accent,
          easing: 'cubic-bezier(0.55, 0, 0.55, 1)' },
        // 2. First arc peak.
        { offset: 0.26,
          transform: `translate(${dx * 0.22}px, ${dy * 0.40 - 30}px) scale(${BALL})`,
          background: '#a8c1ff',
          easing: 'cubic-bezier(0.30, 0, 0.20, 1)' },
        // 3. Landing 1.
        { offset: 0.46,
          transform: `translate(${dx * 0.50}px, ${dy * 0.72 + 4}px) scaleX(${BALL * 1.08}) scaleY(${BALL * 0.92})`,
          background: '#dbe6ff',
          easing: 'cubic-bezier(0.55, 0, 0.55, 1)' },
        // 4. Second (bigger) arc peak — colour fades to white.
        { offset: 0.62,
          transform: `translate(${dx * 0.78}px, ${dy * 0.50 - 56}px) scale(${BALL})`,
          background: '#f0f3fa',
          easing: 'cubic-bezier(0.30, 0, 0.20, 1)' },
        // 5. Lands at toggle position as a white ball.
        { offset: 0.80,
          transform: `translate(${dx}px, ${dy + 8}px) scaleX(${BALL * 1.06}) scaleY(${BALL * 0.94})`,
          background: '#ffffff',
          boxShadow: '0 4px 10px rgba(0, 0, 0, 0.28)',
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
        // 6. Expands into toggle shape (final frame).
        { offset: 1,
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          background: '#ffffff',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.30), 0 0 0 1px rgba(0, 0, 0, 0.05)' },
    ];

    await runAnimation(clone, keyframes, REVERSE_MS);

    // Reveal real toggle, drop the clone.
    launcher.style.opacity = '';
    removeClone();
}
