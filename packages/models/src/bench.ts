import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool } from 'ai';
import { SeatConfig, type SeatConfigInput } from './seat';

export interface BenchResult {
  seat: string;
  model: string;
  baseURL: string;
  /** Whether the server answered at all (its model list or a completion). */
  reachable: boolean;
  /** Whether the server's model list includes the configured model; null if the list was unreadable. */
  modelListed: boolean | null;
  latencyMs: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  toolCallTrials: number;
  /** Trials where the model called the test tool exactly as asked. */
  toolCallSuccesses: number;
  /**
   * Trials where the model replied with text instead of a tool call, for a seat whose effective
   * tool choice is "auto" (the engine accepts that as narration or speech, so it counts as usable,
   * not a miss). Always 0 for a "required" seat, where a text-only reply makes the AI SDK throw.
   */
  textReplies: number;
  errors: string[];
}

export interface BenchOptions {
  /** Tool-call trials to run. Default 5. */
  trials?: number;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
}

const SPEED_PROMPT = 'Describe a torch-lit dungeon corridor in about sixty words.';
const EXPECTED_DICE = '1d20+3';
const MAX_ERRORS = 10;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks one seat's endpoint the way a session will use it: reachability and model listing,
 * generation speed, and how reliably the model makes a well-formed tool call.
 */
export async function benchSeat(
  seatId: string,
  input: SeatConfigInput,
  options: BenchOptions = {}
): Promise<BenchResult> {
  const seat = SeatConfig.parse(input);
  const now = options.now ?? (() => performance.now());
  const trials = options.trials ?? 5;
  const result: BenchResult = {
    seat: seatId,
    model: seat.model,
    baseURL: seat.endpoint.baseURL,
    reachable: false,
    modelListed: null,
    latencyMs: null,
    outputTokens: null,
    tokensPerSecond: null,
    toolCallTrials: trials,
    toolCallSuccesses: 0,
    textReplies: 0,
    errors: [],
  };
  const addError = (message: string) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(message);
  };

  try {
    const response = await fetch(`${seat.endpoint.baseURL}/models`, {
      headers: seat.endpoint.apiKey ? { authorization: `Bearer ${seat.endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(seat.timeoutMs),
    });
    result.reachable = response.ok;
    if (response.ok) {
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      result.modelListed = Array.isArray(body.data)
        ? body.data.some((entry) => entry.id === seat.model)
        : null;
    } else {
      addError(`GET /models returned ${response.status}`);
    }
  } catch (error) {
    addError(`GET /models failed: ${errorMessage(error)}`);
  }

  const model = createOpenAICompatible({
    name: 'cartyx-sim-bench',
    baseURL: seat.endpoint.baseURL,
    apiKey: seat.endpoint.apiKey,
  }).chatModel(seat.model);

  try {
    const started = now();
    const speed = await generateText({
      model,
      prompt: SPEED_PROMPT,
      temperature: seat.temperature,
      maxOutputTokens: seat.maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(seat.timeoutMs),
    });
    const elapsedMs = now() - started;
    result.reachable = true;
    result.latencyMs = Math.round(elapsedMs);
    result.outputTokens = speed.usage.outputTokens ?? null;
    if (result.outputTokens !== null && elapsedMs > 0) {
      result.tokensPerSecond = Math.round((result.outputTokens / (elapsedMs / 1000)) * 10) / 10;
    }
  } catch (error) {
    addError(`speed test failed: ${errorMessage(error)}`);
  }

  const rollDice = tool({
    description: 'Roll dice for the table.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { dice: { type: 'string' }, reason: { type: 'string' } },
      required: ['dice', 'reason'],
      additionalProperties: false,
    }),
  });
  // Under "required" a text-only reply makes the AI SDK throw, so it lands in the catch below as
  // an error, same as before. Under "auto" it does not throw, and the engine accepts a text reply
  // as narration or speech, so it counts as usable here too, not a silently uncounted miss.
  const toolChoice = seat.toolChoice ?? 'required';
  for (let trial = 1; trial <= trials; trial++) {
    try {
      const reply = await generateText({
        model,
        instructions: 'You are testing a game engine. Always respond by calling a tool.',
        prompt: `Call roll_dice exactly once with dice "${EXPECTED_DICE}" and a short reason.`,
        tools: { roll_dice: rollDice },
        toolChoice,
        temperature: seat.temperature,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(seat.timeoutMs),
      });
      const call = reply.toolCalls[0];
      const invalid = (call as { invalid?: boolean } | undefined)?.invalid === true;
      const dice = (call?.input as { dice?: unknown } | undefined)?.dice;
      if (call && !invalid && call.toolName === 'roll_dice' && dice === EXPECTED_DICE) {
        result.toolCallSuccesses++;
      } else if (!call && toolChoice === 'auto' && reply.text.trim().length > 0) {
        result.textReplies++;
      }
    } catch (error) {
      addError(`tool trial ${trial} failed: ${errorMessage(error)}`);
    }
  }
  return result;
}
