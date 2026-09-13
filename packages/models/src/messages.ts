import type { ChatMessage, ToolCall, ToolSchema } from '@cartyx-sim/core';
import {
  jsonSchema,
  tool,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolSet,
} from 'ai';

/** The engine's system messages, joined; the AI SDK takes them as `instructions`, not messages. */
export function toInstructions(messages: readonly ChatMessage[]): string | undefined {
  const system = messages.filter((message) => message.role === 'system');
  return system.length > 0 ? system.map((message) => message.content).join('\n\n') : undefined;
}

export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        converted.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        const parts: (TextPart | ToolCallPart)[] = [];
        if (message.content) parts.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: call.args,
          });
        }
        converted.push({ role: 'assistant', content: parts.length > 0 ? parts : '' });
        break;
      }
      case 'tool':
        converted.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: { type: 'text', value: message.content },
            },
          ],
        });
        break;
    }
  }
  return converted;
}

/** Tools without `execute`, so the AI SDK returns the model's calls for the engine to run. */
export function toToolSet(tools: readonly ToolSchema[]): ToolSet {
  return Object.fromEntries(
    tools.map((schema) => [
      schema.name,
      tool({
        description: schema.description,
        inputSchema: jsonSchema(schema.parameters as Parameters<typeof jsonSchema>[0]),
      }),
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps AI SDK tool calls to the engine's. A call whose arguments did not parse as a JSON object
 * gets empty args, so the engine's schema check reports it back to the model as invalid.
 */
export function toToolCalls(
  calls: readonly { toolCallId: string; toolName: string; input: unknown }[]
): ToolCall[] {
  return calls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    args: isRecord(call.input) ? call.input : {},
  }));
}
