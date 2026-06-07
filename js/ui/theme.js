import { state } from './state.js';

const themes = ['dark', 'light', 'aurora'];
const nextTheme = (cur) => themes[(themes.indexOf(cur) + 1) % themes.length];

// Icons shown on the toggle represent the NEXT theme (what clicking does),
// not the current. Clearer UX than showing what you're already on.
const nextIconSvg = {
    light: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    aurora: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18 Q7 8 12 14 T21 8"/><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="19" cy="15" r="1" fill="currentColor"/><circle cx="5" cy="10" r="1" fill="currentColor"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
};
const friendly = { dark: 'Dark', light: 'Light', aurora: 'Aurora' };

export function initTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}

// Guards the temporary cross-fade class so rapid clicks don't stack timers.
let _themeFadeTimer = null;

export function cycleTheme(onChange) {
    // Smooth cross-fade: premium.css transitions colour props for as long as
    // <html> carries .theme-transition. We add it just for the switch window
    // so there's no first-paint jank and no perf cost at rest. Skipped for
    // users who prefer reduced motion.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
        const root = document.documentElement;
        root.classList.add('theme-transition');
        if (_themeFadeTimer) clearTimeout(_themeFadeTimer);
        _themeFadeTimer = setTimeout(() => {
            root.classList.remove('theme-transition');
            _themeFadeTimer = null;
        }, 220);   // ~ --dur-fast (0.16s) + slack; short so the swap feels snappy
    }

    state.theme = nextTheme(state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('ma-theme', state.theme);
    updateThemeButton();
    if (onChange) onChange(state.theme);
}

function updateThemeButton() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const next = nextTheme(state.theme);
    btn.title = `Theme: ${friendly[state.theme]} → click for ${friendly[next]}`;
    btn.setAttribute('aria-label', `Switch theme. Current: ${friendly[state.theme]}. Click for ${friendly[next]}.`);
    // Update meta text to show current theme. Keeps the menu-item
    // markup (icon + label + meta) intact instead of overwriting it.
    const meta = btn.querySelector('#theme-toggle-meta');
    if (meta) meta.textContent = `${friendly[state.theme]} → ${friendly[next]}`;
}
