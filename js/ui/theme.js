import { state } from './state.js';
import { THEMES, themeMeta } from './themes.js';

// Six themes cannot be driven by a cycle button. Reaching the sixth meant five
// full-page repaints, and nothing told you what was coming next, so the control
// was a lottery. The settings menu now holds a swatch grid where every theme is
// visible and one click away.
//
// cycleTheme() is still exported and still cycles: core.js binds it to the
// #theme-toggle row, and keeping that contract means this rewrite touches no
// call site. It now walks the shared registry instead of a private array.

const ids = () => THEMES.map((t) => t.id);
const nextTheme = (cur) => {
    const list = ids();
    return list[(list.indexOf(cur) + 1) % list.length];
};

export function initTheme() {
    applyTheme(state.theme, { persist: false, animate: false });
    buildThemePicker();
    updateThemeButton();
}

// Guards the temporary cross-fade class so rapid clicks don't stack timers.
let _themeFadeTimer = null;

/**
 * Apply a theme to the document.
 * @param {string} id            theme id from the registry
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true]  write to localStorage
 * @param {boolean} [opts.animate=true]  run the cross-fade
 */
export function applyTheme(id, { persist = true, animate = true } = {}) {
    // Cross-fade only for the swap window: components.css transitions colour
    // props while <html> carries .theme-transition. Transitioning globally at
    // rest would repaint on every hover, and doing it on FIRST paint would show
    // the default theme fading into the saved one.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate && !reduceMotion) {
        const root = document.documentElement;
        root.classList.add('theme-transition');
        if (_themeFadeTimer) clearTimeout(_themeFadeTimer);
        _themeFadeTimer = setTimeout(() => {
            root.classList.remove('theme-transition');
            _themeFadeTimer = null;
        }, 300);   // --dur-base (240ms) plus slack
    }

    state.theme = id;
    document.documentElement.setAttribute('data-theme', id);
    if (persist) {
        try { localStorage.setItem('ma-theme', id); } catch (_) {}
    }
    syncMetaThemeColor(id);
    updateThemeButton();
    markActiveSwatch();
}

export function cycleTheme(onChange) {
    applyTheme(nextTheme(state.theme));
    if (onChange) onChange(state.theme);
}

/** Keep the browser/OS chrome in step with the page.
 *  On Android and in an installed PWA this colours the status bar, so leaving it
 *  pinned to the old black meant a light theme showed a black notch strip. Read
 *  from the live computed value so it can never drift from the CSS. */
function syncMetaThemeColor(id) {
    const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary').trim() || themeMeta(id).swatch[0];
    // The document ships two media-scoped theme-color tags for the pre-boot
    // paint. Those cannot follow an in-app choice, so they are replaced by a
    // single unscoped tag that we own from here on.
    document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => {
        if (i === 0) { m.removeAttribute('media'); m.setAttribute('content', bg); }
        else m.remove();
    });
}

function updateThemeButton() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const cur = themeMeta(state.theme);
    btn.title = `Theme: ${cur.name}`;
    btn.setAttribute('aria-label', `Theme. Current: ${cur.name}.`);
    const meta = btn.querySelector('#theme-toggle-meta');
    if (meta) meta.textContent = cur.name;
}

/** Build the swatch grid once, appended inside the settings menu. */
function buildThemePicker() {
    const menu = document.getElementById('header-settings-menu');
    if (!menu || menu.querySelector('.theme-picker')) return;

    const sep = document.createElement('hr');
    sep.className = 'header-menu-sep';

    const title = document.createElement('div');
    title.className = 'theme-picker-title';
    title.textContent = 'Theme';

    const grid = document.createElement('div');
    grid.className = 'theme-picker';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Colour theme');

    for (const t of THEMES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-swatch';
        b.dataset.themeId = t.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(t.id === state.theme));
        b.setAttribute('aria-label', t.name);
        b.title = t.name;
        // Inline custom properties so each swatch previews its own palette
        // rather than the currently active one.
        b.style.setProperty('--sw-bg', t.swatch[0]);
        b.style.setProperty('--sw-surface', t.swatch[1]);
        b.style.setProperty('--sw-accent', t.swatch[2]);
        b.innerHTML =
            '<span class="theme-swatch-preview" aria-hidden="true"><i></i><i></i><i></i></span>'
            + `<span class="theme-swatch-name">${t.name}</span>`;
        b.addEventListener('click', (e) => {
            e.stopPropagation();   // don't let the menu's outside-click handler close it
            applyTheme(t.id);
            if (_onThemeChange) _onThemeChange(t.id);
        });
        grid.appendChild(b);
    }

    // Keyboard support for the radiogroup: arrows move between swatches, which
    // is what a screen-reader user is told to expect from role="radiogroup".
    grid.addEventListener('keydown', (e) => {
        const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        const list = ids();
        const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
        const next = list[(list.indexOf(state.theme) + dir + list.length) % list.length];
        applyTheme(next);
        if (_onThemeChange) _onThemeChange(next);
        grid.querySelector(`[data-theme-id="${next}"]`)?.focus();
    });

    menu.append(sep, title, grid);
}

function markActiveSwatch() {
    document.querySelectorAll('.theme-swatch').forEach((el) => {
        el.setAttribute('aria-checked', String(el.dataset.themeId === state.theme));
    });
}

// The chart widget has to be rebuilt on a theme change because TradingView bakes
// its colours in at construction. core.js owns that, so it registers a callback
// here rather than this module reaching into the chart.
let _onThemeChange = null;
export function onThemeChange(fn) { _onThemeChange = fn; }
