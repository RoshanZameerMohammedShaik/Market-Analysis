// Toggle visibility of the P&L sidebar. Persists state in localStorage.
// Listens for header button clicks, the keyboard shortcut, and outside
// clicks (mobile sheet pattern).

const KEY = 'ma-pl-open';

export function initPLToggle() {
    const btn = document.getElementById('pl-toggle');
    const sidebar = document.getElementById('pl-sidebar');
    if (!btn || !sidebar) return;

    // Restore state
    const saved = (() => { try { return localStorage.getItem(KEY); } catch (_) { return null; } })();
    const initial = saved == null ? false : saved === '1';
    setOpen(initial);

    btn.addEventListener('click', () => {
        setOpen(!isOpen());
    });

    // Click outside to close on small screens.
    document.addEventListener('click', (e) => {
        if (!isOpen()) return;
        if (window.innerWidth >= 1024) return; // desktop floating panel — require explicit close
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#pl-sidebar') || target.closest('#pl-toggle')) return;
        setOpen(false);
    });

    // Esc to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) setOpen(false);
    });
}

export function togglePLPanel() {
    setOpen(!isOpen());
}

function isOpen() {
    return document.body.classList.contains('pl-open');
}

function setOpen(open) {
    document.body.classList.toggle('pl-open', !!open);
    const btn = document.getElementById('pl-toggle');
    if (btn) {
        btn.classList.toggle('active', !!open);
        btn.setAttribute('aria-expanded', String(!!open));
        btn.title = open ? 'Hide P&L Calculator (P)' : 'Show P&L Calculator (P)';
    }
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (_) { /* */ }
}
