// Mia's LLM client — free, keyless, no user options.
//
// Every call hits Pollinations.ai and tries models in fallback order:
// openai-large → llama → deepseek → mistral → openai → qwen-coder.
// Per-model rate limits are independent, so when one says 429 another
// usually serves fine. The user never picks a model and never sees one.
//
// Why not Hugging Face: hosted Llama / Mistral are gated; anonymous
// browser calls fail CORS preflight.
// Why not Anthropic: Anthropic's API blocks browser CORS.
// Why not BYOK / OpenAI: the user explicitly does not want it.

const POLLINATIONS_OAI = 'https://text.pollinations.ai/openai';
const POLLINATIONS_GET = 'https://text.pollinations.ai';

// Hand-picked priority order. openai-large first because it's the
// strongest balanced model on the endpoint; the rest are diverse
// fallbacks chosen so a single provider outage doesn't take Mia down.
const MODEL_CHAIN = ['openai-large', 'llama', 'deepseek', 'mistral', 'openai', 'qwen-coder'];

export async function callLLM({ system, messages }) {
    const errors = [];
    for (let i = 0; i < MODEL_CHAIN.length; i++) {
        const model = MODEL_CHAIN[i];
        try {
            const reply = await callOnce(system, messages, model, /*allowGetFallback=*/ i === 0);
            return { reply, model, fellBack: i > 0 };
        } catch (e) {
            errors.push(`${model}: ${e.message}`);
            if (/abort/i.test(e.message)) break; // user cancelled
            if (i < MODEL_CHAIN.length - 1) await sleep(800); // brief backoff
        }
    }
    throw new Error(`All free models busy right now. Wait ~30s and try again. (Tried: ${MODEL_CHAIN.join(', ')})`);
}

async function callOnce(system, messages, model, allowGetFallback) {
    let res;
    try {
        res = await fetch(POLLINATIONS_OAI, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'system', content: system }, ...messages],
                temperature: 0.3,
                max_tokens: 600,
            }),
            signal: AbortSignal.timeout(60000),
        });
    } catch (e) {
        throw new Error(humanFetchError(e));
    }
    if (res.ok) {
        try {
            const json = await res.json();
            const text = json?.choices?.[0]?.message?.content?.trim();
            if (text) return text;
            throw new Error('empty response');
        } catch (e) {
            throw new Error(`bad response (${e.message})`);
        }
    }
    if (res.status === 429) throw new Error('rate-limited (429)');
    if (res.status >= 500) throw new Error(`server error (${res.status})`);

    // Only the first model gets the GET fallback to keep total wait reasonable.
    if (!allowGetFallback) throw new Error(`status ${res.status}`);

    try {
        const conv = messages.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
        const prompt = `${system}\n\n${conv}\nMia:`;
        const url = `${POLLINATIONS_GET}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(model)}`;
        const getRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!getRes.ok) throw new Error(`status ${getRes.status}`);
        const text = (await getRes.text()).trim();
        if (text) return text;
        throw new Error('empty response');
    } catch (e) {
        throw new Error(humanFetchError(e));
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function humanFetchError(e) {
    const msg = (e && e.message) || String(e);
    if (/abort|timeout/i.test(msg)) return 'request timed out';
    if (/Failed to fetch|NetworkError|CORS/i.test(msg)) return 'network or CORS error';
    return msg;
}
