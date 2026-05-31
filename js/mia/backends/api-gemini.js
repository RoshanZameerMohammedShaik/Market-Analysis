// Gemini backend — Google AI Studio API, streaming via SSE.
//
// Two tiers, both free:
//   default  → gemini-2.5-flash-lite  (30 RPM / 250K TPM / 1000 RPD)
//   thinking → gemini-2.5-flash       (15 RPM /   1M TPM / 1500 RPD)
//
// Default workhorse: Flash-Lite. Quality is roughly on par with Llama
// 3.3 70B but with 42× the per-minute token headroom of Groq's free tier
// (the killer constraint that kept tripping mid-stream 429s).
//
// Thinking mode escalates to Flash for genuinely deep questions —
// better reasoning + math precision when it matters.
//
// API note: Google's REST endpoint is /v1beta/models/{model}:streamGenerateContent
// with ?alt=sse&key=... appended. SSE format is "data: {json}\n\n", same shape
// our existing parser knows. Mid-stream errors arrive as a final SSE chunk
// containing {"error":{...}} — we throw a typed error so mia.js preserves
// the partial reply instead of wiping it.

import { markCooling, isCooling, msUntilHealthy } from './tier-cooldown.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Default tier mappings retained for callers (router, llm-client) that
// still ask for 'default' / 'thinking'. The fuller model rotation lives
// in gemini-models.js; this map just keeps backward-compat labels alive.
const MODEL_DEFAULT = 'gemini-2.5-flash-lite';
const MODEL_THINKING = 'gemini-2.5-flash';

// Re-export so other modules (llm-client, status pill) can read state
// without adding a second import line everywhere.
export { isCooling, msUntilHealthy } from './tier-cooldown.js';
export { getCooldownState } from './tier-cooldown.js';

// Silent retry on transient errors. 5xx = Gemini-side overload (very
// common, usually clears in <2s). 429 is NOT retried here — quota
// exhaustion means "use a different model", which is the chain
// walker's job in llm-client.js. Retrying 429 in-place would burn
// RPM on an already-exhausted model and never recover.
const RETRY_DELAYS_MS = [800, 1500, 3000, 6000];
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

// Best-effort per-minute usage tracking. Gemini doesn't return per-call
// rate-limit headers (Groq does), so we approximate by counting our own
// outbound calls in a rolling 60-second window. Lets the usage meter
// show "X / 30 req/min remaining" even though the server isn't telling us.
const RPM_BY_MODEL = {
    [MODEL_DEFAULT]: 30,
    [MODEL_THINKING]: 15,
};
const RPD_BY_MODEL = {
    [MODEL_DEFAULT]: 1000,
    [MODEL_THINKING]: 1500,
};

const callLog = []; // [{ ts, model }]
const dailyLog = JSON.parse(localStorage.getItem('mia-gemini-daily-log') || '{}'); // { 'YYYY-MM-DD': { model: count } }

let lastUsage = null;

export function getLastUsage() { return lastUsage; }

function modelFor(tier) {
    return tier === 'thinking' ? MODEL_THINKING : MODEL_DEFAULT;
}

function recordCall(model) {
    const now = Date.now();
    callLog.push({ ts: now, model });
    // Trim anything older than 60 seconds
    while (callLog.length && now - callLog[0].ts > 60_000) callLog.shift();

    const today = new Date().toISOString().slice(0, 10);
    dailyLog[today] = dailyLog[today] || {};
    dailyLog[today][model] = (dailyLog[today][model] || 0) + 1;
    // Drop entries older than 7 days to keep storage tiny
    for (const k of Object.keys(dailyLog)) {
        if (k < new Date(now - 7 * 86400_000).toISOString().slice(0, 10)) delete dailyLog[k];
    }
    try { localStorage.setItem('mia-gemini-daily-log', JSON.stringify(dailyLog)); } catch (_) {}

    // Refresh the usage snapshot for the meter.
    const minuteCount = callLog.filter(c => c.model === model).length;
    const dayCount = (dailyLog[today]?.[model]) || 0;
    lastUsage = {
        reqLim: RPM_BY_MODEL[model] || 30,
        reqRem: Math.max(0, (RPM_BY_MODEL[model] || 30) - minuteCount),
        // We don't know token usage server-side; surface daily req count
        // through the same "tokLim" axis the meter uses so the bar still
        // shows something meaningful when only request counts apply.
        tokLim: RPD_BY_MODEL[model] || 1000,
        tokRem: Math.max(0, (RPD_BY_MODEL[model] || 1000) - dayCount),
        ts: now,
        provider: 'gemini',
        model,
    };
}

// Convert OpenAI-style {role:'user'|'assistant', content:string} messages to
// Gemini's contents array. Gemini uses 'user' and 'model' (not 'assistant').
function toGeminiContents(system, messages) {
    const contents = [];
    for (const m of messages) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: m.content }] });
    }
    return { systemInstruction: { parts: [{ text: system }] }, contents };
}

function parseGeminiError(status, body, retryAfterSec) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    const msg = parsed?.error?.message || body || '';
    if (status === 400 && /API key not valid/i.test(msg)) {
        return 'Gemini rejected the API key. Open settings and re-paste a valid AI Studio key.';
    }
    if (status === 401 || status === 403) {
        return `Gemini auth error (${status}): ${msg.slice(0, 200)}`;
    }
    if (status === 429) {
        const wait = retryAfterSec ? ` Retry in ${Math.ceil(retryAfterSec)}s.` : '';
        return `Gemini rate-limited.${wait}`;
    }
    if (status >= 500 && status < 600) {
        // 503 is the common one — Google-side overload. Friendly message.
        return `Gemini is busy right now (${status}). Try again in a few seconds — this is a Google-side load issue, not your account.`;
    }
    return `Gemini error ${status}: ${(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 200)}`;
}

async function postOnce({ model, system, messages, key, signal }) {
    const url = `${BASE_URL}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const body = toGeminiContents(system, messages);
    body.generationConfig = {
        temperature: 0.3,
        maxOutputTokens: 1500,
        // Halt as soon as the model tries to write a tool RESULT block —
        // that's the agent's job, not the model's. Without these stops
        // Gemini will fabricate fake tool results inline and then write
        // an answer based on hallucinated data.
        stopSequences: ['\nRESULT:', 'RESULT (from'],
    };
    console.log('[mia/gemini] POST', model, '— request shape:', { msgs: messages.length, sysChars: system.length });
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    console.log('[mia/gemini] response received:', model, 'status', res.status);
    if (!res.ok) {
        const respBody = await res.text().catch(() => '');
        // Gemini surfaces retry hints two ways: standard Retry-After header
        // (rare) and inside the JSON body via error.details[*].retryDelay
        // ("23s"). The JSON form is what their quota API actually uses, so
        // we prefer that.
        let retryAfter = parseFloat(res.headers.get('retry-after')) || null;
        try {
            const parsed = JSON.parse(respBody);
            const details = parsed?.error?.details || [];
            for (const d of details) {
                if (d.retryDelay) {
                    const m = String(d.retryDelay).match(/^([\d.]+)\s*s/);
                    if (m) retryAfter = parseFloat(m[1]);
                }
            }
        } catch (_) { /* body wasn't JSON */ }

        const err = new Error(parseGeminiError(res.status, respBody, retryAfter));
        err.status = res.status;
        err.retryAfterSec = retryAfter;
        throw err;
    }
    return res;
}

export async function* stream({ system, messages, key, signal, tier = 'default', model: modelOverride = null }) {
    // Caller can pass an explicit model id (newer multi-model rotation
    // path) OR a coarse tier label ('default' / 'thinking', legacy two-
    // model path). When both are set, modelOverride wins.
    const model = modelOverride || modelFor(tier);
    if (!key) throw new Error('Gemini API key required. Paste your AI Studio key in Mia settings.');

    // Pre-flight: if this tier is currently cooling from a recent 429,
    // throw a typed error immediately so the orchestrator (llm-client)
    // can fall back to the alternate Gemini tier without burning a
    // request-and-retry cycle that we know will fail.
    if (isCooling(model)) {
        const remaining = Math.ceil(msUntilHealthy(model) / 1000);
        const err = new Error(`Gemini ${model} is in cooldown for ~${remaining}s.`);
        err.status = 429;
        err.tierCooling = true;
        err.coolingModel = model;
        err.retryAfterSec = remaining;
        throw err;
    }

    let res;

    // Initial post with retry on 429 (our quota) and 5xx (Gemini overload).
    // 503s in particular are common and almost always transient. When
    // Gemini gives an explicit retryDelay (e.g. "23s") we honor that
    // instead of the schedule, capped at 30s so a stuck quota doesn't
    // freeze the UI forever.
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
            res = await postOnce({ model, system, messages, key, signal });
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            const retryable = RETRYABLE_STATUSES.has(err?.status);
            const moreAttempts = attempt < RETRY_DELAYS_MS.length;
            if (!retryable || !moreAttempts || signal?.aborted) {
                // Terminal 429 → record this tier as cooling so future
                // calls skip it and try the alternate tier directly.
                if (err?.status === 429) {
                    markCooling(model, err.retryAfterSec);
                    err.tierCooling = true;
                    err.coolingModel = model;
                }
                throw err;
            }
            const scheduleMs = RETRY_DELAYS_MS[attempt];
            const hintMs = err?.retryAfterSec ? Math.min(30, err.retryAfterSec) * 1000 : 0;
            const waitMs = Math.max(scheduleMs, hintMs);
            await new Promise(r => setTimeout(r, waitMs));
            if (signal?.aborted) throw err;
        }
    }
    if (lastErr) throw lastErr;

    recordCall(model);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let chunkCount = 0;
    let yieldCount = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            console.log('[mia/gemini] stream ended:', model, 'chunks:', chunkCount, 'deltas yielded:', yieldCount);
            break;
        }
        chunkCount++;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line || !line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                if (json.error) {
                    const msg = json.error?.message || 'stream error';
                    const status = /quota|rate|429/i.test(msg) ? 429 : 500;
                    const e = new Error(msg);
                    e.status = status;
                    e.midStream = true;
                    if (status === 429) {
                        // Mid-stream quota exhaustion — mark the tier as
                        // cooling so the next call skips it. retryAfter
                        // hint isn't usually present in mid-stream errors,
                        // so we let markCooling default to 60s.
                        markCooling(model);
                        e.tierCooling = true;
                        e.coolingModel = model;
                    }
                    throw e;
                }
                // Gemini wraps content in candidates[0].content.parts[*].text
                const parts = json.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                    if (p.text) { yieldCount++; yield p.text; }
                }
                // Log finishReason if present — explains zero-text returns.
                const finish = json.candidates?.[0]?.finishReason;
                if (finish && finish !== 'STOP') {
                    console.warn('[mia/gemini] non-STOP finishReason:', finish, 'safetyRatings:', json.candidates?.[0]?.safetyRatings);
                }
            } catch (e) {
                if (e?.midStream) throw e;
                /* skip parse errors on partial chunks */
            }
        }
    }
}

export async function ping(key, tier = 'default') {
    const model = modelFor(tier);
    if (!key) return { ok: false, msg: 'No API key configured.' };
    try {
        const res = await fetch(`${BASE_URL}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'reply pong' }] }],
                generationConfig: { maxOutputTokens: 5, temperature: 0 },
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            let parsed = null; try { parsed = JSON.parse(body); } catch (_) {}
            const msg = parsed?.error?.message || '';
            if (res.status === 400 && /API key not valid/i.test(msg)) return { ok: false, msg: 'Key was rejected by Google. Double-check it was copied in full.' };
            if (res.status === 403) return { ok: false, msg: `Forbidden: ${msg.slice(0, 160)}` };
            return { ok: false, msg: `Test failed (${res.status}).` };
        }
        return { ok: true, msg: `Connected. ${model === MODEL_THINKING ? 'Gemini 2.5 Flash' : 'Gemini 2.5 Flash-Lite'} ready.` };
    } catch (e) {
        return { ok: false, msg: `Network error: ${e.message}` };
    }
}

export function getModelForTier(tier) { return modelFor(tier); }
