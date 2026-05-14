// Agent loop. Wraps the streaming LLM call to detect tool requests,
// execute them, and feed results back. Up to 5 tool calls per turn.
//
// Protocol: Mia outputs a line beginning with TOOL: <name> <json-args>.
// We pause her stream, run the tool, and inject a synthetic message of
// role:user content:"RESULT: ..." so the next iteration can continue.

import { stream as llmStream } from './llm-client.js';
import { runTool, toolPromptSection } from './tools.js';

const MAX_TOOL_CALLS = 5;

const TOOL_LINE_RE = /^TOOL:\s*([a-z_][a-z0-9_]*)\s*(\{[\s\S]*?\})?\s*$/im;

/**
 * Run a turn. yields { type: 'delta', text } and { type: 'tool', name, args, result }.
 */
export async function* runTurn({ system, messages, signal, onProgress }) {
    const fullSystem = `${system}\n\n${toolPromptSection()}`;
    let workingMessages = [...messages];
    let toolCalls = 0;

    while (true) {
        let buffer = '';
        let toolMatch = null;
        let interrupted = false;

        for await (const delta of llmStream({ system: fullSystem, messages: workingMessages, signal, onProgress })) {
            buffer += delta;
            // Detect a tool line as soon as we have one full line.
            // We only look at the most recent line.
            const match = buffer.match(TOOL_LINE_RE);
            if (match) {
                toolMatch = match;
                interrupted = true;
                break;
            }
            yield { type: 'delta', text: delta };
        }

        if (!interrupted) {
            // Finished without calling a tool.
            return;
        }

        // Yield the pre-tool text (everything before the TOOL line) as final delta.
        const toolLineStart = buffer.lastIndexOf('TOOL:');
        const preText = buffer.slice(0, toolLineStart).trim();
        // We've already yielded these deltas, so don't re-yield. Just stop streaming.

        const name = toolMatch[1];
        let args = {};
        try { args = toolMatch[2] ? JSON.parse(toolMatch[2]) : {}; } catch (_) { /* */ }

        if (onProgress) onProgress(`calling ${name}…`);
        yield { type: 'tool', name, args };

        const { ok, result, error } = await runTool(name, args);
        const resultText = ok ? JSON.stringify(result).slice(0, 4000) : `error: ${error}`;

        // Add the assistant's partial output (with the tool call line) and the result
        // back into the conversation so the model can continue.
        workingMessages = [
            ...workingMessages,
            { role: 'assistant', content: buffer.trim() },
            { role: 'user', content: `RESULT: ${resultText}` },
        ];

        toolCalls++;
        if (toolCalls >= MAX_TOOL_CALLS) {
            yield { type: 'delta', text: '\n\n_(reached tool-call limit; finalizing answer)_' };
            // Force one more turn without tools to let her summarize.
            for await (const delta of llmStream({
                system: fullSystem + '\n\nNo more tools. Write the final answer using only the context and tool results above.',
                messages: workingMessages,
                signal,
                onProgress,
            })) {
                yield { type: 'delta', text: delta };
            }
            return;
        }
    }
}
