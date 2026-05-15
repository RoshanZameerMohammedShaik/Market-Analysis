// Prewarm the WebLLM model the moment the page initializes, so first
// chat-open is instant if the user already configured webllm.
//
// Bails silently if:
//   - the user picked groq/cloudflare
//   - hardware check fails (mobile, no WebGPU, low RAM)
//   - we're already prewarming or done
//
// Trade-off: this eagerly consumes ~4-8 GB of RAM. Acceptable because
// the user explicitly chose webllm — if they wanted lazy, they'd be on
// the API-key path.
//
// Exposes getReadyState() so the launcher can show a 'warming' vs 'ready'
// indicator.

import { loadSettings } from './settings.js';
import { loadModel, isAvailableForTier, getActiveTier } from './backends/webllm.js';
import { normalizeWebllmProgress } from './llm-client.js';

let started = false;
let readyState = 'idle'; // 'idle' | 'warming' | 'ready' | 'unavailable'
let readyPercent = 0;
const listeners = new Set();

export function getReadyState() { return { state: readyState, percent: readyPercent }; }
export function onReadyChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function setReady(state, percent = readyPercent) {
    readyState = state;
    readyPercent = percent;
    for (const fn of listeners) { try { fn({ state, percent }); } catch (_) {} }
}

export function startPrewarm() {
    if (started) return;
    started = true;
    // Run on next microtask so we don't block the initial paint, but no
    // 2s setTimeout. The library import + WebGPU init are async anyway.
    Promise.resolve().then(() => prewarmIfPossible());
}

async function prewarmIfPossible() {
    try {
        const s = loadSettings();
        if (s.backend !== 'webllm') return;
        const tier = s.thinkingMode ? 'thinking' : 'default';
        if (getActiveTier() === tier) {
            setReady('ready', 100);
            return;
        }
        const avail = isAvailableForTier(tier);
        if (!avail.ok) {
            setReady('unavailable');
            return;
        }
        setReady('warming', 0);
        await loadModel(tier, raw => {
            const norm = normalizeWebllmProgress(raw);
            setReady('warming', norm.percent);
        });
        setReady('ready', 100);
    } catch (_) {
        // Don't block the user; they can still try via the chat path.
        setReady('unavailable');
    }
}
