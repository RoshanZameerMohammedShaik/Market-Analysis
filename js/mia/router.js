// Intent-classified routing for Gemini.
//
// prose intent → Flash-Lite (cheap, fast, no tools)
// tool intent  → Flash      (better reasoning for multi-step + tools)
//
// The prose path uses a SLIM system prompt that strips the tool registry
// (saves prompt tokens on casual chat).

import * as gemini from './backends/api-gemini.js';
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
        lastDecision = { intent: 'prose', model: 'gemini-2.5-flash-lite', ts: Date.now() };
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
        const proseSystem = buildSlimSystemPrompt() + '\n\n' + buildContextBlock(latestSignal);
        for await (const delta of gemini.stream({
            system: proseSystem,
            messages,
            key,
            signal,
            tier: 'default',
        })) yield delta;
        return;
    }

    // Tool path: full tool-prompt system, Flash for better reasoning.
    lastDecision = { intent: 'tool', model: 'gemini-2.5-flash', ts: Date.now() };
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
    for await (const delta of gemini.stream({
        system,
        messages,
        key,
        signal,
        tier: 'thinking',
    })) yield delta;
}
