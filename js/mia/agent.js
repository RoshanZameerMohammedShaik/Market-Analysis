// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 6 tool calls per turn
// (raised from 5 to make room for the larger toolset).
//
// Protocol: Mia outputs a line beginning with TOOL: <name> <json-args>.
// We pause her stream, run the tool, and inject a synthetic message of
// role:user content:"RESULT: ..." so the next iteration can continue.
//
// Streaming: we buffer each delta against the active line. If the line
// ends up being a TOOL: line, we never yield it as visible content. If
// it ends up being normal prose, we yield the buffered deltas in order.
//
// Phase 3 additions:
//   - emit ev.kind ('read'|'control') so the UI can show a different
//     badge for control tools.
//   - tag tool RESULT origin in the synthetic user message so the guard
//     downstream can verify that numbers came from a real tool path.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection } from './tools.js';

const MAX_TOOL_CALLS = 6;
const TOOL_LINE_RE = /^TOOL:\s*([a-z_][a-z0-9_]*)\s*(\{[\s\S]*?\})?\s*$/im;

export async function* runTurn({ system, messages, signal, onProgress }) {
    const fullSystem = `${system}\n\n${toolPromptSection()}`;
    let workingMessages = [...messages];
    let toolCalls = 0;

    while (true) {
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
                const cleanedSafe = safe.replace(/^TOOL:.*$/gim, '');
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
        }

        if (!interrupted) {
            if (yieldedUpTo < buffer.length) {
                const rest = buffer.slice(yieldedUpTo).replace(/^TOOL:.*$/gim, '');
                if (rest) yield { type: 'delta', text: rest };
            }
            return;
        }

        const name = toolMatch[1];
        let args = {};
        try { args = toolMatch[2] ? JSON.parse(toolMatch[2]) : {}; } catch (_) {}

        if (onProgress) onProgress(`calling ${name}…`);

        const { ok, result, error, kind } = await runTool(name, args);
        yield { type: 'tool', name, args, kind: kind || 'read' };

        const resultText = ok ? JSON.stringify(result).slice(0, 4000) : `error: ${error}`;

        const cleanedAssistant = buffer.replace(/^TOOL:.*$/gim, '').trim();
        workingMessages = [
            ...workingMessages,
            { role: 'assistant', content: cleanedAssistant || '(calling tool)' },
            { role: 'user', content: `RESULT (from ${name}): ${resultText}` },
        ];

        toolCalls++;
        if (toolCalls >= MAX_TOOL_CALLS) {
            yield { type: 'delta', text: '\n\n_(reached tool-call limit; finalizing answer)_' };
            for await (const delta of llmStream({
                system: fullSystem + '\n\nNo more tools. Write the final answer using only the context and tool results above.',
                messages: workingMessages,
                signal,
                onProgress,
            })) {
                yield { type: 'delta', text: delta.replace(/^TOOL:.*$/gim, '') };
            }
            return;
        }
    }
}
