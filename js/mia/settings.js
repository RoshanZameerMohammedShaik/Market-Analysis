// User settings: API keys for Gemini (primary) and/or Cloudflare (fallback).
// Groq has been retired — its 6,000 TPM cap on Llama 3.3 70B kept tripping
// mid-stream rate-limits even on routine deep-dives. Gemini 2.5 Flash-Lite
// gives 250K TPM (42× the headroom) for free.
//
// Both keys can be configured at once; runtime auto-falls back from
// Gemini → Cloudflare on 429/5xx.

const KEY = 'ma-mia-settings-v4';
const LEGACY_KEYS = ['ma-mia-settings-v3', 'ma-mia-settings-v2', 'ma-mia-settings-v1'];

const DEFAULT = {
    backend: '',           // '' (unconfigured) | 'gemini' | 'cloudflare'
    fallbackEnabled: true, // when both keys present, auto-fallback on 429/5xx
    geminiKey: '',
    cfKey: '',
    cfAccountId: '',
    thinkingMode: false,
    // Voice mode: Gemini Live API (native neural voice) is the primary
    // voice path. Web Speech is the auto-fallback if Live fails (no
    // mic permission, model unavailable, reconnect cap exceeded). Live
    // has unlimited RPD/RPM on free tier so there's no quota reason
    // to default-off — Roshan flipped this to true once we confirmed
    // the dashboard limits. Setting still exists in storage so a future
    // power-user "force browser TTS" toggle has somewhere to land.
    voiceLive: true,
    // Voice-mode sound design (thinking shimmer, tool ticks, listening
    // cues). Synthesized in-browser by js/mia/sound.js. Default ON;
    // muted via the toggle in Mia's settings. Suppressed automatically
    // while Mia's voice is actively speaking.
    soundEnabled: true,
    // General UI sound layer (js/ui/ui-sound.js): soft synthesized cues on
    // hover/click/tab-switch/panel-open/success/error across the whole app.
    // Separate toggle from Mia's voice-mode sounds so a user can keep tactile
    // UI feedback while muting Mia (or vice-versa). Default ON; shares Mia's
    // "never play while she's speaking" gate. Synthesized in-browser — no
    // sample files (dynamic-only rule).
    uiSoundEnabled: true,
};

function migrateLegacy() {
    for (const lk of LEGACY_KEYS) {
        try {
            const raw = localStorage.getItem(lk);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const next = {
                // Drop the deprecated 'groq' and 'webllm' backends. If the user
                // had only Groq configured, they need to re-enter a Gemini key.
                backend: (parsed.backend === 'gemini' || parsed.backend === 'cloudflare') ? parsed.backend : '',
                fallbackEnabled: true,
                geminiKey: parsed.geminiKey || '',
                cfKey: parsed.cfKey || '',
                cfAccountId: parsed.cfAccountId || '',
                thinkingMode: !!parsed.thinkingMode,
            };
            if (next.backend === '' && next.geminiKey) next.backend = 'gemini';
            else if (next.backend === '' && next.cfKey && next.cfAccountId) next.backend = 'cloudflare';
            localStorage.setItem(KEY, JSON.stringify(next));
            localStorage.removeItem(lk);
            return next;
        } catch (_) { /* */ }
    }
    return null;
}

let migrated = false;

// One-time bump applied to existing settings stores. Each numbered step
// runs at most once per browser; the highest-applied number is recorded
// so we don't replay them. Used to retroactively change defaults after
// the schema is already widely-deployed.
const CURRENT_MIGRATION_STEP = 1;
function applyOneTimeMigrations(parsed) {
    const applied = Number(parsed._migrationStep || 0);
    let changed = false;
    // Step 1: flip voiceLive default true. Earlier ship had it false;
    // once we confirmed Live API has unlimited free quota we made it
    // primary. Existing users whose stored value is false-by-default
    // (not because they explicitly disabled it) get the upgrade.
    if (applied < 1) {
        if (parsed.voiceLive === false) parsed.voiceLive = true;
        changed = true;
    }
    if (changed) {
        parsed._migrationStep = CURRENT_MIGRATION_STEP;
        try { localStorage.setItem(KEY, JSON.stringify(parsed)); } catch (_) {}
    }
    return parsed;
}

export function loadSettings() {
    if (!migrated) { try { migrateLegacy(); } catch (_) {} migrated = true; }
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULT };
        let parsed = JSON.parse(raw);
        // Defensive: never let deprecated backends leak through.
        if (parsed.backend === 'webllm' || parsed.backend === 'groq') {
            parsed.backend = parsed.geminiKey ? 'gemini' : (parsed.cfKey ? 'cloudflare' : '');
        }
        parsed = applyOneTimeMigrations(parsed);
        return { ...DEFAULT, ...parsed };
    } catch (_) {
        return { ...DEFAULT };
    }
}

export function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    if (next.backend === 'webllm' || next.backend === 'groq') next.backend = '';
    // Strip any orphan groqKey carried over from older versions.
    delete next.groqKey;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
    return next;
}

export function clearSettings() {
    try {
        localStorage.removeItem(KEY);
        for (const lk of LEGACY_KEYS) localStorage.removeItem(lk);
    } catch (_) {}
}

export function isConfigured() {
    const s = loadSettings();
    if (s.backend === 'gemini') return !!s.geminiKey;
    if (s.backend === 'cloudflare') return !!s.cfKey && !!s.cfAccountId;
    return false;
}

export function hasFallbackKey() {
    const s = loadSettings();
    if (s.backend === 'gemini') return !!s.cfKey && !!s.cfAccountId;
    if (s.backend === 'cloudflare') return !!s.geminiKey;
    return false;
}
