// Mia's LLM client.
//
// Backend choices:
//   - 'pollinations' (default): Pollinations.ai text endpoint. Free, no
//     API key, permissive CORS, OpenAI-compatible chat schema. Picks a
//     gpt-4o-mini-class model under the hood.
//   - 'openai' (BYOK): Fast, user pays. Stored locally.
//
// Why not Hugging Face Inference: their hosted Mistral / Llama models
// are GATED (require license acceptance + an HF access token). Anonymous
// browser calls fail CORS preflight and surface as "Failed to fetch"
// with no useful error. Forcing every user to register an HF account
// to use a free chatbot defeats the point.
//
// Why not Anthropic: Anthropic's Messages API blocks browser CORS.

const POLLINATIONS_OAI = 'https://text.pollinations.ai/openai';
const POLLINATIONS_GET = 'https://text.pollinations.ai';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const POLLI_MODEL = 'openai'; // routes to a gpt-4o-mini-class model on their side

export async function callLLM({ system, messages, settings }) {
    const backend = settings?.backend || 'pollinations';
    if (backend === 'openai' && settings?.openaiKey) {
        return callOpenAI(system, messages, settings.openaiKey);
    }
    return callPollinations(system, messages);
}

async function callOpenAI(system, messages, apiKey) {
    let res;
    try {
        res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [{ role: 'system', content: system }, ...messages],
                temperature: 0.3,
                max_tokens: 600,
            }),
            signal: AbortSignal.timeout(45000),
        });
    } catch (e) {
        throw new Error(`Couldn't reach OpenAI (${humanFetchError(e)}). Check your network or your API key.`);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('OpenAI rejected the API key (401). Open settings and paste a valid key.');
        if (res.status === 429) throw new Error('OpenAI rate-limited. Try again in a few seconds, or check billing.');
        throw new Error(`OpenAI error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || '(empty response)';
}

async function callPollinations(system, messages) {
    // First try OpenAI-compatible POST.
    try {
        const res = await fetch(POLLINATIONS_OAI, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: POLLI_MODEL,
                messages: [{ role: 'system', content: system }, ...messages],
                temperature: 0.3,
                max_tokens: 600,
            }),
            signal: AbortSignal.timeout(45000),
        });
        if (res.ok) {
            const json = await res.json();
            const text = json?.choices?.[0]?.message?.content?.trim();
            if (text) return text;
        }
    } catch (_) { /* fall through to GET */ }

    // Fallback: simple GET endpoint with URL-encoded combined prompt.
    try {
        const conv = messages.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
        const prompt = `${system}\n\n${conv}\nMia:`;
        const url = `${POLLINATIONS_GET}/${encodeURIComponent(prompt)}?model=${POLLI_MODEL}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = (await res.text()).trim();
        if (text) return text;
        throw new Error('empty response');
    } catch (e) {
        throw new Error(`Couldn't reach Mia's free backend (${humanFetchError(e)}). For faster + reliable replies, switch to OpenAI in settings (you supply the key).`);
    }
}

function humanFetchError(e) {
    const msg = (e && e.message) || String(e);
    if (/abort|timeout/i.test(msg)) return 'request timed out';
    if (/Failed to fetch|NetworkError|CORS/i.test(msg)) return 'network or CORS error';
    return msg;
}

export async function pingBackend(settings) {
    // Used by the settings panel "Test connection" button. Returns
    // { ok: bool, msg: string }.
    try {
        const reply = await callLLM({
            system: 'You are Mia. Reply with exactly the word: pong.',
            messages: [{ role: 'user', content: 'ping' }],
            settings,
        });
        return { ok: true, msg: `OK — received: "${reply.slice(0, 40)}"` };
    } catch (e) {
        return { ok: false, msg: e.message || String(e) };
    }
}
