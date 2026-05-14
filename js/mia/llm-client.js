// Mia's LLM client — AI Horde (free, keyless, browser-CORS-friendly).
//
// AI Horde is a volunteer-GPU pool. Anonymous users use the documented
// public api key '0000000000' which gives lowest priority (but the queue
// is usually short enough that it doesn't matter).
//
// Why AI Horde and not anyone else (verified in browser, 2026-05):
//   - Pollinations: POST 429 "Queue full" per-IP; GET 404 / 500 / timeouts.
//     They are deprecating the keyless tier.
//   - Cloudflare Workers AI public route: CORS-blocked.
//   - DeepInfra / Together / Groq: CORS works but require an API key.
//   - HuggingChat: CORS-blocked + cookie-auth.
//   AI Horde alone returned a real reply with no key, no signup, in ~3s.
//
// API flow: async submit → poll status until done=true.

const ANON_KEY = '0000000000';
const CLIENT_AGENT = 'market-analyzer/1.0:RoshanZameerMohammedShaik';
const HORDE = 'https://stablehorde.net/api/v2';
const MAX_HISTORY_TURNS = 6;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100; // ~5 minutes hard ceiling

/**
 * Send a message and wait for the reply.
 *
 * @param {{system: string, messages: Array<{role,content}>, onProgress?: (msg: string) => void}} args
 */
export async function callLLM({ system, messages, onProgress }) {
    const recent = messages.slice(-MAX_HISTORY_TURNS * 2);
    const conv = recent.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
    // AI Horde models are tuned on instruction-style prompts. Wrap in a clear
    // alpaca-style frame so off-the-shelf workers handle it well.
    const prompt = `### Instruction:\n${system}\n\nConversation:\n${conv}\n\nReply as Mia in 3-6 sentences.\n\n### Response:\n`;

    if (onProgress) onProgress('Mia is thinking…');

    const submit = await fetch(`${HORDE}/generate/text/async`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': ANON_KEY,
            'Client-Agent': CLIENT_AGENT,
        },
        body: JSON.stringify({
            prompt,
            params: {
                max_length: 400,
                max_context_length: 4096,
                temperature: 0.3,
                top_p: 0.95,
                rep_pen: 1.1,
            },
        }),
        signal: AbortSignal.timeout(20000),
    });

    if (!submit.ok) {
        const body = await submit.text().catch(() => '');
        if (submit.status === 429) throw new Error('AI Horde is briefly busy. Wait ~30s and try again.');
        if (submit.status === 401 || submit.status === 403) throw new Error('AI Horde rejected the anonymous key. Try again later.');
        throw new Error(`AI Horde returned ${submit.status}. ${body.slice(0, 160)}`);
    }

    const submitJson = await submit.json();
    const id = submitJson.id;
    if (!id) throw new Error(`AI Horde returned no request id: ${JSON.stringify(submitJson).slice(0, 160)}`);

    // Poll. AI Horde gives queue position, ETA, and a 'processing' flag
    // before the result lands. We surface those to the UI so the user
    // knows we're alive.
    for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS);
        let status;
        try {
            const r = await fetch(`${HORDE}/generate/text/status/${id}`, {
                headers: { 'Client-Agent': CLIENT_AGENT },
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) {
                // Transient — keep polling unless it's clearly fatal.
                if (r.status === 404) throw new Error('AI Horde lost the request. Try again.');
                continue;
            }
            status = await r.json();
        } catch (e) {
            if (i >= MAX_POLLS - 3) throw new Error(`Poll failed: ${e.message}`);
            continue;
        }

        if (status.faulted) throw new Error('The worker faulted mid-generation. Try again.');
        if (status.done) {
            const gen = status.generations?.[0];
            const text = (gen?.text || '').trim();
            if (!text) throw new Error('AI Horde returned an empty reply. Try again.');
            return {
                reply: cleanReply(text),
                model: gen?.model || 'unknown',
                worker: gen?.worker_name || 'unknown',
            };
        }

        if (onProgress) {
            if (status.processing > 0) onProgress('Mia is generating…');
            else if (typeof status.queue_position === 'number' && status.queue_position > 0) {
                onProgress(`Mia is queued (position ${status.queue_position})…`);
            } else if (typeof status.wait_time === 'number' && status.wait_time > 0) {
                onProgress(`Mia is waiting for a worker (~${status.wait_time}s)…`);
            }
        }
    }

    throw new Error('AI Horde took too long. The volunteer pool may be overloaded — try again in a minute.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanReply(text) {
    // Strip any trailing "### Instruction" continuations the model sometimes
    // hallucinates after the response.
    const cut = text.split(/\n###\s*(Instruction|User|Conversation)/i)[0];
    return cut.replace(/^Mia:\s*/i, '').trim();
}
