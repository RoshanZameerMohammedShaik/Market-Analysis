// Mia's LLM client.
//
// Backends:
//   - 'pollinations' (default): Free, keyless, multiple models. Auto-falls
//     back across models on 429 / 5xx because the rate limit is per-model.
//   - 'openai' (BYOK): User's key. Single try, no fallback.
//
// Why not Hugging Face: hosted Llama / Mistral are gated; anonymous
// browser calls fail CORS. Forcing every user to sign up defeats "free."
// Why not Anthropic: Anthropic's API blocks browser CORS.

const POLLINATIONS_OAI = 'https://text.pollinations.ai/openai';
const POLLINATIONS_GET = 'https://text.pollinations.ai';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

export const POLLINATIONS_MODELS = {
    'openai-large':     { label: 'GPT-4o (heaviest balanced)',     desc: 'GPT-4o class. Strong reasoning, good instruction-following. Default.' },
    'openai':           { label: 'GPT-4o mini (fast)',              desc: 'Smaller GPT-4o. Faster, lighter. Good for quick questions.' },
    'openai-reasoning': { label: 'o1-mini (deep reasoning)',         desc: 'OpenAI o1-mini class. Slower, best for multi-step analysis.' },
    'llama':            { label: 'Llama 3.3 70B',                    desc: 'Open-weight 70B model from Meta. Strong general-purpose.' },
    'mistral':          { label: 'Mistral Large',                    desc: 'Mistral\'s flagship. Strong reasoning + instruction-following.' },
    'qwen-coder':       { label: 'Qwen 2.5 Coder 32B',               desc: 'Tuned for code and structured output. Good for technical Qs.' },
    'deepseek':         { label: 'DeepSeek V3',                      desc: 'Strong reasoning, especially math + analysis.' },
};
export const POLLINATIONS_DEFAULT = 'openai-large';

// Fallback order when the user's chosen model rate-limits or errors.
// Hand-picked to favor models that are typically less loaded.
const FALLBACK_ORDER = ['openai-large', 'llama', 'deepseek', 'mistral', 'openai', 'qwen-coder'];

export async function callLLM({ system, messages, settings }) {
    const backend = settings?.backend || 'pollinations';
    if (backend === 'openai' && settings?.openaiKey) {
        return { reply: await callOpenAI(system, messages, settings.openaiKey), model: OPENAI_MODEL };
    }
    const chosen = settings?.pollinationsModel || POLLINATIONS_DEFAULT;
    return callPollinationsWithFallback(system, messages, chosen);
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

async function callPollinationsWithFallback(system, messages, chosen) {
    const order = [chosen, ...FALLBACK_ORDER.filter(m => m !== chosen)];
    const errors = [];

    for (let i = 0; i < order.length; i++) {
        const model = order[i];
        try {
            const reply = await callPollinationsOnce(system, messages, model, /*allowGetFallback=*/ i === 0);
            return { reply, model };
        } catch (e) {
            errors.push(`${model}: ${e.message}`);
            // Don't retry on user-cancelled / non-retryable conditions.
            if (/abort/i.test(e.message)) break;
            // Brief backoff before trying the next model so we're not
            // hammering an already-overloaded shared service.
            if (i < order.length - 1) await sleep(800);
        }
    }
    throw new Error(`All free models busy. Tried ${order.length} (${errors.length} errors). Wait ~30s and retry, or switch to OpenAI BYOK in settings.`);
}

async function callPollinationsOnce(system, messages, model, allowGetFallback) {
    // POST to OpenAI-compatible endpoint.
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

    // Only the user's chosen model gets the GET fallback — it can sometimes
    // succeed when the POST endpoint rejects. For the auto-fallback chain
    // we keep latency reasonable by skipping it.
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

export async function pingBackend(settings) {
    try {
        const { reply, model } = await callLLM({
            system: 'Reply with exactly the word: pong.',
            messages: [{ role: 'user', content: 'ping' }],
            settings,
        });
        const chosen = settings?.pollinationsModel || POLLINATIONS_DEFAULT;
        const note = model !== chosen && settings?.backend === 'pollinations' ? ` (fell back from ${chosen})` : '';
        return { ok: true, msg: `OK — ${model}${note} responded: "${reply.slice(0, 60)}"` };
    } catch (e) {
        return { ok: false, msg: e.message || String(e) };
    }
}
