// Phase 8.4 critical fix: classifier was routing 'how accurate is this app'
// as PROSE → 8B with no tools fabricated '72%' and '1,234 predictions'.
// Any question about LIVE STATS or APP'S OWN PERFORMANCE must go through
// tools, not prose-mode.

import { state } from '../ui/state.js';

const CLASSIFY_MODEL = 'llama-3.1-8b-instant';
const URL = 'https://api.groq.com/openai/v1/chat/completions';

const CLASSIFIER_SYSTEM = `Classify the user's request as exactly one letter.

T = the answer depends on something outside general knowledge: live or time-sensitive data, an external lookup, control of the app, a specific symbol, a pick or prediction, or a question about this app's own performance.

P = pure general-knowledge explanation, education, or definition that doesn't depend on live data or a specific symbol.

Classify by underlying INTENT, not surface phrasing. Casual address or tonal flourish don't change the intent. If in doubt, prefer T. Reply with ONLY the letter T or P.`;

/**
 * Returns 'tool' | 'prose'.
 * Falls back to 'tool' on any error so reliability beats cost.
 */
export async function classifyIntent({ userMessage, key, signal }) {
    if (!userMessage || !key) return 'tool';

    const context = state.currentSymbol
        ? `(user has ${state.currentSymbol} loaded on screen)`
        : '(no symbol loaded)';

    try {
        const res = await fetch(URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                model: CLASSIFY_MODEL,
                messages: [
                    { role: 'system', content: CLASSIFIER_SYSTEM },
                    { role: 'user', content: `${context}\n\nUser request: ${userMessage}` },
                ],
                max_tokens: 2,
                temperature: 0,
            }),
            signal: signal || AbortSignal.timeout(5000),
        });
        if (!res.ok) return 'tool';
        const j = await res.json();
        const content = (j.choices?.[0]?.message?.content || '').trim().toUpperCase();
        if (content.startsWith('P')) return 'prose';
        if (content.startsWith('T')) return 'tool';
        return 'tool';
    } catch (_) {
        return 'tool';
    }
}
