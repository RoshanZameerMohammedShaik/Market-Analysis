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
 *
 * Strategy: try a free local heuristic first. The classifier API call
 * is itself a Flash-Lite request — burning one of those JUST to decide
 * which API to call next was a major source of quota waste. The
 * heuristic catches the obvious cases (greetings, short prose, missing
 * any data signal) without a network round-trip. Only when the message
 * is genuinely ambiguous do we fall back to the API call.
 *
 * Also: skips the API call entirely when Flash-Lite is currently in
 * cooldown. When in doubt return 'tool' — that just means the chain
 * walker prefers reasoning-tier models, which is the safer default.
 */
export function heuristicClassify(userMessage) {
    const raw = String(userMessage || '').trim();
    if (!raw) return 'prose';
    const text = raw.toLowerCase();

    // Educational questions about indicators / concepts come FIRST,
    // before the ticker check — because indicator acronyms like RSI,
    // MACD, ADX, ATR look like tickers but are concepts the LLM can
    // explain from general knowledge. System prompt prevents Mia from
    // inventing numbers, so prose-route is safe here.
    const educational = /^(what (is|are|does|do|means)|explain|define|tell me about|how does|how do|why is)\b.*\b(rsi|macd|bollinger|stochastic|moving average|ema|sma|adx|atr|fibonacci|candlestick|support|resistance|breakout|trend|volatility|oscillator|indicator|signal|confidence|calibration|backtest|sentiment|finbert)\b/i;
    if (educational.test(text)) {
        return 'prose';
    }

    // Guided-tour requests always need the tool path (Mia drives the app).
    // Checked before the ticker/short-message logic so "show me around"
    // routes deterministically instead of falling through to prose.
    if (/\b(tour|walk me through|walkthrough|show me around|give me a (quick )?tour|guided tour|demo (it|the app)|how do i use this)\b/i.test(text)) {
        return 'tool';
    }

    // Detect anything that smells like a ticker / data request.
    // Excludes common indicator acronyms that are NOT tickers, so
    // "RSI" doesn't get mis-flagged. Real tickers in the universe
    // (NVDA, BTC, AAPL) are 1-5 caps + optional .NS/.HK/-USD suffix.
    const INDICATOR_ACRONYMS = /^(RSI|MACD|ADX|ATR|EMA|SMA|VWAP|BB|MFI|OBV|CCI|VIX|GDP|CPI|PCE|FOMC|ETF|IPO|EPS|PE|PEG|ROE|ROI|TPS|RPM|RPD|TPM|API|LLM|UI|UX|CSS|JS|HTML|CEO|CFO|SEC|FDA|FED|USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|HKD)$/;
    const tickerCandidates = (raw.match(/\b[A-Z]{2,5}(?:[.-][A-Z]{1,3})?\b/g) || [])
        .filter(t => !INDICATOR_ACRONYMS.test(t));
    const looksLikeTicker = tickerCandidates.length > 0;
    const looksLikeCrypto = /\b(btc|eth|sol|ada|doge|xrp|bnb|matic|dot|ltc|avax|link|atom|near|arb|op|sui|sei|pepe|shib|ton|trx|wld|tia|ldo)\b/i.test(raw);
    const hasDataKeyword = /[$₹€£]\d|\d+%|ticker|stock|crypto|price|signal|buy|sell|prediction|portfolio|chart|news|earnings|forecast|target|hot picks|spiker|loser|gainer|recommend/i.test(text);
    // App-control intents that need a tool even though they carry no ticker /
    // data keyword — e.g. a guided tour drives the real app. Without this,
    // "give me a tour" / "show me around" are short + data-signal-free and
    // would be mis-routed to prose, so the walkthrough tool never fires.
    const wantsWalkthrough = /\b(tour|walk me through|walkthrough|show me around|give me a (quick )?tour|guided tour|demo (it|the app)|how do i use)\b/i.test(text);
    const hasDataSignal = looksLikeTicker || looksLikeCrypto || hasDataKeyword || wantsWalkthrough;

    // Short messages (≤ 4 words, ≤ 30 chars) without any data signal
    // are virtually always prose. "hi", "thanks", "are you there",
    // "what's up", "lol that's crazy" — none need a tool call to
    // answer. Saves an API call per casual turn.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 4 && text.length <= 30 && !hasDataSignal) {
        return 'prose';
    }

    // Greeting / acknowledgement patterns — pure prose.
    const greetings = /^(hi+|hey+|hello|yo|sup|hola|namaste|hiya|howdy|good (morning|evening|afternoon|night)|bye|cya|ttyl|thanks?|thx|ty|cool|nice|ok|okay|got it|sure|yes|yep|nope|no|haha+|lol+|lmao+|how are you|how's it going|what's up|wassup|sup)\b/i;
    if (greetings.test(text) && !hasDataSignal) {
        return 'prose';
    }

    // Anything else — too uncertain to call. Fall through to API.
    return null; // null = "ask the API"
}

export async function classifyIntent({ userMessage, key, signal }) {
    if (!userMessage || !key) return 'tool';

    // 1. Free local heuristic. Catches greetings, short prose, basic
    //    educational questions. Returns 'prose' or null (= ambiguous).
    const heuristic = heuristicClassify(userMessage);
    if (heuristic === 'prose') return 'prose';
    // null falls through to API call below.

    // 2. Skip the round-trip when Flash-Lite is cooling. Cheaper than
    //    the 429 we'd get; safer than waiting for the timeout.
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
