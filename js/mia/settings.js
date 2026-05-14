// Settings module retained as a no-op shim so any cached imports don't
// 404. Mia no longer reads or writes settings of any kind.
//
// Also clears any legacy settings the user may have stored from earlier
// versions — best-effort, fails silently if storage is disabled.
(function migrateAway() {
    try { localStorage.removeItem('ma-mia-settings'); } catch (_) { /* */ }
})();

export function loadSettings() { return {}; }
export function saveSettings() { /* */ }
