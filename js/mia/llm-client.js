// Unified Mia client — dispatches to the chosen backend.
// Each backend exposes stream(opts) returning an async iterable of
// text deltas. AbortSignal supported throughout.

import { loadSettings } from './settings.js';
import * as webllm from './backends/webllm.js';
import * as groq from './backends/api-groq.js';
import * as cf from './backends/api-cf.js';

export async function* stream({ system, messages, signal, onProgress }) {
    const s = loadSettings();
    if (!s.backend) throw new Error('Mia is not configured yet. Pick a backend in the welcome screen.');

    if (s.backend === 'webllm') {
        const tier = s.thinkingMode ? 'thinking' : 'default';
        if (webllm.getActiveTier() !== tier) {
            if (onProgress) onProgress('loading model…');
            await webllm.loadModel(tier, p => onProgress?.(p.text || `${Math.round(p.progress * 100)}%`));
        }
        if (onProgress) onProgress('thinking…');
        for await (const delta of webllm.stream({ system, messages, signal })) yield delta;
        return;
    }

    if (s.backend === 'groq') {
        if (!s.groqKey) throw new Error('No Groq API key on file. Open settings and add one.');
        if (onProgress) onProgress('thinking…');
        for await (const delta of groq.stream({ system, messages, key: s.groqKey, signal })) yield delta;
        return;
    }

    if (s.backend === 'cloudflare') {
        if (!s.cfKey || !s.cfAccountId) throw new Error('No Cloudflare credentials on file.');
        if (onProgress) onProgress('thinking…');
        for await (const delta of cf.stream({ system, messages, key: s.cfKey, accountId: s.cfAccountId, signal })) yield delta;
        return;
    }

    throw new Error(`Unknown backend: ${s.backend}`);
}

export async function pingBackend() {
    const s = loadSettings();
    if (s.backend === 'groq') return groq.ping(s.groqKey);
    if (s.backend === 'cloudflare') return cf.ping(s.cfKey, s.cfAccountId);
    if (s.backend === 'webllm') {
        const avail = webllm.isAvailableForTier(s.thinkingMode ? 'thinking' : 'default');
        return avail.ok ? { ok: true, msg: 'WebLLM hardware check passed.' } : { ok: false, msg: avail.reason };
    }
    return { ok: false, msg: 'Not configured.' };
}

export function getUsage() {
    const s = loadSettings();
    if (s.backend === 'groq') return groq.getLastUsage();
    if (s.backend === 'cloudflare') return cf.getLastUsage();
    return null;
}

export { webllm };
