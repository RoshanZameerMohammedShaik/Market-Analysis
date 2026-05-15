import { state } from './state.js';

const themes = ['dark', 'light', 'slate'];
const nextTheme = (cur) => themes[(themes.indexOf(cur) + 1) % themes.length];

// Icons shown on the toggle represent the NEXT theme (what clicking does),
// not the current. Clearer UX than showing what you're already on.
const nextIconSvg = {
    light: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    slate: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h18M3 12h18M3 17h12"/><circle cx="19" cy="17" r="2" fill="currentColor"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
};
const friendly = { dark: 'Dark', light: 'Light', slate: 'Slate' };

export function initTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}

export function cycleTheme(onChange) {
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
    btn.innerHTML = nextIconSvg[next] || nextIconSvg.dark;
    btn.title = `Theme: ${friendly[state.theme]} → click for ${friendly[next]}`;
    btn.setAttribute('aria-label', `Switch theme. Current: ${friendly[state.theme]}. Click for ${friendly[next]}.`);
}
