// Tiny number-counter animation. Used to tween confidence on signal change.

export function animateNumber(el, from, to, duration = 600, suffix = '%') {
    if (!el) return;
    if (Number.isNaN(from) || from === to) {
        el.textContent = `${to}${suffix}`;
        return;
    }
    const start = performance.now();
    function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - t, 3);
        const current = Math.round(from + (to - from) * eased);
        el.textContent = `${current}${suffix}`;
        if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
