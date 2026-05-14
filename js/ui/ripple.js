// Material-style click ripple on primary actions.
// Listens once at document level; matches a CSS allow-list.

const SEL = '.tab-btn, .refresh-btn, .pl-btn, .pl-use-current, .mia-card-btn, .mia-save-btn, .mia-test-btn, .mia-clear-btn, .mia-icon-btn, .mia-suggest, .hot-pick-card';

export function initRipple() {
    document.addEventListener('pointerdown', e => {
        const target = e.target instanceof Element ? e.target.closest(SEL) : null;
        if (!target) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const rect = target.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const dot = document.createElement('span');
        dot.className = 'ripple';
        dot.style.width = size + 'px';
        dot.style.height = size + 'px';
        dot.style.left = (e.clientX - rect.left - size / 2) + 'px';
        dot.style.top  = (e.clientY - rect.top  - size / 2) + 'px';
        target.appendChild(dot);
        setTimeout(() => dot.remove(), 700);
    }, { passive: true });
}
