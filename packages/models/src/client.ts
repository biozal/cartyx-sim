import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelClient, ModelRequest, ModelResponse } from '@cartyx-sim/core';
import { generateText, ToolChoiceViolationError } from 'ai';
import { toInstructions, toModelMessages, toToolCalls, toToolSet } from './messages';
import {
  reasoningProviderOptions,
  SeatConfig,
  type ModelTarget,
  type SeatConfigInput,
} from './seat';
import { recoverTextToolCalls } from './text-tool-calls';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROVIDER_NAME = 'cartyx-sim';

/**
 * Below this many request characters a prompt is too small for the truncation check to tell a
 * server's tokenizer apart from a cut: short prompts carry proportionally more JSON framing.
 */
const TRUNCATION_MIN_CHARS = 8000;
/**
 * The fewest prompt tokens per request-body character a server reports when it read the whole
 * prompt. Measured on the avalon seats: ~0.25 when whole, ~0.105 when Ollama cut a 4300-token
 * prompt to its 4096-token context (it keeps about half and drops the front, system prompt
 * included). 0.15 sits between the two with margin on both sides.
 */
const TRUNCATION_TOKENS_PER_CHAR = 0.15;

/** What one call sent, and what the server says it read: the evidence for a truncated prompt. */
interface PromptSize {
  sentChars: number;
  promptTokens?: number;
}

/**
 * The prompt tokens a reply's usage says the server read. OpenAI counts cached tokens inside
 * `prompt_tokens` (LM Studio and Ollama agree, measured on the avalon seats); a server that reports
 * `cached_tokens` above `prompt_tokens` evidently counts them apart, so they are added back. A
 * zero is "not reported", not "read nothing".
 */
function promptTokensRead(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { prompt_tokens: prompt, prompt_tokens_details: details } = usage as {
    prompt_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  };
  if (typeof prompt !== 'number' || prompt <= 0) return undefined;
  const cached = details?.cached_tokens;
  return typeof cached === 'number' && cached > prompt ? prompt + cached : prompt;
}

/**
 * A fetch that records the request body's size and the reply's `usage.prompt_tokens`. The AI SDK
 * drops usage when it throws (a required tool call that never came), and that is exactly when a
 * truncated prompt needs diagnosing, so it is read off the wire instead.
 */
function measuringFetch(size: PromptSize): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') size.sentChars = init.body.length;
    const response = await fetch(input, init);
    try {
      const body = (await response.clone().json()) as { usage?: unknown };
      size.promptTokens = promptTokensRead(body.usage);
    } catch {
      // Not JSON (an error page, say): nothing to measure, and the SDK reports the failure itself.
    }
    return response;
  };
}

/**
 * Why a reply cannot be trusted when the server read far fewer prompt tokens than were sent.
 * Ollama silently truncates a prompt longer than the loaded context and drops the front, so the
 * model never sees its system prompt and plays the wrong part; the reply looks merely confused.
 */
function truncationFailure(size: PromptSize): string | undefined {
  if (size.promptTokens === undefined || size.sentChars < TRUNCATION_MIN_CHARS) return undefined;
  if (size.promptTokens >= size.sentChars * TRUNCATION_TOKENS_PER_CHAR) return undefined;
  return (
    `the server read only ${size.promptTokens} prompt tokens of a ${size.sentChars}-character ` +
    `request (about ${Math.round(size.sentChars / 4)} tokens), so it is probably truncating the ` +
    "prompt to its context length; raise the model's context window (for Ollama, num_ctx)"
  );
}

/** The text parts of a reply the AI SDK rejected, to look for calls written as text. */
function contentText(content: readonly unknown[]): string {
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'type' in part && part.type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .join('');
}

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
  /** Numbers each reply whose calls were recovered from text, so their ids never repeat. */
  private recoveredReplies = 0;

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
          return failures.length > 0
            ? { ...outcome.response, failedAttempts: failures }
            : outcome.response;
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

  private recoveredIdPrefix(): string {
    return `text-call-${++this.recoveredReplies}`;
  }

  private async generate(
    seat: SeatConfig,
    target: ModelTarget,
    request: ModelRequest
  ): Promise<{ response: ModelResponse; finishReason: string }> {
    const size: PromptSize = { sentChars: 0 };
    const provider = createOpenAICompatible({
      name: PROVIDER_NAME,
      baseURL: target.endpoint.baseURL,
      apiKey: target.endpoint.apiKey,
      fetch: measuringFetch(size),
    });
    const timeout = AbortSignal.timeout(seat.timeoutMs);
    const hasTools = request.tools.length > 0;
    const toolNames = request.tools.map((schema) => schema.name);
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
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
    } catch (error) {
      // A truncated prompt explains the violation below, and is the failure worth reporting.
      const truncated = truncationFailure(size);
      if (truncated) throw new Error(truncated);
      if (ToolChoiceViolationError.isInstance(error)) {
        const recovered = recoverTextToolCalls(
          contentText(error.content),
          toolNames,
          this.recoveredIdPrefix()
        );
        if (recovered.length > 0) {
          return {
            response: { text: '', toolCalls: recovered, model: target.model },
            finishReason: 'tool-calls',
          };
        }
      }
      throw error;
    }
    const truncated = truncationFailure(size);
    if (truncated) throw new Error(truncated);
    const toolCalls = toToolCalls(result.toolCalls);
    // With tool calls optional, a call written as text would otherwise be spoken as prose.
    const recovered =
      hasTools && toolCalls.length === 0
        ? recoverTextToolCalls(result.text, toolNames, this.recoveredIdPrefix())
        : [];
    return {
      response:
        recovered.length > 0
          ? { text: '', toolCalls: recovered, model: target.model }
          : { text: result.text, toolCalls, model: target.model },
      finishReason: result.finishReason,
    };
  }
}
