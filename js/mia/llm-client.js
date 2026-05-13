// Mia's LLM client. Two backends:
//   - HuggingFace Inference API (free, no key, default).
//     Uses a small instruction-tuned model. Slower, occasionally cold.
//   - OpenAI Chat Completions (BYOK, paid by user, fast).
// Anthropic Messages API would be ideal but blocks browser CORS, so
// it's not offered as an in-browser option.

const HF_MODEL = 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

export async function callLLM({ system, messages, settings }) {
    const backend = settings?.backend || 'hf';
    if (backend === 'openai' && settings?.openaiKey) {
        return callOpenAI(system, messages, settings.openaiKey);
    }
    return callHuggingFace(system, messages);
}

async function callOpenAI(system, messages, apiKey) {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: system },
                ...messages,
            ],
            temperature: 0.3,
            max_tokens: 600,
        }),
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '(empty response)';
}

async function callHuggingFace(system, messages) {
    // Build a Mistral-style instruction-tuned prompt with explicit roles.
    const conv = messages.map(m => `${m.role === 'user' ? '[USER]' : '[ASSISTANT]'} ${m.content}`).join('\n');
    const prompt = `<s>[INST] ${system}\n\nConversation so far:\n${conv}\n\nRespond as Mia. Keep it focused. [/INST]`;

    const res = await fetch(HF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 500, temperature: 0.4, return_full_text: false },
            options: { wait_for_model: true },
        }),
        signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 503) throw new Error('Mia\'s model is warming up. Try again in 10-20 seconds.');
        throw new Error(`HuggingFace error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const text = Array.isArray(json) ? json[0]?.generated_text : json.generated_text;
    return (text || '(empty response)').trim();
}
