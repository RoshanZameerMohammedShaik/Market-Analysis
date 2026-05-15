// Prewarm the WebLLM model in the background as soon as the page loads,
// IF the user already configured webllm. This avoids the 25s cache-load
// delay the first time they actually open Mia after a fresh page load.
//
// Bails silently if:
//   - the user picked groq/cloudflare (no model to load)
//   - hardware check fails (mobile, no WebGPU, low RAM)
//   - we're already prewarming or done
//
// Trade-off: this eagerly consumes ~4-8 GB of RAM. Acceptable because
// the user explicitly chose webllm — if they wanted lazy, they'd be
// on the API-key path.

import { loadSettings } from './settings.js';
import { loadModel, isAvailableForTier, getActiveTier } from './backends/webllm.js';

let started = false;

export function startPrewarm() {
    if (started) return;
    started = true;
    // Defer briefly so the page paints first; then run on a low-priority idle slot.
    setTimeout(() => {
        const run = () => prewarmIfPossible();
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(run, { timeout: 3000 });
        } else {
            run();
        }
    }, 2000);
}

async function prewarmIfPossible() {
    try {
        const s = loadSettings();
        if (s.backend !== 'webllm') return;
        const tier = s.thinkingMode ? 'thinking' : 'default';
        if (getActiveTier() === tier) return; // already loaded somehow
        const avail = isAvailableForTier(tier);
        if (!avail.ok) return;
        // Silent progress — no user-visible UI. The chat panel will pick
        // up the loaded engine when opened.
        await loadModel(tier, () => { /* swallow progress; not user-facing */ });
    } catch (_) {
        // Swallow — user can still open Mia and load on demand.
    }
}
