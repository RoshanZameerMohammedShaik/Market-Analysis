// Phase 8.4 critical fix: classifier was routing 'how accurate is this app'
// as PROSE → 8B with no tools fabricated '72%' and '1,234 predictions'.
// Any question about LIVE STATS or APP'S OWN PERFORMANCE must go through
// tools, not prose-mode.

import { state } from '../ui/state.js';

const CLASSIFY_MODEL = 'llama-3.1-8b-instant';
const URL = 'https://api.groq.com/openai/v1/chat/completions';

const CLASSIFIER_SYSTEM = `Classify the user's request as exactly one letter:

T = needs LIVE DATA, EXTERNAL LOOKUP, APP CONTROL, or APP PERFORMANCE STATS.
  Examples:
  - 'what's the F&G index'
  - 'show me NVDA'
  - 'compare AAPL and MSFT'
  - 'any news on TSLA'
  - 'what is the 10y yield'
  - 'switch to crypto'
  - 'refresh hot picks'
  - 'what does the current signal say'
  - 'is the market bullish today'
  - 'how is BTC doing right now'
  - 'latest sentiment on AAPL'
  - 'what is the VIX currently'
  - 'how accurate is this app' / 'how accurate is the engine'
  - 'what's the hit rate' / 'what's your accuracy'
  - 'how good is this app' / 'how reliable is it'
  - 'what's the calibration like' / 'how calibrated is it'
  - 'how many predictions have you made'
  - any phrase with: today, right now, currently, latest, this week, recent
  - any question about THIS APP'S performance, accuracy, hit rate, calibration, or stats

P = pure EXPLANATION, EDUCATION, or DEFINITION using prior knowledge only.
  Examples:
  - 'what is RSI'
  - 'explain MACD'
  - 'how does Bollinger squeeze work'
  - 'define put/call ratio'
  - 'why do you use FinBERT'
  - 'difference between calls and puts'
  - 'what is conformal prediction'
  - 'what does confidence mean in general'

If in doubt, prefer T. Reply with ONLY the single letter T or P. No punctuation, no other text.`;

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
