// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 6 tool calls per turn.
//
// Phase 3.3 hardening:
//   - Detect both `TOOL: name {...}` AND bare `name {...}` lines, but
//     only count the bare form as a call when `name` is in the live
//     registry. 8B models occasionally drop the TOOL: prefix; without
//     this we'd let them invent numbers from "memory" of what the tool
//     might return.
//   - Strict markdown-tolerant prefix handling preserved.
//   - Registry validation, intra-turn pacing, code-fence-tolerant JSON
//     parsing all preserved from earlier hardening.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection, listTools } from './tools.js';

const MAX_TOOL_CALLS = 6;
const INTRA_TURN_PACE_MS = 350;

// `TOOL: name {...}` form — the documented contract.
const TOOL_LINE_RE = /^[\s>*\-]*\**\s*TOOL:\s*([a-z][a-z0-9_]{2,})\s*(\{[\s\S]*?\})?\s*\**[\s>]*$/im;

// Bare `name {...}` form — fallback for when 8B drops the prefix.
// Built lazily once we know the registry so we can constrain the name to
// known tools (otherwise random words like "function" would match).
function buildBareToolRegex(toolNames) {
    const escaped = [...toolNames]
        .filter(n => /^[a-z][a-z0-9_]{2,}$/.test(n))
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length); // longest first to avoid prefix steal
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

            // Prefer the documented TOOL: form, fall back to bare-name detection.
            const m = buffer.match(TOOL_LINE_RE) || (bareRe ? buffer.match(bareRe) : null);
            if (m) { toolMatch = m; interrupted = true; break; }

            const lastNl = buffer.lastIndexOf('\n');
            if (lastNl > yieldedUpTo) {
                const safe = buffer.slice(yieldedUpTo, lastNl + 1);
                yieldedUpTo = lastNl + 1;
                const cleanedSafe = safe.replace(TOOL_LINE_STRIPPER, '');
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
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
