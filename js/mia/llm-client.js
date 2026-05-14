// Mia's LLM client.
//
// Backend options (all free, all browser-friendly):
//   - 'pollinations' (default): Pollinations.ai. Free, no key, no signup,
//     permissive CORS. Multiple underlying models exposed via the
//     `model` parameter — see POLLINATIONS_MODELS below.
//   - 'openai' (BYOK): User's own OpenAI key. Fast, paid by user.
//
// Why not Hugging Face Inference: hosted Llama / Mistral models are
// gated (license + token required). Anonymous browser calls fail CORS
// preflight — surfaces as "Failed to fetch." Adding a token field is
// possible but the user wanted *truly* free, no signup.
//
// Why not Anthropic: Anthropic's Messages API blocks browser CORS.

const POLLINATIONS_OAI = 'https://text.pollinations.ai/openai';
const POLLINATIONS_GET = 'https://text.pollinations.ai';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

// Available free models on Pollinations. Keyed by the value we send in
// the `model` field. Order matters — settings UI iterates this map.
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

export async function callLLM({ system, messages, settings }) {
    const backend = settings?.backend || 'pollinations';
    if (backend === 'openai' && settings?.openaiKey) {
        return { reply: await callOpenAI(system, messages, settings.openaiKey), model: OPENAI_MODEL };
    }
    const model = settings?.pollinationsModel || POLLINATIONS_DEFAULT;
    return { reply: await callPollinations(system, messages, model), model };
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

async function callPollinations(system, messages, model) {
    // Try OpenAI-compatible POST first.
    try {
        const res = await fetch(POLLINATIONS_OAI, {
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
        if (res.ok) {
            const json = await res.json();
            const text = json?.choices?.[0]?.message?.content?.trim();
            if (text) return text;
        }
    } catch (_) { /* fall through */ }

    // Fallback: simple GET endpoint with URL-encoded combined prompt.
    try {
        const conv = messages.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
        const prompt = `${system}\n\n${conv}\nMia:`;
        const url = `${POLLINATIONS_GET}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(model)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = (await res.text()).trim();
        if (text) return text;
        throw new Error('empty response');
    } catch (e) {
        throw new Error(`Couldn't reach Mia's free backend (${humanFetchError(e)}). Try a different model in settings, or switch to OpenAI BYOK.`);
    }
}

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
        return { ok: true, msg: `OK — ${model} responded: "${reply.slice(0, 60)}"` };
    } catch (e) {
        return { ok: false, msg: e.message || String(e) };
    }
}
