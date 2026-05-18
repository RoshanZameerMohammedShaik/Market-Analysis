// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 6 tool calls per turn.
//
// Phase 5: builds TWO system prompts — one with the tool prompt section,
// one without — and passes both to the LLM client. The router uses the
// no-tools version for the prose path so 8B can't fabricate tool calls.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection, listTools } from './tools.js';

const MAX_TOOL_CALLS = 8;
const INTRA_TURN_PACE_MS = 350;

// Matches a TOOL: invocation anywhere in the buffer. Models sometimes emit it
// inline at the end of a prose sentence rather than on a fresh line, so we no
// longer anchor to ^.
const TOOL_LINE_RE = /(?:^|\s)TOOL:\s*([a-z][a-z0-9_]{2,})\s*(\{[\s\S]*?\})/i;

function buildBareToolRegex(toolNames) {
    const escaped = [...toolNames]
        .filter(n => /^[a-z][a-z0-9_]{2,}$/.test(n))
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    if (!escaped.length) return null;
    // Bare-name form must still anchor to start-of-line: too many false
    // positives otherwise (any prose sentence containing 'analyze {something}').
    return new RegExp(`^[\\s>*\\-]*\\**\\s*(${escaped.join('|')})\\s*(\\{[\\s\\S]*?\\})\\s*\\**[\\s>]*$`, 'im');
}

// Strip from any "TOOL:" through the end of the buffer (including everything
// after, since the tool call ends the model's prose for this iteration).
const TOOL_TAIL_STRIPPER = /(?:^|\s)TOOL:[\s\S]*$/im;
// Bare-name lines that look like tool invocations on their own line.
const BARE_TOOL_LINE_STRIPPER = /^[\s>*\-]*\**\s*[a-z][a-z0-9_]+\s*\{[\s\S]*?\}.*$/gim;
function stripToolNoise(s) {
    return s.replace(TOOL_TAIL_STRIPPER, '').replace(BARE_TOOL_LINE_STRIPPER, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJsonObject(raw) {
    if (!raw) return {};
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
    const candidate = fenced ? fenced[1] : trimmed;
    try { return JSON.parse(candidate); } catch (_) {}
    const start = candidate.indexOf('{');
    if (start < 0) return {};
    let depth = 0;
    for (let i = start; i < candidate.length; i++) {
        if (candidate[i] === '{') depth++;
        else if (candidate[i] === '}') {
            depth--;
            if (depth === 0) {
                const slice = candidate.slice(start, i + 1);
                try { return JSON.parse(slice); } catch (_) { return {}; }
            }
        }
    }
    return {};
}

function bufferLooksComplete(buffer) {
    if (!buffer) return false;
    const trimmedEnd = buffer.replace(/\s+$/, '');
    return trimmedEnd.endsWith('}') || /\}\s*\n/.test(buffer) || buffer.endsWith('\n');
}

export async function* runTurn({ system, messages, signal, onProgress }) {
    const fullSystem = `${system}\n\n${toolPromptSection()}`;
    const knownToolNames = new Set(listTools().map(t => t.name));
    const bareRe = buildBareToolRegex(knownToolNames);
    let workingMessages = [...messages];
    let toolCalls = 0;
    let isFirstCall = true;

    while (true) {
        if (!isFirstCall) await sleep(INTRA_TURN_PACE_MS);
        isFirstCall = false;

        let buffer = '';
        let yieldedUpTo = 0;
        let toolMatch = null;
        let interrupted = false;

        for await (const delta of llmStream({
            system: fullSystem,
            // Prose path uses the bare system without tool section so 8B can't
            // hallucinate tool calls. Only matters on the first iteration when
            // intent=prose; subsequent iterations always go on the tool path.
            systemNoTools: isFirstCall ? system : fullSystem,
            messages: workingMessages,
            signal,
            onProgress,
        })) {
            buffer += delta;

            if (bufferLooksComplete(buffer)) {
                const m = buffer.match(TOOL_LINE_RE) || (bareRe ? buffer.match(bareRe) : null);
                if (m) { toolMatch = m; interrupted = true; break; }
            }

            // Once we see "TOOL:" anywhere, freeze yielding — the rest of the
            // buffer is the call args, not prose. We'll resume after the call.
            const toolMarker = buffer.search(/(?:^|\s)TOOL:/i);
            const safeUpTo = toolMarker >= 0 ? toolMarker : buffer.lastIndexOf('\n');
            if (safeUpTo > yieldedUpTo) {
                const safe = buffer.slice(yieldedUpTo, toolMarker >= 0 ? safeUpTo : safeUpTo + 1);
                yieldedUpTo = toolMarker >= 0 ? safeUpTo : safeUpTo + 1;
                const cleanedSafe = stripToolNoise(safe);
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
        }

        if (!interrupted && buffer.length) {
            const m = buffer.match(TOOL_LINE_RE) || (bareRe ? buffer.match(bareRe) : null);
            if (m) { toolMatch = m; interrupted = true; }
        }

        if (!interrupted) {
            if (yieldedUpTo < buffer.length) {
                const rest = stripToolNoise(buffer.slice(yieldedUpTo));
                if (rest) yield { type: 'delta', text: rest };
            }
            return;
        }

        const name = toolMatch[1];
        const argsRaw = toolMatch[2];
        const args = extractJsonObject(argsRaw);

        if (!knownToolNames.has(name)) {
            const valid = [...knownToolNames].slice(0, 12).join(', ');
            const fixerMsg = `RESULT (from agent): no tool named '${name}'. Valid tools include: ${valid}. Re-emit the call using one of those names exactly, on its own line, with the format: TOOL: tool_name {"arg": "value"}`;
            const cleanedAssistant = stripToolNoise(buffer).trim();
            workingMessages = [
                ...workingMessages,
                { role: 'assistant', content: cleanedAssistant || '(invalid tool call)' },
                { role: 'user', content: fixerMsg },
            ];
            toolCalls++;
            if (toolCalls >= MAX_TOOL_CALLS) {
                yield { type: 'delta', text: '\n\n_(too many invalid tool calls; stopping)_' };
                return;
            }
            continue;
        }

        if (onProgress) onProgress(`calling ${name}…`);

        const { ok, result, error, kind } = await runTool(name, args);
        yield { type: 'tool', name, args, kind: kind || 'read' };

        const resultText = ok ? JSON.stringify(result).slice(0, 4000) : `error: ${error}`;

        const cleanedAssistant = stripToolNoise(buffer).trim();
        workingMessages = [
            ...workingMessages,
            { role: 'assistant', content: cleanedAssistant || '(calling tool)' },
            { role: 'user', content: `RESULT (from ${name}): ${resultText}` },
        ];

        toolCalls++;
        if (toolCalls >= MAX_TOOL_CALLS) {
            yield { type: 'delta', text: '\n\n_(reached tool-call limit; finalizing answer)_' };
            await sleep(INTRA_TURN_PACE_MS);
            for await (const delta of llmStream({
                system: fullSystem + '\n\nNo more tools. Write the final answer using only the context and tool results above.',
                messages: workingMessages,
                signal,
                onProgress,
            })) {
                yield { type: 'delta', text: stripToolNoise(delta) };
            }
            return;
        }
    }
}
