// Phase 5 — cheap upfront intent classification.
//
// Why: 8B's tool-call format adherence is wobbly (~70%) when it has to
// decide mid-stream whether to emit `TOOL: ...` or write prose. Stream-
// buffer regex + stop sequences treat symptoms, not the disease.
//
// New approach: ask 8B a single yes/no question up front — 'does this
// require live data, an external lookup, or app control?' — then route
// deterministically:
//   - intent = TOOL    → 70B handles the whole tool-use turn
//   - intent = PROSE   → 8B writes the answer with NO tool capability
//
// Token cost per turn: ~70 prompt + 1 completion = ~71 tokens. Negligible
// next to the ~1,000-token main call.
//
// Reliability: 8B can robustly answer a single forced-choice question
// even when it can't robustly emit a structured tool call format. We use
// a 1-token max_tokens to force a one-letter answer (T or P).
//
// Failure mode: if classification fails (network error, ambiguous reply),
// default to TOOL/70B — 70B can handle pure Q&A fine, just at higher cost.

import { state } from '../ui/state.js';

const CLASSIFY_MODEL = 'llama-3.1-8b-instant';
const URL = 'https://api.groq.com/openai/v1/chat/completions';

const CLASSIFIER_SYSTEM = `Classify the user's request as exactly one letter:

T = needs LIVE DATA, EXTERNAL LOOKUP, or APP CONTROL. Examples: 'what's the F&G index', 'show me NVDA', 'compare AAPL and MSFT', 'any news on TSLA', 'what is the 10y yield', 'switch to crypto', 'refresh hot picks', 'what does the current signal say'.

P = pure EXPLANATION, EDUCATION, or DEFINITION using prior knowledge only. Examples: 'what is RSI', 'explain MACD', 'how does Bollinger squeeze work', 'define put/call ratio', 'why do you use FinBERT'.

Reply with ONLY the single letter T or P. No punctuation, no other text.`;

/**
 * Returns 'tool' | 'prose' | 'unknown'.
 * Falls back to 'tool' on any error so reliability beats cost.
 */
export async function classifyIntent({ userMessage, key, signal }) {
    if (!userMessage || !key) return 'tool';

    // Add a thin context hint so questions like 'is the market bullish today'
    // get classified correctly even without keywords like 'show'.
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
        return 'tool'; // unknown reply → safe-default
    } catch (_) {
        return 'tool';
    }
}
