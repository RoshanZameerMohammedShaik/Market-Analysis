// Per-model cooldown tracker for Gemini tiers.
//
// When a Gemini call hits 429 (quota exhausted), we record the model that
// failed + when it'll be available again. Future calls check this map and
// either skip a still-cooling tier (auto-fallback to the other tier) or
// know the cooldown is over and try fresh.
//
// State persists in localStorage so a page reload doesn't lose what we
// learned mid-session — particularly important for daily-cap exhaustion
// where the reset window is hours away.
//
// Design intent: KEEP SIMPLE. We don't try to predict quota exhaustion
// from local counters (multi-tab + key-shared concerns make that
// unreliable). We only react to actual 429s. Best of both worlds:
// proactive skip ("we know Flash-Lite is cooling, jump to Flash") +
// reactive learning ("we just learned Flash hit its cap, mark it").

const LS_KEY = 'mia-gemini-tier-cooldown';

// Per-tier defaults in ms when Gemini doesn't tell us how long to wait.
// 429 with no retry-After hint usually means RPM hit; 60s is generous.
// Daily caps reset on a 24h rolling window — treating a generic 429 as
// 60s and waiting for the actual retry-After hint when present is the
// right balance.
const DEFAULT_COOLDOWN_MS = 60 * 1000;
// Max cooldown we'll honor from a server hint — protects against weird
// retry-Afters like "86400s" parking us for a day.
const MAX_HINT_MS = 30 * 60 * 1000; // 30 minutes

function readMap() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
}

function writeMap(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (_) {}
}

// Record that `model` is now cooling. retryAfterSec is the server's hint
// (in seconds) when present; otherwise we use the default. Returns the
// computed reset timestamp so callers can log / display it.
export function markCooling(model, retryAfterSec) {
    const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, MAX_HINT_MS)
        : DEFAULT_COOLDOWN_MS;
    const resetAt = Date.now() + cooldownMs;
    const map = readMap();
    map[model] = { resetAt };
    writeMap(map);
    document.dispatchEvent(new CustomEvent('ma:gemini-tier-cooldown-changed'));
    return resetAt;
}

// Returns the ms remaining until `model` is healthy again, or 0 if it's
// not currently cooling. Auto-cleans expired entries when read.
export function msUntilHealthy(model) {
    const map = readMap();
    const entry = map[model];
    if (!entry) return 0;
    const remaining = entry.resetAt - Date.now();
    if (remaining <= 0) {
        delete map[model];
        writeMap(map);
        return 0;
    }
    return remaining;
}

export function isCooling(model) {
    return msUntilHealthy(model) > 0;
}

// Snapshot for UI rendering. Returns { [model]: msRemaining } for every
// model that's currently cooling.
export function getCooldownState() {
    const map = readMap();
    const now = Date.now();
    const out = {};
    let dirty = false;
    for (const [model, entry] of Object.entries(map)) {
        const remaining = entry.resetAt - now;
        if (remaining <= 0) { delete map[model]; dirty = true; continue; }
        out[model] = remaining;
    }
    if (dirty) writeMap(map);
    return out;
}

// Manual clear — useful for the "I just rotated my key" UX or for tests.
export function clearCooldown(model) {
    const map = readMap();
    if (model) {
        delete map[model];
    } else {
        // null/undefined → clear all
        for (const k of Object.keys(map)) delete map[k];
    }
    writeMap(map);
    document.dispatchEvent(new CustomEvent('ma:gemini-tier-cooldown-changed'));
}

// Console-callable rescue handle. If the user is locked out by stale
// cooldown state and can't see a badge to click ×, they can run:
//     window.__miaResetCooldowns()
// from F12 → Console. Returns the cleared model list so it's obvious
// what got reset. Available globally because it's an emergency tool;
// you don't want to dig through module imports during a brownout.
if (typeof window !== 'undefined') {
    window.__miaResetCooldowns = () => {
        const map = readMap();
        const cleared = Object.keys(map);
        for (const k of cleared) delete map[k];
        writeMap(map);
        document.dispatchEvent(new CustomEvent('ma:gemini-tier-cooldown-changed'));
        console.log('[mia] Reset cooldown map. Cleared:', cleared.length ? cleared : '(nothing was cooling)');
        return cleared;
    };
}
