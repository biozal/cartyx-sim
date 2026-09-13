import { z } from 'zod';

/** An OpenAI-compatible server: LM Studio, llama.cpp `llama-server`, mlx_lm.server, vLLM, Ollama. */
export const Endpoint = z.object({
  /** Base URL including the `/v1` path, e.g. `http://192.168.1.20:1234/v1`. */
  baseURL: z.url(),
  apiKey: z.string().min(1).optional(),
});
export type Endpoint = z.infer<typeof Endpoint>;

export const ModelTarget = z.object({
  endpoint: Endpoint,
  model: z.string().min(1),
});
export type ModelTarget = z.infer<typeof ModelTarget>;

/** One seat's model: where to call, how, and what to fall back to when that endpoint fails. */
export const SeatConfig = ModelTarget.extend({
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Per-call timeout, including every fallback attempt's own call. Default 120 s. */
  timeoutMs: z.number().int().positive().default(120_000),
  /**
   * Overrides the engine's requested tool choice. The engine asks for "required", and a reply
   * without a tool call then counts as a failed attempt (fallback, retry, pause). Set "auto" for a
   * server that ignores "required", so a text-only reply is used as narration or speech instead.
   */
  toolChoice: z.enum(['auto', 'required']).optional(),
  /** Tried in order when the primary target fails. */
  fallbacks: z.array(ModelTarget).default([]),
});
export type SeatConfig = z.output<typeof SeatConfig>;
export type SeatConfigInput = z.input<typeof SeatConfig>;
