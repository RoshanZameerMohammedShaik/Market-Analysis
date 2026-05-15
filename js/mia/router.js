// Phase 5 router: intent-classified deterministic routing.
//
// Old approach (Phase 3): start every turn on 8B, buffer output, sniff for
// `TOOL:` mid-stream, abort & promote to 70B if detected. Wobbly because
// 8B's mid-stream format adherence is unreliable.
//
// New approach: classify intent first (cheap ~70-token 8B call), then run
// the whole turn deterministically:
//   - intent='prose' → 8B with NO tool prompt section. Writes the answer
//     directly. No format risk, no tool fabrication risk.
//   - intent='tool'  → 70B with the full tool prompt and the agent loop.
//     70B's tool-call adherence is ~98%.
//
// thinking-mode users skip the classifier entirely — they explicitly want
// 70B for everything.
//
// We export `routedStream` and a helper `getLastDecision()` so the UI can
// show 'auto: 8B (prose)' or 'auto: 70B (tools)' in the usage meter.

import * as groq from './backends/api-groq.js';
import { classifyIntent } from './intent-classifier.js';
import { loadSettings } from './settings.js';

let lastDecision = null; // { intent, model, ts }

export function getLastDecision() { return lastDecision; }

/**
 * Stream Mia output with intent-classified routing.
 *
 * @param {object} opts
 * @param {string} opts.system        — system prompt (with or without tools)
 * @param {string} opts.systemNoTools — system prompt for prose path (no tool section)
 * @param {{role: string, content: string}[]} opts.messages
 * @param {string} opts.key
 * @param {AbortSignal} opts.signal
 * @param {(msg: any) => void} [opts.onProgress]
 * @returns Async iterable of strings (text deltas).
 */
export async function* routedStream({ system, systemNoTools, messages, key, signal, onProgress }) {
    // Classify on the user's last message; if no user turn, default to tool.
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const intent = await classifyIntent({
        userMessage: lastUser?.content || '',
        key,
        signal,
    });

    if (intent === 'prose') {
        lastDecision = { intent: 'prose', model: 'llama-3.1-8b-instant', ts: Date.now() };
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
        // Use the no-tools system prompt so 8B doesn't try to emit TOOL: lines.
        for await (const delta of groq.stream({
            system: systemNoTools || system,
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
