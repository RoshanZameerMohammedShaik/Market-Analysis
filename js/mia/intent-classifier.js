// Cheap upfront intent classification using Gemini Flash-Lite (free tier,
// 30 RPM). Decides whether the user's question needs tools or can be
// answered from general knowledge. Single-token completion (~80 tokens
// of input + 1 of output), so the cost is negligible.
//
// Falls back to 'tool' on any error — reliability beats cost.

import { state } from '../ui/state.js';

const CLASSIFY_MODEL = 'gemini-2.5-flash-lite';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const CLASSIFIER_SYSTEM = `Classify the user's request as exactly one letter.

T = the answer depends on something outside general knowledge: live or time-sensitive data, an external lookup, control of the app, a specific symbol, a pick or prediction, or a question about this app's own performance.

P = pure general-knowledge explanation, education, or definition that doesn't depend on live data or a specific symbol.

Classify by underlying INTENT, not surface phrasing. Casual address or tonal flourish don't change the intent. If in doubt, prefer T. Reply with ONLY the letter T or P.`;

/**
 * Returns 'tool' | 'prose'.
 * Falls back to 'tool' on any error so reliability beats cost.
 *
 * Also: skips the API call entirely when Flash-Lite is currently in
 * cooldown. The classifier ALWAYS uses Flash-Lite (it's the cheapest
 * model), but if that model is exhausted we'd 429 here on every turn
 * and waste a request slot. When in doubt return 'tool' — that just
 * means the chain walker prefers reasoning-tier models, which is the
 * safer default.
 */
export async function classifyIntent({ userMessage, key, signal }) {
    if (!userMessage || !key) return 'tool';

    // Skip the round-trip when Flash-Lite is cooling. Cheaper than the
    // 429 we'd get; safer than waiting for the timeout to discover it.
    try {
        const { isCooling } = await import('./backends/tier-cooldown.js');
        if (isCooling(CLASSIFY_MODEL)) return 'tool';
    } catch (_) { /* import error → fall through and try anyway */ }

    const context = state.currentSymbol
        ? `(user has ${state.currentSymbol} loaded on screen)`
        : '(no symbol loaded)';

    try {
        const url = `${BASE_URL}/${CLASSIFY_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: CLASSIFIER_SYSTEM }] },
                contents: [{ role: 'user', parts: [{ text: `${context}\n\nUser request: ${userMessage}` }] }],
                generationConfig: {
                    maxOutputTokens: 2,
                    temperature: 0,
                },
            }),
            signal: signal || AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            // Mark Flash-Lite as cooling so subsequent classifier calls
            // skip the round-trip until the window expires. Same map
            // the rest of the chain reads, so the chain walker also
            // benefits.
            if (res.status === 429) {
                try {
                    const { markCooling } = await import('./backends/tier-cooldown.js');
                    markCooling(CLASSIFY_MODEL);
                } catch (_) {}
            }
            return 'tool';
        }
        const j = await res.json();
        const content = (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
        if (content.startsWith('P')) return 'prose';
        if (content.startsWith('T')) return 'tool';
        return 'tool';
    } catch (_) {
        return 'tool';
    }
}
