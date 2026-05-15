// Groq backend — OpenAI-compatible chat completions, streaming, fast.
//
// Model routing:
//   - default tier:  llama-3.1-8b-instant   (14,400 RPD / 500K TPD)
//   - thinking mode: llama-3.3-70b-versatile (1,000 RPD / 100K TPD)
//
// Stop sequences: 8B-class models often continue past their tool call
// and fabricate a RESULT: block from training memory. We set the API's
// `stop` parameter so generation halts at boundary tokens. The agent
// loop then runs the actual tool and feeds the real result back as the
// next user turn.
//
// New Groq accounts ship with their org-level model allowlist EMPTY.
// We detect that 403 specifically and surface an actionable message.
//
// 429 handling: we read the Groq-documented retry-after header and surface
// it on the thrown error so the dispatcher in llm-client.js can decide
// whether to wait or fall over to Cloudflare.

const URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_DEFAULT = 'llama-3.1-8b-instant';
const MODEL_THINKING = 'llama-3.3-70b-versatile';

// Halt the moment the model tries to fabricate a tool result, or
// invents a second tool call without waiting. The agent loop will
// pick up from there with the real RESULT.
const STOP_SEQUENCES = ['\nRESULT:', 'RESULT (from', '\nTOOL:'];

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
        return `Groq blocked ${blocked} at your org level. Open https://console.groq.com/settings/limits → Allowed Models, enable ${blocked}, then try again. New Groq accounts ship with model access disabled by default.`;
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

export async function* stream({ system, messages, key, signal, tier = 'default' }) {
    const model = modelFor(tier);
    const res = await fetch(URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
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
            return { ok: false, msg: `Key works, but ${model} is blocked at your org. Open console.groq.com/settings/limits → Allowed Models and enable ${model} (Step 4 above).` };
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
        lastUsage = {
            reqLim, reqRem, tokLim, tokRem,
            ts: Date.now(),
            provider: 'groq',
            model,
        };
    }
}
