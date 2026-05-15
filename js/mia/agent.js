// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 6 tool calls per turn.
//
// Phase 3.4 hardening: regex matches ONLY on complete buffers.
//
// Bug we hit: streaming chunks arrive partial. A buffer mid-stream like
// "TOOL: get_" would falsely match the old regex with name='get_' and
// no args, triggering an invalid-tool retry loop. Fixed by:
//   1. Requiring a closing `}` in the regex (no optional args group).
//   2. Only attempting the match when the buffer ends with `}`, `\n`, or
//      the stream has finished.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection, listTools } from './tools.js';

const MAX_TOOL_CALLS = 6;
const INTRA_TURN_PACE_MS = 350;

// `TOOL: name {complete_json}` — JSON is now REQUIRED for the match.
const TOOL_LINE_RE = /^[\s>*\-]*\**\s*TOOL:\s*([a-z][a-z0-9_]{2,})\s*(\{[\s\S]*?\})\s*\**[\s>]*$/im;

// Bare `name {complete_json}` — fallback when 8B drops the prefix.
function buildBareToolRegex(toolNames) {
    const escaped = [...toolNames]
        .filter(n => /^[a-z][a-z0-9_]{2,}$/.test(n))
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    if (!escaped.length) return null;
    return new RegExp(`^[\\s>*\\-]*\\**\\s*(${escaped.join('|')})\\s*(\\{[\\s\\S]*?\\})\\s*\\**[\\s>]*$`, 'im');
}

const TOOL_LINE_STRIPPER = /^[\s>*\-]*\**\s*(?:TOOL:.*|[a-z][a-z0-9_]+\s*\{[\s\S]*?\}.*)$/gim;

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

// Cheap pre-check: only worth running the full regex if the buffer
// plausibly contains a complete tool call (closing brace seen, or a
// newline after a `}`, or the buffer ends naturally).
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

        for await (const delta of llmStream({ system: fullSystem, messages: workingMessages, signal, onProgress })) {
            buffer += delta;

            // Only attempt to match tool calls when the buffer plausibly
            // contains a completed JSON object. Avoids matching partial
            // streams like 'TOOL: get_' as name='get_'.
            if (bufferLooksComplete(buffer)) {
                const m = buffer.match(TOOL_LINE_RE) || (bareRe ? buffer.match(bareRe) : null);
                if (m) { toolMatch = m; interrupted = true; break; }
            }

            const lastNl = buffer.lastIndexOf('\n');
            if (lastNl > yieldedUpTo) {
                const safe = buffer.slice(yieldedUpTo, lastNl + 1);
                yieldedUpTo = lastNl + 1;
                const cleanedSafe = safe.replace(TOOL_LINE_STRIPPER, '');
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
        }

        // Stream ended; final attempt to match a tool call on the whole buffer.
        if (!interrupted && buffer.length) {
            const m = buffer.match(TOOL_LINE_RE) || (bareRe ? buffer.match(bareRe) : null);
            if (m) { toolMatch = m; interrupted = true; }
        }

        if (!interrupted) {
            if (yieldedUpTo < buffer.length) {
                const rest = buffer.slice(yieldedUpTo).replace(TOOL_LINE_STRIPPER, '');
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
            const cleanedAssistant = buffer.replace(TOOL_LINE_STRIPPER, '').trim();
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

        const cleanedAssistant = buffer.replace(TOOL_LINE_STRIPPER, '').trim();
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
                yield { type: 'delta', text: delta.replace(TOOL_LINE_STRIPPER, '') };
            }
            return;
        }
    }
}
