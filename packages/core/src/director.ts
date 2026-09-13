import type { Combatant, Rng } from '@cartyx-sim/rules';
import { clockInstruction, clockPhase } from './clock';
import { SessionPausedError } from './errors';
import type { SimEvent } from './events';
import type {
  ChatMessage,
  LoreHit,
  LoreIndex,
  ModelClient,
  ModelResponse,
  ToolCall,
  ToolSchema,
} from './model';
import type { PromptBuilder } from './prompts';
import { TurnRecorder } from './recorder';
import type { EventSink } from './sink';
import { advanceCombat, foldEvents, isUp, nextActor, ownEntry, type GameState } from './state';
import {
  DM_TOOLS,
  MECHANICS_TOOL_NAMES,
  PLAYER_TOOLS,
  TURN_ACTION_TOOL_NAMES,
} from './tools/registry';
import {
  prepareToolCall,
  runPreparedCall,
  toToolSchema,
  type AnyToolDef,
  type ToolContext,
} from './tools/types';
import { renderTranscript, type Audience } from './transcript';
import { validateDmText, validatePlayerText } from './validators';

export interface DirectorConfig {
  session: number;
  targetMinutes: number;
  loreCommit: string;
  party: Combatant[];
  /** Seat ids for the DM and for each PC id. */
  seats: { dm: string; players: Record<string, string> };
  /** Minimum lore search score treated as relevant. Default 0.35. */
  loreThreshold?: number;
  /** Model calls allowed in one DM beat before hand_off is forced. Default 12. */
  maxDmStepsPerBeat?: number;
  /** Re-prompts after a validator rejection before accepting with a flag. Default 2. */
  maxValidatorRetries?: number;
  /** Transcript lines included in prompts. Default 30. */
  transcriptWindow?: number;
  /** Consecutive silent turns before the DM is nudged to narrate. Default 6. */
  silentTurnLimit?: number;
  /** Waits between retries of a failing model call; the session pauses after the last. */
  retryDelaysMs?: number[];
}

export interface DirectorDeps {
  model: ModelClient;
  lore: LoreIndex;
  rng: Rng;
  sink: EventSink;
  prompts: PromptBuilder;
  now?: () => Date;
  newTurnId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  onCommit?: (events: readonly SimEvent[], state: GameState) => void;
}

export type RunResult =
  | { status: 'ended' | 'turn_limit'; state: GameState }
  | { status: 'paused'; state: GameState; seat: string; error: string };

const DM_TOOL_SCHEMAS: ToolSchema[] = DM_TOOLS.map(toToolSchema);
const PLAYER_TOOL_SCHEMAS: ToolSchema[] = PLAYER_TOOLS.map(toToolSchema);

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: 'tool', toolCallId: call.id, toolName: call.name, content };
}

/** The same ids, ignoring order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** A text-only response is treated as a call to the seat's main speaking tool. */
function callsFromResponse(response: ModelResponse, fallbackTool: string, id: string): ToolCall[] {
  if (response.toolCalls.length > 0) return response.toolCalls;
  const text = response.text.trim();
  return text ? [{ id, name: fallbackTool, args: { text } }] : [];
}

export class Director {
  private state: GameState;
  private readonly history: SimEvent[];
  private readonly loreThreshold: number;
  private readonly maxDmStepsPerBeat: number;
  private readonly maxValidatorRetries: number;
  private readonly transcriptWindow: number;
  private readonly silentTurnLimit: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => Date;
  private readonly newTurnId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  private constructor(
    private readonly config: DirectorConfig,
    private readonly deps: DirectorDeps,
    prior: readonly SimEvent[]
  ) {
    this.history = [...prior];
    this.state = foldEvents(prior);
    this.loreThreshold = config.loreThreshold ?? 0.35;
    this.maxDmStepsPerBeat = config.maxDmStepsPerBeat ?? 12;
    this.maxValidatorRetries = config.maxValidatorRetries ?? 2;
    this.transcriptWindow = config.transcriptWindow ?? 30;
    this.silentTurnLimit = config.silentTurnLimit ?? 6;
    this.retryDelaysMs = config.retryDelaysMs ?? [1000, 4000, 15000];
    this.now = deps.now ?? (() => new Date());
    this.newTurnId = deps.newTurnId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Loads any existing events from the sink and resumes from them. */
  static async create(config: DirectorConfig, deps: DirectorDeps): Promise<Director> {
    if (!config.seats.dm) throw new Error('No DM seat configured.');
    const prior = await deps.sink.readAll();
    const director = new Director(config, deps, prior);
    const { state } = director;
    if (state.ended) throw new Error(`Session ${state.session} has already ended`);
    if (state.session !== null && state.session !== config.session) {
      throw new Error(
        `Event log belongs to session ${state.session}, not session ${config.session}`
      );
    }
    // A resumed session schedules the logged party (the log wins over config), so every logged
    // PC needs a seat; a new session plays the configured party.
    const configuredIds = config.party.map((pc) => pc.id);
    const partyIds = state.session === null ? configuredIds : state.partyIds;
    for (const id of partyIds) {
      if (!ownEntry(config.seats.players, id)) {
        throw new Error(`No player seat configured for "${id}".`);
      }
    }
    if (state.session !== null && !sameIds(configuredIds, state.partyIds)) {
      throw new Error(
        `Session ${state.session} started with party "${state.partyIds.join(', ')}", but the ` +
          `configured party is "${configuredIds.join(', ')}". Resume with the original party.`
      );
    }
    if (state.loreCommit !== null && state.loreCommit !== config.loreCommit) {
      throw new Error(
        `Session ${state.session} started with lore commit "${state.loreCommit}", but the ` +
          `configured lore commit is "${config.loreCommit}". The lore has changed since the ` +
          'session started; resume with the original lore commit.'
      );
    }
    if (prior.length > 0) {
      const recorder = director.newRecorder();
      recorder.emit({ type: 'ooc_note', visibility: 'dm', text: 'Session resumed.' });
      if (state.targetMinutes !== null && state.targetMinutes !== config.targetMinutes) {
        recorder.emit({
          type: 'ooc_note',
          visibility: 'dm',
          text:
            `Ignoring the configured targetMinutes override (${config.targetMinutes}); the ` +
            `session already logged targetMinutes ${state.targetMinutes}, which stays in effect.`,
        });
      }
      await director.commit(recorder);
    }
    return director;
  }

  get currentState(): GameState {
    return this.state;
  }

  get events(): readonly SimEvent[] {
    return this.history;
  }

  /** The target minutes governing the clock: the logged value once a session has started, else config. */
  private get targetMinutes(): number {
    return this.state.targetMinutes ?? this.config.targetMinutes;
  }

  async run(maxTurns = Number.POSITIVE_INFINITY): Promise<RunResult> {
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if ((await this.step()) === 'ended') return { status: 'ended', state: this.state };
      }
      return { status: 'turn_limit', state: this.state };
    } catch (error) {
      if (!(error instanceof SessionPausedError)) throw error;
      const recorder = this.newRecorder();
      recorder.emit({
        type: 'ooc_note',
        visibility: 'dm',
        text: `Session paused. ${error.message}`,
      });
      await this.commit(recorder);
      return { status: 'paused', state: this.state, seat: error.seat, error: error.reason };
    }
  }

  /** Runs exactly one turn and commits it. */
  async step(): Promise<'continue' | 'ended'> {
    if (this.state.session === null) {
      await this.startSession();
      return 'continue';
    }
    if (!this.state.ended && clockPhase(this.state, this.targetMinutes) === 'hard_stop') {
      const recorder = this.newRecorder();
      recorder.emit({ type: 'session_end', reason: 'hard_stop' });
      await this.commit(recorder);
      return 'ended';
    }
    const next = nextActor(this.state);
    if (next.kind === 'ended') return 'ended';

    if (next.kind === 'pc') {
      if (!this.state.combat && this.state.silentTurns >= this.silentTurnLimit) {
        await this.dmBeat(
          'beat',
          undefined,
          'The table has gone quiet. Move the story forward with narration.'
        );
      } else {
        await this.playerTurn(next.pcId, next.reason);
      }
    } else {
      await this.dmBeat(next.reason, next.combatantId);
    }

    if (!this.state.ended && clockPhase(this.state, this.targetMinutes) === 'hard_stop') {
      const recorder = this.newRecorder();
      recorder.emit({ type: 'session_end', reason: 'hard_stop' });
      await this.commit(recorder);
    }
    return this.state.ended ? 'ended' : 'continue';
  }

  private async startSession(): Promise<void> {
    const recorder = this.newRecorder();
    recorder.emit({
      type: 'session_start',
      session: this.config.session,
      loreCommit: this.config.loreCommit,
      targetMinutes: this.config.targetMinutes,
      party: this.config.party,
    });
    await this.commit(recorder);
  }

  private async dmBeat(
    reason: 'beat' | 'resolve' | 'monster',
    combatantId: string | undefined,
    nudge?: string
  ): Promise<void> {
    const recorder = this.newRecorder();
    const seat = this.config.seats.dm;
    const combatAtStart = this.state.combat !== null;
    if (nudge) recorder.emit({ type: 'ooc_note', visibility: 'dm', text: `Watchdog: ${nudge}` });

    const messages = this.deps.prompts.dm({
      state: this.state,
      transcript: this.transcript('dm'),
      instruction: this.dmInstruction(reason, combatantId, nudge),
    });
    const context = this.toolContext(recorder, 'dm', seat);
    const pcNames = this.state.partyIds.map(
      (id) => ownEntry(this.state.combatants, id)?.name ?? id
    );
    let mechanicsCalled = false;
    let rejections = 0;
    let ended = false;

    for (let step = 0; step < this.maxDmStepsPerBeat && !ended; step++) {
      const response = await this.callModel(seat, messages, DM_TOOL_SCHEMAS);
      const calls = callsFromResponse(response, 'narrate', `auto-narrate-${step}`);
      messages.push({
        role: 'assistant',
        content: response.toolCalls.length > 0 ? response.text : '',
        toolCalls: calls,
      });
      if (calls.length === 0) {
        messages.push({
          role: 'user',
          content: 'Use your tools. Call hand_off when the players should respond.',
        });
        continue;
      }

      let skipRest = false;
      for (const call of calls) {
        if (ended || skipRest) {
          const why = ended
            ? 'your turn already ended with hand_off'
            : 'an earlier call was rejected';
          messages.push(toolMessage(call, `Not executed: ${why}.`));
          continue;
        }
        const prepared = prepareToolCall(call, DM_TOOLS);
        if (!prepared.ok) {
          messages.push(toolMessage(call, prepared.error));
          skipRest = true;
          continue;
        }
        const text = prepared.def.narrativeText?.(prepared.args);
        const violation = text
          ? validateDmText(text, { pcNames, mechanicsToolCalled: mechanicsCalled })
          : null;
        if (violation) {
          if (rejections < this.maxValidatorRetries) {
            rejections++;
            messages.push(
              toolMessage(
                call,
                `Rejected (${violation.rule}): ${violation.message} Call the tool again with corrected text.`
              )
            );
            skipRest = true;
            continue;
          }
          recorder.emit({
            type: 'validator_flag',
            visibility: 'dm',
            seat,
            rule: violation.rule,
            retries: rejections,
            resolution: 'accepted_with_flag',
          });
        }
        const execution = await runPreparedCall(prepared.def, prepared.args, context);
        if (!execution.ok) {
          messages.push(toolMessage(call, `Error: ${execution.error}`));
          skipRest = true;
          continue;
        }
        if (MECHANICS_TOOL_NAMES.has(call.name)) mechanicsCalled = true;
        if (execution.outcome.endsBeat) ended = true;
        messages.push(toolMessage(call, execution.outcome.result));
      }
    }

    if (!ended) {
      recorder.emit({
        type: 'validator_flag',
        visibility: 'dm',
        seat,
        rule: 'dm_step_limit',
        retries: rejections,
        resolution: 'forced_hand_off',
      });
      const forced = prepareToolCall(
        { id: 'forced-hand-off', name: 'hand_off', args: { target: { kind: 'party' } } },
        DM_TOOLS
      );
      if (forced.ok) await runPreparedCall(forced.def, forced.args, context);
    }

    const combatRestarted = recorder.events.some((event) => event.type === 'combat_start');
    if (combatAtStart && !combatRestarted && recorder.state.combat) {
      const advance = advanceCombat(recorder.state);
      if (advance) recorder.emit({ type: 'combat_turn', ...advance });
      else recorder.emit({ type: 'combat_end' });
    }
    if (recorder.state.combat) {
      const { combat } = recorder.state;
      const current = combat.order[combat.turnIndex];
      const combatant = current && recorder.state.combatants[current.combatantId];
      if (!isUp(combatant)) {
        const found = advanceCombat(recorder.state, { inclusive: true });
        if (found) recorder.emit({ type: 'combat_turn', ...found });
        else recorder.emit({ type: 'combat_end' });
      }
    }
    recorder.emit({ type: 'turn_end', actor: 'dm' });

    const phase = clockPhase(recorder.state, this.targetMinutes);
    const sceneBreak = recorder.events.some((event) => event.type === 'scene_change');
    if (sceneBreak && (phase === 'end_at_scene_break' || phase === 'hard_stop')) {
      recorder.emit({ type: 'session_end', reason: 'target_reached' });
    }
    await this.commit(recorder);
  }

  private async playerTurn(pcId: string, reason: 'response' | 'combat_turn'): Promise<void> {
    const recorder = this.newRecorder();
    const pc = ownEntry(this.state.combatants, pcId);
    const seat = ownEntry(this.config.seats.players, pcId);
    if (!pc || !seat) throw new Error(`No player seat configured for "${pcId}"`);

    const instruction =
      reason === 'combat_turn'
        ? 'It is your turn in combat. Declare your action with act or declare_spell, and optionally speak.'
        : 'The DM has turned to you. Respond in character: speak, act, or pass.';
    const messages = this.deps.prompts.player({
      pc,
      state: this.state,
      transcript: this.transcript('player'),
      instruction,
    });
    const otherPcNames = this.state.partyIds
      .filter((id) => id !== pcId)
      .map((id) => ownEntry(this.state.combatants, id)?.name ?? id);
    const context = this.toolContext(recorder, pcId, seat);

    for (let attempt = 0; ; attempt++) {
      const response = await this.callModel(seat, messages, PLAYER_TOOL_SCHEMAS);
      const calls = callsFromResponse(response, 'speak', `auto-speak-${attempt}`);
      messages.push({
        role: 'assistant',
        content: response.toolCalls.length > 0 ? response.text : '',
        toolCalls: calls,
      });

      const accepted: { call: ToolCall; def: AnyToolDef; args: unknown }[] = [];
      const problems: { rule: string; message: string }[] = [];
      for (const call of calls) {
        const prepared = prepareToolCall(call, PLAYER_TOOLS);
        if (!prepared.ok) {
          problems.push({ rule: 'invalid_tool_call', message: prepared.error });
          continue;
        }
        const text = prepared.def.narrativeText?.(prepared.args);
        const violation = text ? validatePlayerText(text, { otherPcNames }) : null;
        if (violation) {
          problems.push(violation);
          continue;
        }
        accepted.push({ call, def: prepared.def, args: prepared.args });
      }
      if (
        problems.length === 0 &&
        !accepted.some((item) => TURN_ACTION_TOOL_NAMES.has(item.def.name))
      ) {
        problems.push({
          rule: 'no_turn_action',
          message: 'Your turn needs speak, act, declare_spell, or pass.',
        });
      }

      if (problems.length > 0 && attempt < this.maxValidatorRetries) {
        const summary = problems.map((problem) => `${problem.rule}: ${problem.message}`).join(' ');
        for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
        if (calls.length === 0)
          messages.push({ role: 'user', content: `Your response was rejected. ${summary}` });
        continue;
      }

      // At this point `problems` is empty unless retries are exhausted (otherwise we would have
      // re-prompted above), so a checkpoint here brackets exactly this attempt's accepted calls.
      const checkpoint = recorder.checkpoint();
      let tookTurn = false;
      for (const item of accepted) {
        const execution = await runPreparedCall(item.def, item.args, context);
        if (!execution.ok) {
          problems.push({ rule: 'tool_error', message: execution.error });
          continue;
        }
        if (TURN_ACTION_TOOL_NAMES.has(item.def.name)) tookTurn = true;
      }

      const executionFailed = problems.some((problem) => problem.rule === 'tool_error');
      if (executionFailed && attempt < this.maxValidatorRetries) {
        // Roll back so none of this attempt's successful calls leave events behind, then send
        // the error back to the model and re-prompt instead of forcing a pass.
        recorder.rollback(checkpoint);
        const summary = problems.map((problem) => `${problem.rule}: ${problem.message}`).join(' ');
        for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
        continue;
      }

      if (problems.length > 0) {
        recorder.emit({
          type: 'validator_flag',
          visibility: 'dm',
          seat,
          rule: problems.map((problem) => problem.rule).join(','),
          retries: attempt,
          resolution: tookTurn ? 'accepted_with_flag' : 'forced_pass',
        });
      }
      if (!tookTurn) recorder.emit({ type: 'pass', actor: pcId });
      break;
    }

    recorder.emit({ type: 'turn_end', actor: pcId });
    await this.commit(recorder);
  }

  private dmInstruction(
    reason: 'beat' | 'resolve' | 'monster',
    combatantId: string | undefined,
    nudge: string | undefined
  ): string {
    const name = combatantId
      ? (ownEntry(this.state.combatants, combatantId)?.name ?? combatantId)
      : '';
    const base =
      reason === 'resolve'
        ? `${name} has declared their combat action (see recent events). Resolve it with tools, narrate the result, then call hand_off.`
        : reason === 'monster'
          ? `It is ${name}'s turn (id: ${combatantId}). Act for it with tools, narrate, then call hand_off.`
          : 'Continue the story: narrate what happens next, resolve any declared actions with tools, then call hand_off.';
    const clock = clockInstruction(clockPhase(this.state, this.targetMinutes));
    return [nudge, base, clock].filter(Boolean).join(' ');
  }

  private async callModel(
    seat: string,
    messages: ChatMessage[],
    tools: ToolSchema[]
  ): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.model.complete({ seat, messages, tools });
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new SessionPausedError(
            seat,
            error instanceof Error ? error.message : String(error)
          );
        }
        await this.sleep(delay);
      }
    }
  }

  private transcript(audience: Audience): string {
    return renderTranscript(this.history, this.state, audience, this.transcriptWindow);
  }

  private toolContext(recorder: TurnRecorder, actorId: string, seat: string): ToolContext {
    return {
      recorder,
      history: this.history,
      rng: this.deps.rng,
      lore: { search: (query, limit) => this.searchLore(query, limit) },
      loreThreshold: this.loreThreshold,
      actorId,
      seat,
    };
  }

  /** Retries a lore search on the same schedule as model calls, then pauses seat "lore". */
  private async searchLore(query: string, limit: number): Promise<LoreHit[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.lore.search(query, limit);
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          throw new SessionPausedError(
            'lore',
            error instanceof Error ? error.message : String(error)
          );
        }
        await this.sleep(delay);
      }
    }
  }

  private newRecorder(): TurnRecorder {
    return new TurnRecorder(this.state, this.newTurnId(), this.now);
  }

  private async commit(recorder: TurnRecorder): Promise<void> {
    if (recorder.events.length === 0) return;
    await this.deps.sink.append(recorder.events);
    this.history.push(...recorder.events);
    this.state = recorder.state;
    this.deps.onCommit?.(recorder.events, this.state);
  }
}
