// Phase 8.8: prose path now uses the slim system prompt (buildSlimSystemPrompt)
// instead of the full BASE prompt + extra anti-fabrication scaffolding. The
// slim prompt already encodes the no-tool / no-fabrication rules, so per-call
// cost drops from ~1,400 → ~250 prompt tokens.

import * as groq from './backends/api-groq.js';
import { classifyIntent } from './intent-classifier.js';
import { buildSlimSystemPrompt, buildContextBlock } from './prompt.js';
import { loadSettings } from './settings.js';

let lastDecision = null;

export function getLastDecision() { return lastDecision; }

/**
 * Stream Mia output with intent-classified routing.
 *
 * @param opts.system        — full tool-path system prompt
 * @param opts.systemNoTools — (legacy, ignored — slim is built locally)
 * @param opts.latestSignal  — current on-screen signal for context-block
 *                              (optional; if not passed, prose still works,
 *                               just without grounding)
 */
export async function* routedStream({ system, systemNoTools, messages, key, signal, onProgress, latestSignal }) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const intent = await classifyIntent({
        userMessage: lastUser?.content || '',
        key,
        signal,
    });

    if (intent === 'prose') {
        lastDecision = { intent: 'prose', model: 'llama-3.1-8b-instant', ts: Date.now() };
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
        // Slim prompt + context block (so Mia still knows which symbol is loaded
        // for prose questions like "what does the current signal mean?")
        const proseSystem = buildSlimSystemPrompt() + '\n\n' + buildContextBlock(latestSignal);
        for await (const delta of groq.stream({
            system: proseSystem,
            messages,
            key,
            signal,
            tier: 'default',
        })) yield delta;
        return;
    }

    // Tool path: full tool-prompt system, 70B model.
    lastDecision = { intent: 'tool', model: 'llama-3.3-70b-versatile', ts: Date.now() };
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
    for await (const delta of groq.stream({
        system,
        messages,
        key,
        signal,
        tier: 'thinking',
    })) yield delta;
}
