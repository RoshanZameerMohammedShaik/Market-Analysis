// Silent tier promotion router.
//
// Strategy: start every Groq turn on llama-3.1-8b-instant (cheap, fast, big TPD
// budget). Buffer the first part of the stream WITHOUT yielding to the consumer.
// As soon as we can tell whether the model is about to call a tool, decide:
//
//   - If tool intent detected (`TOOL:` or a known tool-name + `{`):
//       silently abort the 8B stream, re-run the SAME messages on 70B, then
//       yield from the 70B stream. The user sees nothing of the 8B attempt.
//
//   - If plain prose detected (more than DECISION_PROSE_CHARS without any tool
//     marker):
//       commit to 8B, flush the buffered prose to the consumer, and continue
//       streaming 8B to the end.
//
//   - If neither signal arrives before DECISION_TIMEOUT_MS:
//       safe-default to 70B (rare; means 8B is being slow about anything).
//
// User experience: a slight thinking delay (~150-300ms typical), then either:
//   - clean prose answer (8B path)
//   - clean tool call routed via 70B (smarter tool adherence)
//
// Token cost: when we promote, we waste whatever 8B emitted before the
// decision (typically <50 chars / ~15 tokens). Net win because plain Q&A
// stays on 8B and tool-heavy turns get the smart model.
//
// thinking-mode users skip the router entirely — they explicitly want 70B.

import * as groq from './backends/api-groq.js';
import { listTools } from './tools.js';

const DECISION_PROSE_CHARS = 60;     // confident enough it's not a tool call
const DECISION_TIMEOUT_MS = 1200;    // safety: never buffer longer than this
const HARD_TOKEN_FLUSH = 200;        // hard ceiling on chars we ever buffer

// Build a tool-intent detector keyed on the live registry. We require
// either an explicit `TOOL:` marker, or a known tool name immediately
// followed by `{` on the same line. This prevents false positives on
// English prose mentioning a tool name.
let _intentRe = null;
function buildIntentRe() {
    if (_intentRe) return _intentRe;
    const names = listTools()
        .map(t => t.name)
        .filter(n => /^[a-z][a-z0-9_]{2,}$/.test(n))
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    const namesRe = names.join('|');
    // Match either:  ...TOOL: <known>...   or   <known>{   (start-of-line-ish)
    _intentRe = new RegExp(`(?:TOOL:\\s*(?:${namesRe}))|(?:^|\\n)\\s*(?:${namesRe})\\s*\\{`, 'i');
    return _intentRe;
}

function isAuthError(err) {
    return err?.status === 401 || err?.status === 403;
}
function isRateLimit(err) {
    return err?.status === 429;
}

/**
 * Stream Mia output with silent tier promotion.
 *
 * @param {object} opts
 * @param {string} opts.system
 * @param {{role: string, content: string}[]} opts.messages
 * @param {string} opts.key                  Groq API key
 * @param {AbortSignal} opts.signal
 * @param {(msg: any) => void} [opts.onProgress]
 */
export async function* smartStream({ system, messages, key, signal, onProgress }) {
    const intentRe = buildIntentRe();

    // Stage 1: start an 8B stream with its own abort controller. We will
    // forcibly cancel it if we decide to promote.
    const lowAbort = new AbortController();
    const onParentAbort = () => lowAbort.abort();
    if (signal) {
        if (signal.aborted) lowAbort.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let buffer = '';
    let committed = false;     // committed to 8B; pass-through mode
    let promoting = false;     // committed to 70B; switch streams
    const decideStart = Date.now();

    try {
        const lowStream = groq.stream({
            system, messages, key,
            signal: lowAbort.signal,
            tier: 'default',
        });

        for await (const delta of lowStream) {
            if (committed) {
                yield delta;
                continue;
            }
            buffer += delta;

            // Decision check 1: tool intent?
            if (intentRe.test(buffer)) {
                promoting = true;
                lowAbort.abort();
                break;
            }
            // Decision check 2: enough plain prose to be confident?
            const elapsed = Date.now() - decideStart;
            if (
                buffer.length >= DECISION_PROSE_CHARS
                || elapsed >= DECISION_TIMEOUT_MS
                || buffer.length >= HARD_TOKEN_FLUSH
            ) {
                if (intentRe.test(buffer)) {
                    promoting = true;
                    lowAbort.abort();
                    break;
                }
                // Commit to 8B. Flush whatever we buffered as a single delta,
                // then continue passing through.
                committed = true;
                yield buffer;
                buffer = '';
            }
        }

        if (committed) {
            // Stream already drained on 8B; we're done.
            return;
        }

        if (!promoting) {
            // 8B finished within the buffer window. Whatever we have IS the
            // whole answer (or empty). Flush.
            if (buffer) yield buffer;
            return;
        }
    } catch (err) {
        // 8B failed before we made a decision. If it's auth-level, surface;
        // otherwise promote to 70B, since it's the more reliable model anyway.
        if (signal) signal.removeEventListener('abort', onParentAbort);
        if (isAuthError(err)) throw err;
        // For rate-limit or network errors, promote silently.
        promoting = true;
        buffer = '';
        if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });
    } finally {
        if (signal) signal.removeEventListener('abort', onParentAbort);
    }

    // Stage 2: promote to 70B with the SAME messages. The user has seen
    // nothing yet, so they perceive this as the whole turn.
    if (signal?.aborted) return;
    if (onProgress) onProgress({ phase: 'thinking', percent: 100, friendly: 'thinking…' });

    for await (const delta of groq.stream({
        system, messages, key,
        signal,
        tier: 'thinking',
    })) {
        yield delta;
    }
}
