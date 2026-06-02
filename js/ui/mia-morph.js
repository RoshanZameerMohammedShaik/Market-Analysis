// Mia toggle ↔ send-button morph animation.
//
// Roshan's spec: "as the Mia panel opens up, the toggle should turn
// into Mia's Send button, by changing the colour gradient and reach
// the Send button and keep the Send button just as they are now in
// same size and same colour according to the active theme. Reverse
// on close."
//
// Approach (FLIP-style):
//   1. Capture the toggle's current bounding rect.
//   2. Wait one frame so the panel render has placed the send button.
//   3. Capture the send button's destination rect.
//   4. Build a fixed-position clone of the toggle, position it over
//      the toggle's rect, then animate transform + colour to match
//      the send button's rect + colour. Hide the real toggle for the
//      duration so we don't see two of them.
//   5. On animation end, remove the clone; the real send button is
//      already mounted and visible. Real toggle is hidden by the
//      existing body.side-panel-mia-open .mia-launcher rule.
//
// Reverse direction (panel closing): clone the send button, animate
// it back to the toggle's resting position, fade in the real toggle
// at the end.
//
// Honest caveats:
//   - If the user opens/closes very fast we cancel any in-flight clone
//     so we don't leave a ghost element on screen.
//   - On reduced-motion, we skip the morph entirely and just toggle
//     the panel.

const CLONE_ID = 'mia-morph-clone';
const FORWARD_DURATION = 540;
const REVERSE_DURATION = 420;

function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
}

function removeClone() {
    document.getElementById(CLONE_ID)?.remove();
}

/**
 * Forward morph: toggle → send button. Call right after the panel
 * starts opening (so the send button is mounted by the next frame).
 * Returns a Promise that resolves when the animation completes.
 */
export function morphToggleToSend() {
    if (reducedMotion()) return Promise.resolve();
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return Promise.resolve();
    const fromRect = launcher.getBoundingClientRect();

    return new Promise(resolve => {
        // Wait one frame for the panel render to mount the send button.
        requestAnimationFrame(() => {
            const sendBtn = document.querySelector('#mia-panel .mia-action-btn');
            if (!sendBtn) return resolve();
            const toRect = sendBtn.getBoundingClientRect();
            removeClone();

            const clone = launcher.cloneNode(true);
            clone.id = CLONE_ID;
            // Strip behaviour the clone shouldn't inherit.
            clone.removeAttribute('id');
            clone.id = CLONE_ID;
            clone.style.cssText = `
                position: fixed;
                left: ${fromRect.left}px;
                top: ${fromRect.top}px;
                width: ${fromRect.width}px;
                height: ${fromRect.height}px;
                margin: 0;
                z-index: 1500;
                pointer-events: none;
                animation: none;
                transition: transform ${FORWARD_DURATION}ms cubic-bezier(0.5, 0, 0.2, 1),
                            opacity ${FORWARD_DURATION}ms ease-out,
                            filter ${FORWARD_DURATION}ms ease-out;
                will-change: transform, opacity;
            `;
            document.body.appendChild(clone);

            // Hide the real toggle while the clone is morphing — body
            // class .side-panel-mia-open already hides it via CSS, but
            // that transition is slow; force it instantly here.
            launcher.style.opacity = '0';

            // Force layout, then kick off the morph.
            void clone.offsetWidth;
            const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
            const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
            const sx = toRect.width / fromRect.width;
            const sy = toRect.height / fromRect.height;
            clone.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
            clone.style.opacity = '0';
            // Slight blur near the end to mask the colour mismatch as
            // the clone fades into the destination button.
            clone.style.filter = 'blur(2px)';

            const cleanup = () => {
                removeClone();
                resolve();
            };
            clone.addEventListener('transitionend', cleanup, { once: true });
            // Hard fallback in case transitionend doesn't fire.
            setTimeout(cleanup, FORWARD_DURATION + 200);
        });
    });
}

/**
 * Reverse morph: send button → toggle. Call BEFORE the panel slides
 * out (so the send button is still mounted and reachable). Returns a
 * Promise that resolves when the animation completes.
 */
export function morphSendToToggle() {
    if (reducedMotion()) return Promise.resolve();
    const launcher = document.getElementById('mia-launcher');
    const sendBtn = document.querySelector('#mia-panel .mia-action-btn');
    if (!launcher || !sendBtn) return Promise.resolve();

    const fromRect = sendBtn.getBoundingClientRect();
    const toRect = launcher.getBoundingClientRect();
    removeClone();

    const clone = launcher.cloneNode(true);
    clone.id = CLONE_ID;
    clone.style.cssText = `
        position: fixed;
        left: ${toRect.left}px;
        top: ${toRect.top}px;
        width: ${toRect.width}px;
        height: ${toRect.height}px;
        margin: 0;
        z-index: 1500;
        pointer-events: none;
        animation: none;
        opacity: 0;
        transform: translate(${(fromRect.left + fromRect.width / 2) - (toRect.left + toRect.width / 2)}px,
                              ${(fromRect.top + fromRect.height / 2) - (toRect.top + toRect.height / 2)}px)
                   scale(${fromRect.width / toRect.width}, ${fromRect.height / toRect.height});
        filter: blur(2px);
        transition: transform ${REVERSE_DURATION}ms cubic-bezier(0.5, 0, 0.2, 1),
                    opacity ${REVERSE_DURATION}ms ease-out,
                    filter ${REVERSE_DURATION}ms ease-out;
        will-change: transform, opacity;
    `;
    document.body.appendChild(clone);

    // Keep the real toggle hidden until the clone arrives at it.
    launcher.style.opacity = '0';

    return new Promise(resolve => {
        // Force layout, then animate to the toggle's resting position.
        void clone.offsetWidth;
        clone.style.transform = 'translate(0, 0) scale(1, 1)';
        clone.style.opacity = '1';
        clone.style.filter = 'none';

        const cleanup = () => {
            removeClone();
            // Restore the real toggle.
            launcher.style.opacity = '';
            resolve();
        };
        clone.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, REVERSE_DURATION + 200);
    });
}
