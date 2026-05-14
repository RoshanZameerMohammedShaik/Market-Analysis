// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 5 tool calls per turn.
//
// Protocol: Mia outputs a line beginning with TOOL: <name> <json-args>.
// We pause her stream, run the tool, and inject a synthetic message of
// role:user content:"RESULT: ..." so the next iteration can continue.
//
// Streaming subtlety: we buffer each delta against an active line. If
// the line ends up being a TOOL: line, we never yield it as visible
// content. If it ends up being a normal line, we yield the buffered
// deltas in order. This prevents the user from seeing raw tool calls.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection } from './tools.js';

const MAX_TOOL_CALLS = 5;
const TOOL_LINE_RE = /^TOOL:\s*([a-z_][a-z0-9_]*)\s*(\{[\s\S]*?\})?\s*$/im;

export async function* runTurn({ system, messages, signal, onProgress }) {
    const fullSystem = `${system}\n\n${toolPromptSection()}`;
    let workingMessages = [...messages];
    let toolCalls = 0;

    while (true) {
        let buffer = '';                 // entire response so far this iteration
        let lineBuffer = '';             // current incomplete line, may become a tool call
        let yieldedUpTo = 0;             // how many chars of `buffer` we've emitted as deltas
        let toolMatch = null;
        let interrupted = false;

        for await (const delta of llmStream({ system: fullSystem, messages: workingMessages, signal, onProgress })) {
            buffer += delta;
            lineBuffer += delta;

            // If a TOOL: line matches in the buffer, stop streaming and act.
            const m = buffer.match(TOOL_LINE_RE);
            if (m) {
                toolMatch = m;
                interrupted = true;
                break;
            }

            // Determine what's safely yieldable: anything before the LAST
            // newline in the buffer can't possibly be a future TOOL: line.
            const lastNl = buffer.lastIndexOf('\n');
            if (lastNl > yieldedUpTo) {
                const safe = buffer.slice(yieldedUpTo, lastNl + 1);
                yieldedUpTo = lastNl + 1;
                // Strip a TOOL: line that may have appeared earlier (rare).
                const cleanedSafe = safe.replace(/^TOOL:.*$/gim, '');
                if (cleanedSafe) yield { type: 'delta', text: cleanedSafe };
            }
        }

        if (!interrupted) {
            // Drain remaining buffer.
            if (yieldedUpTo < buffer.length) {
                const rest = buffer.slice(yieldedUpTo).replace(/^TOOL:.*$/gim, '');
                if (rest) yield { type: 'delta', text: rest };
            }
            return;
        }

        // Tool call detected.
        const name = toolMatch[1];
        let args = {};
        try { args = toolMatch[2] ? JSON.parse(toolMatch[2]) : {}; } catch (_) { /* */ }

        if (onProgress) onProgress(`calling ${name}…`);
        yield { type: 'tool', name, args };

        const { ok, result, error } = await runTool(name, args);
        const resultText = ok ? JSON.stringify(result).slice(0, 4000) : `error: ${error}`;

        // Save a CLEAN version of the assistant's partial output (TOOL: line
        // stripped) so the next turn doesn't re-trigger it.
        const cleanedAssistant = buffer.replace(/^TOOL:.*$/gim, '').trim();
        workingMessages = [
            ...workingMessages,
            { role: 'assistant', content: cleanedAssistant || '(calling tool)' },
            { role: 'user', content: `RESULT: ${resultText}` },
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
