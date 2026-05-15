import { state } from './state.js';

const themes = ['dark', 'light', 'terminal'];
const themeIcons = { dark: '🌙', light: '☀️', terminal: '🖥️' };

export function initTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    updateThemeButton();
}

export function cycleTheme(onChange) {
    const idx = themes.indexOf(state.theme);
    state.theme = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('ma-theme', state.theme);
    updateThemeButton();
    if (onChange) onChange(state.theme);
}

function updateThemeButton() {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = themeIcons[state.theme] || '🌙';
}
