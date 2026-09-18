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

// Milliseconds until the free tier's DAILY counters roll over.
//
// AI Studio free-tier RPD resets at midnight Pacific, not UTC and not on a rolling 24h window from
// first use. Computed through Intl rather than a fixed offset so it stays correct across the DST
// transition -- America/Los_Angeles is UTC-8 in winter and UTC-7 in summer, and hardcoding either
// would be wrong for half the year.
function msUntilDailyReset(now = new Date()) {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const p = {};
        for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
        const h = p.hour === '24' ? 0 : Number(p.hour);
        const elapsed = (h * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
        const remaining = 86400_000 - elapsed;
        // A tiny buffer past midnight: asking at the exact boundary tends to return one more 429.
        return Math.max(60_000, remaining + 60_000);
    } catch (_) {
        // No Intl timezone support: fall back to a conservative hour rather than parking for a day.
        return 60 * 60 * 1000;
    }
}

// Record that `model` is now cooling.
//
// `scope` distinguishes the two completely different things a 429 can mean, which this used to
// conflate:
//
//   'minute' (default) -- RPM hit. Clears in seconds. Retrying soon is correct.
//   'day'              -- RPD exhausted. Will not clear until midnight Pacific. Retrying is
//                         guaranteed to fail and costs a round-trip every time.
//
// Every 429 used to be capped at MAX_HINT_MS (30 minutes), so a model whose DAILY quota was spent
// got retried every half hour until midnight. With the 2026-09-18 dashboard showing six
// reasoning-tier models at or over their 20 RPD ceiling, that was six wasted round-trips before
// every single answer, all day, for the rest of the day. Now a daily 429 parks the model until the
// counters actually roll over and the chain walks straight past it to the 500-RPD Lites.
export function markCooling(model, retryAfterSec, scope = 'minute') {
    let cooldownMs;
    if (scope === 'day') {
        // Honour a server hint only if it is LONGER than our computed reset -- Google sometimes
        // returns a short retryDelay alongside a daily violation, and trusting it reintroduces the
        // retry storm this exists to stop.
        const hinted = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
        cooldownMs = Math.max(msUntilDailyReset(), hinted);
    } else {
        cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, MAX_HINT_MS)
            : DEFAULT_COOLDOWN_MS;
    }
    const resetAt = Date.now() + cooldownMs;
    const map = readMap();
    map[model] = { resetAt, scope };
    writeMap(map);
    document.dispatchEvent(new CustomEvent('ma:gemini-tier-cooldown-changed'));
    return resetAt;
}

// Exported for the quota panel and for tests: is this model down for the day, or just a minute?
export function coolingScope(model) {
    return readMap()[model]?.scope || null;
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
