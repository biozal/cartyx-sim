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
  /**
   * Sent as `reasoning_effort`. "none" turns thinking off where the server and model honour it
   * (Ollama's qwen3 does), which makes short structured replies such as the checker's fast. Some
   * do not: LM Studio's MLX Qwen3.8-27B thinks just as long with it. Unset leaves the server's
   * default.
   */
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** Tried in order when the primary target fails. */
  fallbacks: z.array(ModelTarget).default([]),
});
export type SeatConfig = z.output<typeof SeatConfig>;
export type SeatConfigInput = z.input<typeof SeatConfig>;

/**
 * Convert a provider name like 'cartyx-sim' to camelCase 'cartyxSim' for use as the key in AI SDK
 * provider options. `@ai-sdk/openai-compatible` reads options under the camelCase provider name
 * and sends the contents as `reasoning_effort`; the raw provider-name key is deprecated.
 */
function toCamelCase(name: string): string {
  return name.split(/[-_]/).reduce((acc, part, index) => {
    if (index === 0) return part;
    return acc + part.charAt(0).toUpperCase() + part.slice(1);
  });
}

/**
 * AI SDK provider options that carry a seat's reasoning effort. `@ai-sdk/openai-compatible` reads
 * `reasoningEffort` under the camelCase provider name and sends it as `reasoning_effort`.
 * The key uses camelCase (e.g. 'cartyxSim') to avoid a deprecation warning.
 */
export function reasoningProviderOptions(
  providerName: string,
  reasoningEffort: SeatConfig['reasoningEffort']
): Record<string, Record<string, string>> | undefined {
  return reasoningEffort ? { [toCamelCase(providerName)]: { reasoningEffort } } : undefined;
}
