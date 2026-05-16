// Phase 8.4: explicit anti-fabrication preamble on the prose path.
//
// When intent='prose' we strip the tool prompt so 8B can't emit TOOL:
// lines. Side effect: 8B sometimes pretends to call tools anyway and
// fabricates plausible numbers (e.g. claimed "72% hit rate" with no data
// behind it). We append a hard rule that explicitly tells the model:
// no tools this turn, no faking it, say "I don't have that data" if asked
// for live anything.

import * as groq from './backends/api-groq.js';
import { classifyIntent } from './intent-classifier.js';
import { loadSettings } from './settings.js';

let lastDecision = null;

export function getLastDecision() { return lastDecision; }

const PROSE_PATH_GUARD = `

# CRITICAL — NO TOOLS THIS TURN
You have NO tool access this turn. You CANNOT call any tool, fetch live data, retrieve stats, or look up any number.

If the user asks for ANY of the following, you MUST say "I don't have that data right now — let me actually check" or similar honest reply, and STOP. Do NOT fabricate plausible numbers.

Forbidden behaviors this turn:
- Saying "I'll call get_X" or "let me run X tool" — you cannot, and will not.
- Stating any percentage, count, hit-rate, accuracy figure, price, or stat as if you fetched it.
- Inventing numbers like "72% accuracy" or "1,234 predictions" — these are pure fabrication and will be flagged as untrustworthy.
- Pretending you accessed signal data, calibration, or any tool result.

Allowed: explanations, definitions, education, conversational replies. If the user asks something that needs live data, REFUSE TO GUESS and say you'd need to actually check.
`;

/**
 * Stream Mia output with intent-classified routing.
 */
export async function* routedStream({ system, systemNoTools, messages, key, signal, onProgress }) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const intent = await classifyIntent({
        userMessage: lastUser?.content || '',
        key,
        signal,
    });

    if (intent === 'prose') {
        lastDecision = { intent: 'prose', model: 'llama-3.1-8b-instant', ts: Date.now() };
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
        const proseSystem = (systemNoTools || system) + PROSE_PATH_GUARD;
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
