// Cloudflare Workers AI backend — alternative free API key option.
// Path: /accounts/{account_id}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast
// Requires both a Workers AI API token and the user's account ID.
//
// Free tier: ~10,000 "neurons"/day. Roughly ~150-300 Llama 70B replies/day.
// CF doesn't expose remaining usage in response headers — we estimate.

let lastUsage = null;

export function getLastUsage() { return lastUsage; }

function url(accountId) {
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
}

export async function* stream({ system, messages, key, accountId, signal }) {
    const res = await fetch(url(accountId), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
            messages: [{ role: 'system', content: system }, ...messages],
            temperature: 0.3,
            max_tokens: 1500,
            stream: true,
        }),
        signal,
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('Cloudflare rejected the token. Re-paste in settings.');
        if (res.status === 403) throw new Error('Token lacks Workers AI permission. Check the token scope.');
        if (res.status === 429) throw new Error('Cloudflare Workers AI daily free quota hit. Wait until UTC midnight, or switch to Gemini.');
        throw new Error(`Cloudflare error ${res.status}: ${body.slice(0, 200)}`);
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
                const delta = json.response;
                if (delta) yield delta;
            } catch (_) { /* */ }
        }
    }
}

export async function ping(key, accountId) {
    if (!accountId) return { ok: false, msg: 'Cloudflare also needs your account ID. Find it on the right side of dash.cloudflare.com.' };
    const res = await fetch(url(accountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'reply pong' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        if (res.status === 401) return { ok: false, msg: 'Token rejected (401). Double-check it.' };
        if (res.status === 403) return { ok: false, msg: 'Token works but lacks Workers AI permission.' };
        return { ok: false, msg: `Test failed (${res.status}).` };
    }
    return { ok: true, msg: 'Connected. Cloudflare Workers AI ready.' };
}
