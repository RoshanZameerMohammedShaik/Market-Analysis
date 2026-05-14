// WebLLM backend — runs Qwen 2.5 7B (default) or 14B (Thinking) entirely
// in the user's browser via WebGPU. No network call per reply.
//
// First use downloads the model to IndexedDB (~4.3 GB / 8 GB), then
// streams from local GPU. Subsequent visits reuse the cache.
//
// Hardware floor: WebGPU + ~8 GB RAM (default) / 16 GB (Thinking).
// Mobile is excluded — even where mobile WebGPU works, the download
// and VRAM ceilings make it impractical.

let engine = null;
let activeModelId = null;
let loading = false;

const MODELS = {
    'default': { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', sizeGB: 4.3, ramGB: 8 },
    'thinking': { id: 'Qwen2.5-14B-Instruct-q4f16_1-MLC', sizeGB: 8.0, ramGB: 14 },
};

export function isWebGPUSupported() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export function isMobile() {
    if (typeof navigator === 'undefined') return false;
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

export async function estimateRAM() {
    // navigator.deviceMemory is a coarse hint, capped at 8 GB by spec.
    // Use it as a lower bound only.
    const hint = navigator.deviceMemory;
    return hint ? `${hint}+ GB` : 'unknown';
}

export function isAvailableForTier(tier) {
    if (!isWebGPUSupported()) return { ok: false, reason: 'WebGPU not supported in this browser. Try Chrome, Edge, or Brave.' };
    if (isMobile()) return { ok: false, reason: 'WebLLM is desktop-only. Use the API key option for mobile.' };
    const m = MODELS[tier];
    if (!m) return { ok: false, reason: 'Unknown tier' };
    const dm = navigator.deviceMemory;
    if (dm && dm < m.ramGB) return { ok: false, reason: `Need ~${m.ramGB} GB RAM; this device reports ${dm} GB.` };
    return { ok: true };
}

export async function loadModel(tier, onProgress) {
    const desired = MODELS[tier]?.id;
    if (!desired) throw new Error(`Unknown tier: ${tier}`);
    if (engine && activeModelId === desired) return;
    if (loading) throw new Error('Already loading. Please wait.');
    loading = true;
    try {
        // Lazy-import the library so users who never enable WebLLM never
        // pay the bundle cost.
        const { CreateMLCEngine } = await import('https://esm.run/@mlc-ai/web-llm');
        if (engine) {
            try { await engine.unload(); } catch (_) {}
            engine = null;
        }
        engine = await CreateMLCEngine(desired, {
            initProgressCallback: (p) => {
                if (onProgress) onProgress({
                    progress: p.progress,
                    text: p.text,
                });
            },
        });
        activeModelId = desired;
    } finally {
        loading = false;
    }
    // Ask the browser to keep our IndexedDB cache around aggressively.
    try {
        if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (_) { /* */ }
}

export async function* stream({ system, messages, signal }) {
    if (!engine) throw new Error('WebLLM model not loaded yet.');
    const chunks = await engine.chat.completions.create({
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: 0.3,
        max_tokens: 600,
        stream: true,
    });
    for await (const chunk of chunks) {
        if (signal?.aborted) {
            try { engine.interruptGenerate(); } catch (_) {}
            return;
        }
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) yield delta;
    }
}

export function getActiveTier() {
    if (!activeModelId) return null;
    for (const [tier, m] of Object.entries(MODELS)) if (m.id === activeModelId) return tier;
    return null;
}

export function getModelInfo(tier) { return MODELS[tier]; }

export async function clearCache() {
    // Clear IndexedDB databases used by web-llm.
    try {
        if (engine) { try { await engine.unload(); } catch (_) {} engine = null; activeModelId = null; }
        const dbs = await (indexedDB.databases?.() || Promise.resolve([]));
        for (const d of dbs) {
            if (/web[-_]?llm|mlc/i.test(d.name || '')) {
                indexedDB.deleteDatabase(d.name);
            }
        }
    } catch (_) { /* */ }
}
