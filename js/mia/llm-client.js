// Mia's LLM client — free, keyless, uses Pollinations GET endpoint.
//
// Why GET, not POST: Pollinations recently added a per-IP queue cap of 1
// to the POST endpoint. Anonymous browser calls 429 with "Queue full"
// instantly. The GET endpoint hits a different rate-limit pool and
// currently works.
//
// Why no fallback chain: every model on the POST endpoint shares the
// same per-IP queue, so retrying just keeps the queue blocked longer.
// Single shot is faster and clearer when it fails.
//
// Trade-offs of GET:
//   - Whole prompt rides in the URL path. Pollinations tolerates long
//     URLs but we cap conversation history to the last 8 turns.
//   - No streaming, no max_tokens control. The server picks length.

const POLLINATIONS_GET = 'https://text.pollinations.ai';
const MODEL = 'openai-large';
const MAX_HISTORY_TURNS = 8;

export async function callLLM({ system, messages }) {
    const recent = messages.slice(-MAX_HISTORY_TURNS * 2);
    const conv = recent.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
    const prompt = `${system}\n\n${conv}\nMia:`;
    const url = `${POLLINATIONS_GET}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(MODEL)}`;

    let res;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (/abort|timeout/i.test(msg)) throw new Error("Mia took too long to reply. Try again in a moment.");
        throw new Error(`Couldn't reach Mia (${msg}).`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429) {
            if (/queue full/i.test(body)) {
                throw new Error("Mia's free service is briefly rate-limiting your network. Wait ~30 seconds and try again.");
            }
            throw new Error('Rate-limited by the free service. Wait ~30s and retry.');
        }
        if (res.status >= 500) throw new Error(`Free service had an error (${res.status}). Try again shortly.`);
        throw new Error(`Free service returned ${res.status}.`);
    }

    const text = (await res.text()).trim();
    if (!text) throw new Error('Empty response from the free service.');
    return { reply: text, model: MODEL };
}
