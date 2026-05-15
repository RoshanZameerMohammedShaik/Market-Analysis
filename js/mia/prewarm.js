// Prewarm is now a no-op. We left it as a thin module so existing
// imports keep working without churn. API-backed Mia has no warmup.

let readyState = 'idle';
const listeners = new Set();

export function getReadyState() { return { state: 'ready', percent: 100 }; }
export function onReadyChange(fn) { listeners.add(fn); fn({ state: 'ready', percent: 100 }); return () => listeners.delete(fn); }
export function startPrewarm() {
    readyState = 'ready';
    for (const fn of listeners) { try { fn({ state: 'ready', percent: 100 }); } catch (_) {} }
}
