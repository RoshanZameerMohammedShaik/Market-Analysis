// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 6 tool calls per turn.
//
// Phase 3.1 hardening (this file):
//
// 1. Strict tool-call regex.
//    The 8B model often wraps the call in markdown: leading bullets,
//    bold markers, indentation, trailing punctuation. Old pattern would
//    partially match (e.g. capture 'get' from `**TOOL: get_market_conditions ...`).
//    New pattern is anchored to a line, tolerates `**`/`*`/`-`/`>` prefixes
//    and any whitespace, and requires the full snake_case tool name.
//
// 2. Registry validation before dispatch.
//    If the model emits an unknown tool name, we don't dispatch garbage.
//    Instead we inject a clean error into the loop ('no such tool, valid
//    tools are X, Y, Z') so the model can retry with the correct name.
//
// 3. Rate-limit pacing inside a turn.
//    Free-tier Groq is 30 RPM enforced as a sliding window. A tool-use
//    turn can fire 4–6 calls in under a second — enough to trip the
//    limit even though the daily budget is fine. We sleep 350ms between
//    consecutive LLM calls within a turn to keep us comfortably under
//    30 RPM in the worst case (~3 RPS × 60s = 180/min, still capped by
//    server-side; this just smooths bursts).
//
// 4. JSON args parsing tolerates code-fences and stray prose around the
//    JSON object.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection, listTools } from './tools.js';

const MAX_TOOL_CALLS = 6;
const INTRA_TURN_PACE_MS = 350;

// Strict tool-call regex.
//   Optional markdown prefix:  ** , *, -, >, whitespace
//   TOOL: <snake_case_name>
//   Optional JSON object
//   Optional trailing markdown / whitespace
const TOOL_LINE_RE = /^[\s>*\-]*\**\s*TOOL:\s*([a-z][a-z0-9_]{2,})\s*(\{[\s\S]*?\})?\s*\**[\s>]*$/im;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJsonObject(raw) {
    if (!raw) return {};
    const trimmed = raw.trim();
    // Strip leading/trailing fences if present (e.g. ```json {...} ``` ).
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
    const candidate = fenced ? fenced[1] : trimmed;
    try { return JSON.parse(candidate); } catch (_) {}
    // Attempt to extract the first balanced { ... } block.
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

export async function* runTurn({ system, messages, signal, onProgress }) {
    const fullSystem = `${system}\n\n${toolPromptSection()}`;
    const knownToolNames = new Set(listTools().map(t => t.name));
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

            const m = buffer.match(TOOL_LINE_RE);
            if (m) { toolMatch = m; interrupted = true; break; }

            const lastNl = buffer.lastIndexOf('\n');
            if (lastNl > yieldedUpTo) {
                const safe = buffer.slice(yieldedUpTo, lastNl + 1);
                yieldedUpTo = lastNl + 1;
                const cleanedSafe = safe.replace(/^[\s>*\-]*\**\s*TOOL:.*$/gim, '');
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
        }

        if (!interrupted) {
            if (yieldedUpTo < buffer.length) {
                const rest = buffer.slice(yieldedUpTo).replace(/^[\s>*\-]*\**\s*TOOL:.*$/gim, '');
                if (rest) yield { type: 'delta', text: rest };
            }
            return;
        }

        const name = toolMatch[1];
        const argsRaw = toolMatch[2];
        const args = extractJsonObject(argsRaw);

        // Validate against registry BEFORE dispatching, so a malformed name
        // produces a clean retry path instead of an Unknown-tool dead-end.
        if (!knownToolNames.has(name)) {
            const valid = [...knownToolNames].slice(0, 12).join(', ');
            const fixerMsg = `RESULT (from agent): no tool named '${name}'. Valid tools include: ${valid}. Re-emit the call using one of those names exactly, on its own line, with the format: TOOL: tool_name {"arg": "value"}`;
            const cleanedAssistant = buffer.replace(/^[\s>*\-]*\**\s*TOOL:.*$/gim, '').trim();
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

        const cleanedAssistant = buffer.replace(/^[\s>*\-]*\**\s*TOOL:.*$/gim, '').trim();
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
                yield { type: 'delta', text: delta.replace(/^[\s>*\-]*\**\s*TOOL:.*$/gim, '') };
            }
            return;
        }
    }
}
