// Groq backend — OpenAI-compatible chat completions, streaming, fast.
// Free tier: 30 RPM, 14400 RPD, 6000 TPM, 500k TPD on Llama 3.3 70B.
// Reads x-ratelimit-remaining-* headers so we can show a usage meter.

const URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

let lastUsage = null; // { reqRem, reqLim, tokRem, tokLim, ... }

export function getLastUsage() { return lastUsage; }

export async function* stream({ system, messages, key, signal }) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'system', content: system }, ...messages],
            temperature: 0.3,
            max_tokens: 800,
            stream: true,
        }),
        signal,
    });

    captureRateHeaders(res.headers);

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('Groq rejected the API key. Open settings and re-paste a valid one.');
        if (res.status === 429) throw new Error('Groq rate-limited. Wait and try again, or check the usage meter.');
        throw new Error(`Groq error ${res.status}: ${body.slice(0, 200)}`);
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

export async function ping(key) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: 'reply pong' }],
            max_tokens: 5,
            temperature: 0,
        }),
        signal: AbortSignal.timeout(15000),
    });
    captureRateHeaders(res.headers);
    if (!res.ok) {
        if (res.status === 401) return { ok: false, msg: 'Key was rejected (401). Double-check the gsk_... value.' };
        return { ok: false, msg: `Test failed (${res.status}).` };
    }
    return { ok: true, msg: 'Connected. Llama 3.3 70B ready.' };
}

function captureRateHeaders(h) {
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
        };
    }
}
