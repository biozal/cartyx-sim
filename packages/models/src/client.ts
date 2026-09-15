import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelClient, ModelRequest, ModelResponse } from '@cartyx-sim/core';
import { generateText } from 'ai';
import { toInstructions, toModelMessages, toToolCalls, toToolSet } from './messages';
import {
  reasoningProviderOptions,
  SeatConfig,
  type ModelTarget,
  type SeatConfigInput,
} from './seat';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROVIDER_NAME = 'cartyx-sim';

/** A reply with nothing usable (no text, no tool calls) or one cut off by the output-token limit. */
function isIncompleteReply(response: ModelResponse, finishReason: string): boolean {
  return (
    (response.text.trim() === '' && response.toolCalls.length === 0) || finishReason === 'length'
  );
}

/**
 * A `ModelClient` for OpenAI-compatible servers, one configuration per seat. Each call tries the
 * seat's primary target, then its fallbacks in order; the engine's director handles retry delays
 * and pausing when every target fails. When `request.incompleteReplyAttempts` is set, an empty or
 * cut-off reply from a target is retried on that same target before moving to the next.
 */
export class OpenAICompatibleModelClient implements ModelClient {
  private readonly seats: ReadonlyMap<string, SeatConfig>;

  constructor(seats: Record<string, SeatConfigInput>) {
    this.seats = new Map(Object.entries(seats).map(([id, seat]) => [id, SeatConfig.parse(seat)]));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const seat = this.seats.get(request.seat);
    if (!seat) throw new Error(`No model is configured for seat "${request.seat}".`);
    const failures: string[] = [];
    // Clamped so a 0 (or otherwise non-positive) value still makes one call per target instead of
    // throwing with no failures to report.
    const attempts = Math.max(1, request.incompleteReplyAttempts ?? 1);
    for (const target of [seat, ...seat.fallbacks]) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        let outcome: { response: ModelResponse; finishReason: string };
        try {
          outcome = await this.generate(seat, target, request);
        } catch (error) {
          // A deliberate abort (e.g. shutdown) is not an endpoint failure; do not fall back.
          if (request.signal?.aborted) throw error;
          failures.push(`${target.model} at ${target.endpoint.baseURL}: ${errorMessage(error)}`);
          break;
        }
        if (
          !request.incompleteReplyAttempts ||
          !isIncompleteReply(outcome.response, outcome.finishReason)
        ) {
          return outcome.response;
        }
        failures.push(
          `${target.model} at ${target.endpoint.baseURL}: incomplete reply (finish: ${outcome.finishReason})`
        );
      }
    }
    // No seat prefix here: the director adds one (`Seat "<seat>" failed: ...`) when it wraps this
    // in a SessionPausedError, so naming the seat at both layers would repeat it in the message.
    throw new Error(`Every endpoint failed: ${failures.join('; ')}`);
  }

  private async generate(
    seat: SeatConfig,
    target: ModelTarget,
    request: ModelRequest
  ): Promise<{ response: ModelResponse; finishReason: string }> {
    const provider = createOpenAICompatible({
      name: PROVIDER_NAME,
      baseURL: target.endpoint.baseURL,
      apiKey: target.endpoint.apiKey,
    });
    const timeout = AbortSignal.timeout(seat.timeoutMs);
    const hasTools = request.tools.length > 0;
    const result = await generateText({
      model: provider.chatModel(target.model),
      instructions: toInstructions(request.messages),
      messages: toModelMessages(request.messages),
      tools: hasTools ? toToolSet(request.tools) : undefined,
      toolChoice: hasTools ? (seat.toolChoice ?? request.toolChoice) : undefined,
      temperature: seat.temperature,
      maxOutputTokens: seat.maxOutputTokens,
      providerOptions: reasoningProviderOptions(PROVIDER_NAME, seat.reasoningEffort),
      // The director owns retries (with delays, then a resumable pause).
      maxRetries: 0,
      abortSignal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
    });
    return {
      response: { text: result.text, toolCalls: toToolCalls(result.toolCalls) },
      finishReason: result.finishReason,
    };
  }
}
