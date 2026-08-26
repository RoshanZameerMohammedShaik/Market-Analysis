// Theme registry — the SINGLE source of truth for which themes exist.
//
// state.js needs it to validate a saved preference, theme.js needs it to build
// the picker, and neither can own it: state.js is imported BY theme.js, so a
// registry living in theme.js would be a circular import. This module imports
// nothing, so both can read it safely.
//
// It previously lived as a hardcoded list in each file, and they disagreed:
// theme.js cycled ['dark','light','aurora'] while state.loadTheme() separately
// re-listed the same three in an if-chain. Adding a theme meant editing both, and
// missing one silently reset the user's choice to dark on every load.
//
// `swatch` is [page, surface, accent] and must mirror the theme's real
// --bg-primary / --bg-card / --accent in css/design-system.css. The picker paints
// these directly so each option previews its OWN palette rather than the active
// one; a swatch that lies is worse than no swatch.

export const THEMES = [
    { id: 'dark',     name: 'Obsidian',  swatch: ['#000000', '#101318', '#4c8dff'] },
    { id: 'midnight', name: 'Midnight',  swatch: ['#060911', '#111725', '#818cf8'] },
    { id: 'aurora',   name: 'Aurora',    swatch: ['#06050d', '#12101f', '#a78bfa'] },
    { id: 'forest',   name: 'Forest',    swatch: ['#050a08', '#0e1713', '#34d399'] },
    { id: 'ember',    name: 'Ember',     swatch: ['#0b0908', '#191412', '#f5a524'] },
    { id: 'light',    name: 'Daylight',  swatch: ['#f4f5f7', '#ffffff', '#2563eb'] },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME = 'dark';

/** Retired theme ids mapped to their closest surviving equivalent, so a
 *  returning user is moved somewhere deliberate instead of being reset to the
 *  default. Keep entries here forever: a preference in localStorage outlives any
 *  number of redesigns. */
export const THEME_ALIASES = {
    colourful: 'aurora',
    terminal: 'forest',
    slate: 'midnight',
};

/** Resolve any stored value to a valid theme id. */
export function normalizeTheme(saved) {
    if (!saved) return DEFAULT_THEME;
    if (THEME_IDS.includes(saved)) return saved;
    return THEME_ALIASES[saved] || DEFAULT_THEME;
}

export function themeMeta(id) {
    return THEMES.find((t) => t.id === id) || THEMES[0];
}
