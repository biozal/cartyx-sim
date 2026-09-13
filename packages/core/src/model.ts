import { z } from 'zod';

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ModelResponse = z.object({
  text: z.string().default(''),
  toolCalls: z.array(ToolCall).default([]),
});
export type ModelResponse = z.output<typeof ModelResponse>;

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  /** Seat id from the campaign config, e.g. "dm" or "player-kira". */
  seat: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export const LoreHit = z.object({
  chunkId: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  text: z.string(),
  score: z.number(),
});
export type LoreHit = z.infer<typeof LoreHit>;

export interface LoreIndex {
  search(query: string, limit: number): Promise<LoreHit[]>;
}
