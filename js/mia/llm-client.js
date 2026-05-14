// Mia's LLM client — AI Horde (free, keyless, browser-CORS-friendly).
//
// AI Horde is a volunteer-GPU pool. Anonymous users use the documented
// public api key '0000000000' which gives lowest priority. The slow_workers
// flag below skips the slowest GPUs by default to keep latency bearable.
//
// API flow: async submit → poll status until done=true.

const ANON_KEY = '0000000000';
const CLIENT_AGENT = 'market-analyzer/1.0:RoshanZameerMohammedShaik';
const HORDE = 'https://stablehorde.net/api/v2';
const MAX_HISTORY_TURNS = 6;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 100; // ~5 min ceiling

export async function callLLM({ system, messages, onProgress }) {
    const recent = messages.slice(-MAX_HISTORY_TURNS * 2);
    const conv = recent.map(m => `${m.role === 'user' ? 'User' : 'Mia'}: ${m.content}`).join('\n');
    const prompt = `### Instruction:\n${system}\n\nConversation:\n${conv}\n\nReply as Mia in 3-6 short sentences. Do not invent numbers.\n\n### Response:\n`;

    if (onProgress) onProgress('thinking…');

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
                // 200 is plenty for 3-6 sentences. The previous 400 doubled
                // generation time and encouraged the model to waffle.
                max_length: 200,
                max_context_length: 4096,
                temperature: 0.3,
                top_p: 0.95,
                rep_pen: 1.1,
            },
            // Skip the slowest workers — lower queue priority but much
            // better wall-clock time for short replies.
            slow_workers: false,
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

    for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS);
        let status;
        try {
            const r = await fetch(`${HORDE}/generate/text/status/${id}`, {
                headers: { 'Client-Agent': CLIENT_AGENT },
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) {
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
            if (status.processing > 0) onProgress('generating…');
            else if (typeof status.queue_position === 'number' && status.queue_position > 0) {
                onProgress(`queued (#${status.queue_position})…`);
            } else if (typeof status.wait_time === 'number' && status.wait_time > 0) {
                onProgress(`waiting for a worker (~${status.wait_time}s)…`);
            }
        }
    }

    throw new Error('AI Horde took too long. The volunteer pool may be overloaded — try again in a minute.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanReply(text) {
    const cut = text.split(/\n###\s*(Instruction|User|Conversation)/i)[0];
    return cut.replace(/^Mia:\s*/i, '').trim();
}
