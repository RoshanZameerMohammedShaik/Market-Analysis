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

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_DEFAULT = 'gemini-2.5-flash-lite';
const MODEL_THINKING = 'gemini-2.5-flash';

// Silent retry on transient errors. 429 = our quota; 503 = Gemini-side
// overload (very common, usually clears in <2s). Both retried with the
// same backoff schedule before surfacing.
const RETRY_DELAYS_MS = [800, 1500, 3000];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const respBody = await res.text().catch(() => '');
        const retryAfter = parseFloat(res.headers.get('retry-after')) || null;
        const err = new Error(parseGeminiError(res.status, respBody, retryAfter));
        err.status = res.status;
        err.retryAfterSec = retryAfter;
        throw err;
    }
    return res;
}

export async function* stream({ system, messages, key, signal, tier = 'default' }) {
    const model = modelFor(tier);
    if (!key) throw new Error('Gemini API key required. Paste your AI Studio key in Mia settings.');
    let res;

    // Initial post with retry on 429 (our quota) and 5xx (Gemini overload).
    // 503s in particular are common and almost always transient.
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
            if (!retryable || !moreAttempts || signal?.aborted) throw err;
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            if (signal?.aborted) throw err;
        }
    }
    if (lastErr) throw lastErr;

    recordCall(model);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
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
                    throw e;
                }
                // Gemini wraps content in candidates[0].content.parts[*].text
                const parts = json.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                    if (p.text) yield p.text;
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
            if (res.status === 400 && /API key not valid/i.test(msg)) return { ok: false, msg: 'Key was rejected. Double-check the AIza… value.' };
            if (res.status === 403) return { ok: false, msg: `Forbidden: ${msg.slice(0, 160)}` };
            return { ok: false, msg: `Test failed (${res.status}).` };
        }
        return { ok: true, msg: `Connected. ${model === MODEL_THINKING ? 'Gemini 2.5 Flash' : 'Gemini 2.5 Flash-Lite'} ready.` };
    } catch (e) {
        return { ok: false, msg: `Network error: ${e.message}` };
    }
}

export function getModelForTier(tier) { return modelFor(tier); }
