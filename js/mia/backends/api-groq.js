// Groq backend — OpenAI-compatible chat completions, streaming, fast.
//
// Phase 8.8 add: silent 1-second retry on 429. Most TPM/RPM throttles on
// the free tier clear within the sliding window in <2s. We retry once
// after 1000ms, then surface the error if it still fails. User experience:
// they wait an extra second instead of seeing "rate-limited" right away.
//
// Stop sequences: prevent the model from fabricating tool RESULT blocks.
// Halts on `\nRESULT:` or `RESULT (from`. Does NOT halt on `\nTOOL:` —
// natural preamble like "I'll use web_search to look that up" comes
// through fine and the agent loop intercepts the actual TOOL: line.
//
// New Groq accounts ship with their org-level model allowlist EMPTY.
// We detect that 403 specifically and surface an actionable message.

const URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_DEFAULT = 'llama-3.1-8b-instant';
const MODEL_THINKING = 'llama-3.3-70b-versatile';

const STOP_SEQUENCES = ['\nRESULT:', 'RESULT (from'];

// One silent retry on 429 after this delay. Keep small — the user is waiting.
const RETRY_429_MS = 1000;

let lastUsage = null;

export function getLastUsage() { return lastUsage; }

function modelFor(tier) {
    return tier === 'thinking' ? MODEL_THINKING : MODEL_DEFAULT;
}

function parseGroqError(status, body, retryAfterSec) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    const msg = parsed?.error?.message || body || '';
    if (status === 401) {
        return 'Groq rejected the API key (401). Open settings and re-paste a valid gsk_… value.';
    }
    if (status === 403 && /model_permission_blocked_org|blocked at the organization/i.test(msg)) {
        const m = msg.match(/`([^`]+)`/);
        const blocked = m ? m[1] : 'this model';
        return `Groq blocked ${blocked} at your org level. Open https://console.groq.com/settings/limits → Allowed Models, enable ${blocked}, then try again.`;
    }
    if (status === 403) {
        return `Groq returned 403: ${msg.slice(0, 200)}`;
    }
    if (status === 429) {
        const wait = retryAfterSec ? ` Retry in ${Math.ceil(retryAfterSec)}s.` : '';
        return `Groq rate-limited.${wait}`;
    }
    return `Groq error ${status}: ${(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 200)}`;
}

/**
 * Make a single Groq POST. Returns the Response on success or throws an
 * Error with .status set on failure.
 */
async function postOnce({ model, system, messages, key, signal }) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, ...messages],
            temperature: 0.3,
            max_tokens: 800,
            stream: true,
            stop: STOP_SEQUENCES,
        }),
        signal,
    });
    captureRateHeaders(res.headers, model);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryAfter = parseFloat(res.headers.get('retry-after')) || null;
        const err = new Error(parseGroqError(res.status, body, retryAfter));
        err.status = res.status;
        err.retryAfterSec = retryAfter;
        throw err;
    }
    return res;
}

export async function* stream({ system, messages, key, signal, tier = 'default' }) {
    const model = modelFor(tier);
    let res;

    try {
        res = await postOnce({ model, system, messages, key, signal });
    } catch (err) {
        // Silent 1s retry on 429 — most sliding-window throttles clear within ~1s.
        // 401/403 (auth) and 5xx (server) skip the retry.
        if (err?.status === 429 && !signal?.aborted) {
            await new Promise(r => setTimeout(r, RETRY_429_MS));
            if (signal?.aborted) throw err;
            try {
                res = await postOnce({ model, system, messages, key, signal });
            } catch (err2) {
                throw err2;
            }
        } else {
            throw err;
        }
    }

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
            if (payload === '[DONE]') return;
            try {
                const json = JSON.parse(payload);
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) yield delta;
            } catch (_) { /* skip */ }
        }
    }
}

export async function ping(key, tier = 'default') {
    const model = modelFor(tier);
    const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'reply pong' }],
            max_tokens: 5,
            temperature: 0,
        }),
        signal: AbortSignal.timeout(15000),
    });
    captureRateHeaders(res.headers, model);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        const msg = parsed?.error?.message || '';
        if (res.status === 401) return { ok: false, msg: 'Key was rejected (401). Double-check the gsk_… value.' };
        if (res.status === 403 && /model_permission_blocked_org|blocked at the organization/i.test(msg)) {
            return { ok: false, msg: `Key works, but ${model} is blocked at your org. Open console.groq.com/settings/limits → Allowed Models and enable ${model}.` };
        }
        if (res.status === 403) return { ok: false, msg: `Forbidden (403): ${msg.slice(0, 160)}` };
        return { ok: false, msg: `Test failed (${res.status}).` };
    }
    return { ok: true, msg: `Connected. ${model === MODEL_THINKING ? 'Llama 3.3 70B' : 'Llama 3.1 8B'} ready.` };
}

export function getModelForTier(tier) { return modelFor(tier); }

function captureRateHeaders(h, model) {
    const get = k => h.get(k);
    const reqLim = parseFloat(get('x-ratelimit-limit-requests')) || null;
    const reqRem = parseFloat(get('x-ratelimit-remaining-requests')) || null;
    const tokLim = parseFloat(get('x-ratelimit-limit-tokens')) || null;
    const tokRem = parseFloat(get('x-ratelimit-remaining-tokens')) || null;
    if (reqLim || tokLim) {
        lastUsage = { reqLim, reqRem, tokLim, tokRem, ts: Date.now(), provider: 'groq', model };
    }
}
