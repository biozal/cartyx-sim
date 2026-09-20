import { DEATH_SAVE_DC, rollD20, rollDeathSave, type Combatant, type Rng } from '@cartyx-sim/rules';
import { clockInstruction, clockPhase, shareInstruction } from './clock';
import { SessionPausedError } from './errors';
import { EVENT_SCHEMA_VERSION, type HandOffTarget, type SimEvent } from './events';
import { extractHandOffProse } from './hand-off-prose';
import {
  ModelResponse,
  type ChatMessage,
  type LoreHit,
  type LoreIndex,
  type ModelClient,
  type ToolCall,
  type ToolSchema,
} from './model';
import {
  cutSentences,
  declarationsSinceDm,
  describeFindings,
  parseCheckerReply,
  partyFindings,
  verifyFindings,
  type PcControlFinding,
} from './pc-control';
import type { PromptBuilder } from './prompts';
import { TurnRecorder } from './recorder';
import { cutRepeats, retellsNarration, repeatedSentences } from './repeats';
import type { EventSink } from './sink';
import { advanceCombat, foldEvents, nextActor, ownEntry, takesTurn, type GameState } from './state';
import { emitCombatantChanges } from './tools/mechanics';
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
import { playerView } from './view';

export interface DirectorConfig {
  session: number;
  targetMinutes: number;
  loreCommit: string;
  party: Combatant[];
  /** Seat ids for the DM, each PC id, and optionally the checker that reviews DM narration. */
  seats: { dm: string; players: Record<string, string>; checker?: string };
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
  /**
   * Consecutive completed turns, in or out of combat, with no spoken words and no game-state
   * progress before the session pauses. Default 12.
   */
  silentTurnPauseLimit?: number;
  /** Consecutive hand-offs that no player character can answer before the session pauses. Default 3. */
  idleHandOffLimit?: number;
  /** Tool calls the DM may make in one beat before hand_off is forced. Default 24. */
  maxDmToolCallsPerBeat?: number;
  /** Waits between retries of a failing model call; the session pauses after the last. */
  retryDelaysMs?: number[];
  /** Consecutive checker failures before narration stops being checked for the run. Default 3. */
  maxCheckerFailures?: number;
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
  | { status: 'paused'; state: GameState; seat: string; error: string; kind: 'seat' | 'backstop' };

const DM_TOOL_SCHEMAS: ToolSchema[] = DM_TOOLS.map(toToolSchema);
const PLAYER_TOOL_SCHEMAS: ToolSchema[] = PLAYER_TOOLS.map(toToolSchema);

function toolMessage(call: ToolCall, content: string): ChatMessage {
  return { role: 'tool', toolCallId: call.id, toolName: call.name, content };
}

/** The distinct rule names of a set of problems, for one validator_flag. */
function ruleList(problems: readonly { rule: string }[]): string {
  return [...new Set(problems.map((problem) => problem.rule))].join(',');
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

// Thinking checkers occasionally spend their whole output budget thinking and return nothing
// useful; retrying the same target once usually gets a real reply before falling back.
const CHECKER_REPLY_ATTEMPTS = 2;

// The checker's own flags, notes, and tool results use this label instead of the verb-list rule's
// `dm_controls_pc`, so a log can tell which one caught a given case without reading the events
// around it.
const DM_CONTROLS_PC_CHECKER_RULE = 'dm_controls_pc_checker';

/** Multi-word DM tool names, which only turn up in prose when the model talks about its calls. */
const DM_TOOL_NAMES_IN_PROSE = DM_TOOLS.map((tool) => tool.name).filter((name) =>
  name.includes('_')
);

/** Prose like "Let me hand off to the players." is commentary on the calls, not the story. */
function isCommentary(text: string): boolean {
  return /^let me\b/i.test(text) || DM_TOOL_NAMES_IN_PROSE.some((name) => text.includes(name));
}

/**
 * The DM's calls for one response, and the id of the call made from its prose, if any. Unlike a
 * player's, the DM's prose is narration even when it arrives alongside tool calls, so it is narrated
 * instead of dropped: after the calls it may describe (so their mechanics back its numbers) and
 * before any hand_off. It is left out when the response already narrates or it is commentary.
 */
function dmCallsFromResponse(
  response: ModelResponse,
  id: string
): { calls: ToolCall[]; proseCallId?: string } {
  const calls = callsFromResponse(response, 'narrate', id);
  const text = response.text.trim();
  if (
    response.toolCalls.length === 0 ||
    !text ||
    isCommentary(text) ||
    calls.some((call) => call.name === 'narrate')
  ) {
    return { calls };
  }
  const handOff = calls.findIndex((call) => call.name === 'hand_off');
  const at = handOff === -1 ? calls.length : handOff;
  const prose: ToolCall = { id, name: 'narrate', args: { text } };
  return { calls: [...calls.slice(0, at), prose, ...calls.slice(at)], proseCallId: id };
}

/** The shared prefix of every "Hand-off written in DM narration …" note, built in one place. */
function handOffProseBase(lines: string): string {
  return `Hand-off written in DM narration (${lines}); removed from the narration`;
}

/**
 * Strips any "Hand off to …" line written as DM narration out of this response's `narrate` calls
 * (dropping a call left with no text), and, when a line matched and the response made no
 * `hand_off` call of its own, appends one synthesized from the last matched line's target. Like
 * the engine's own prose call, the synthesized call does not count toward the DM tool-call cap.
 *
 * When a real `hand_off` call is already present, nothing is synthesized and a DM-only note is
 * returned immediately, since removing the written line is all that happened. When a call is
 * synthesized, no note is returned here — its fate (executed, skipped, or failed) is not yet
 * known, so the caller emits the note once the loop reaches that call (`proseHandOffCallId`),
 * using `proseHandOffLines` for the "(<lines>)" text.
 */
function applyHandOffProse(
  calls: readonly ToolCall[],
  party: readonly { id: string; name: string }[],
  step: number
): { calls: ToolCall[]; proseHandOffCallId?: string; proseHandOffLines?: string; note?: string } {
  const matchedLines: string[] = [];
  let lastTarget: HandOffTarget | undefined;
  const rewritten: ToolCall[] = [];
  for (const call of calls) {
    const text = call.name === 'narrate' ? call.args.text : undefined;
    if (typeof text !== 'string') {
      rewritten.push(call);
      continue;
    }
    const extracted = extractHandOffProse(text, party);
    if (extracted.lines.length === 0) {
      rewritten.push(call);
      continue;
    }
    matchedLines.push(...extracted.lines);
    lastTarget = extracted.target;
    if (extracted.text !== '') {
      rewritten.push({ ...call, args: { ...call.args, text: extracted.text } });
    }
  }
  if (matchedLines.length === 0) return { calls: rewritten };
  const listed = matchedLines.join(' | ');
  if (rewritten.some((call) => call.name === 'hand_off')) {
    return { calls: rewritten, note: `${handOffProseBase(listed)}.` };
  }
  const proseHandOffCallId = `prose-hand-off-${step}`;
  return {
    calls: [
      ...rewritten,
      { id: proseHandOffCallId, name: 'hand_off', args: { target: lastTarget! } },
    ],
    proseHandOffCallId,
    proseHandOffLines: listed,
  };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** What a checker trim cost a narration, held until the trimmed narration is really narrated. */
interface CheckerTrim {
  /** The cut sentences, as the note and the tool message list them. */
  listed: string;
  /** Retries the rule already cost this beat, for the flag. */
  retries: number;
  /** The checker's raw reply, logged with the note it belongs to. */
  reply: string | undefined;
}

/** True when this beat already narrated the same words: some models repeat a line verbatim. */
function narratedThisBeat(recorder: TurnRecorder, text: string): boolean {
  const words = collapseWhitespace(text);
  return recorder.events.some(
    (event) => event.type === 'narration' && collapseWhitespace(event.text) === words
  );
}

/**
 * The DM's narration this turn since the last thing happened in the game (a roll, a state change,
 * a combat step, a scene change, an NPC introduced or speaking), in order: what a new narration
 * could only be retelling, since anything before that event described something else.
 */
function narrationSinceLastEvent(recorder: TurnRecorder): string[] {
  const texts: string[] = [];
  for (const event of recorder.events) {
    if (event.type === 'narration') {
      if (event.speaker === 'dm') texts.push(event.text);
    } else if (
      event.type !== 'ooc_note' &&
      event.type !== 'validator_flag' &&
      !event.type.startsWith('lore_')
    ) {
      texts.length = 0;
    }
  }
  return texts;
}

/** Public dialogue lines players spoke since the DM's last turn ended: quoting one back is a repeat. */
function recentPlayerLines(history: readonly SimEvent[]): string[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === 'turn_end' && event.actor === 'dm') {
      start = index + 1;
      break;
    }
  }
  const lines: string[] = [];
  for (const event of history.slice(start)) {
    if (event.type === 'dialogue' && event.visibility === 'public') lines.push(event.text);
  }
  return lines;
}

/** Beats of prior DM narration still checked for a repeat, besides the beat in progress (finding 6). */
const REPEAT_LOOKBACK_BEATS = 3;

/**
 * The DM's narration text from the last `beatCount` beats already committed to `history`, each
 * beat being the span up to and including a `turn_end` event with `actor: 'dm'`. Beats older than
 * that window are left out, so a line that repeats one from further back is not flagged.
 */
function narrationsFromRecentBeats(history: readonly SimEvent[], beatCount: number): string[] {
  let start = 0;
  let beatsSeen = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === 'turn_end' && event.actor === 'dm') {
      beatsSeen++;
      if (beatsSeen > beatCount) {
        start = index + 1;
        break;
      }
    }
  }
  return history
    .slice(start)
    .filter((event) => event.type === 'narration')
    .map((event) => event.text);
}

/** The public dialogue lines this PC has spoken so far this session (the whole history, not a window). */
function pcDialogueLines(history: readonly SimEvent[], pcId: string): string[] {
  const lines: string[] = [];
  for (const event of history) {
    if (event.type === 'dialogue' && event.visibility === 'public' && event.speaker === pcId) {
      lines.push(event.text);
    }
  }
  return lines;
}

/** Tools whose narrated text is checked for a repeated line (spec finding 2). */
const REPEAT_CHECKED_TOOL_NAMES: ReadonlySet<string> = new Set(['speak', 'interject']);

export class Director {
  private state: GameState;
  private readonly history: SimEvent[];
  private readonly loreThreshold: number;
  private readonly maxDmStepsPerBeat: number;
  private readonly maxValidatorRetries: number;
  private readonly transcriptWindow: number;
  private readonly silentTurnLimit: number;
  private readonly silentTurnPauseLimit: number;
  private readonly idleHandOffLimit: number;
  private readonly maxDmToolCallsPerBeat: number;
  private readonly retryDelaysMs: number[];
  private readonly maxCheckerFailures: number;
  /** Consecutive checker calls that gave no verdict; reset by a successful check. */
  private checkerFailures = 0;
  /** Set once the checker has failed too often; lasts for this run only. */
  private checkerDisabled = false;
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
    this.silentTurnPauseLimit = config.silentTurnPauseLimit ?? 12;
    this.idleHandOffLimit = config.idleHandOffLimit ?? 3;
    this.maxDmToolCallsPerBeat = config.maxDmToolCallsPerBeat ?? 24;
    this.retryDelaysMs = config.retryDelaysMs ?? [1000, 4000, 15000];
    this.maxCheckerFailures = config.maxCheckerFailures ?? 3;
    this.now = deps.now ?? (() => new Date());
    this.newTurnId = deps.newTurnId ?? (() => crypto.randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Loads any existing events from the sink and resumes from them. */
  static async create(config: DirectorConfig, deps: DirectorDeps): Promise<Director> {
    if (!config.seats.dm) throw new Error('No DM seat configured.');
    for (const pc of config.party) {
      if (pc.id === 'dm' || pc.id.startsWith('npc-')) {
        throw new Error(
          `Party member id "${pc.id}" is reserved: "dm" is the DM's actor id and "npc-" starts ` +
            'every NPC id. Give the character a different id.'
        );
      }
    }
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
        type: 'session_paused',
        visibility: 'dm',
        seat: error.seat,
        reason: `Session paused. ${error.message}`,
        kind: error.kind,
      });
      await this.commit(recorder);
      return {
        status: 'paused',
        state: this.state,
        seat: error.seat,
        error: error.reason,
        kind: error.kind,
      };
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
      this.closeCombatIfRunning(recorder);
      recorder.emit({ type: 'session_end', reason: 'hard_stop' });
      await this.commit(recorder);
      return 'ended';
    }
    this.pauseIfStuck();
    const next = nextActor(this.state);
    if (next.kind === 'ended') return 'ended';

    if (next.kind === 'death_save') {
      await this.deathSaveTurn(next.combatantId);
    } else if (next.kind === 'pc') {
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
      this.closeCombatIfRunning(recorder);
      recorder.emit({ type: 'session_end', reason: 'hard_stop' });
      await this.commit(recorder);
    }
    return this.state.ended ? 'ended' : 'continue';
  }

  /**
   * The runaway-loop backstop (spec §12): the watchdog only nudges, so a table that stays silent
   * or a DM who keeps handing off to a party that cannot act would otherwise loop forever. Pausing
   * is resumable, and the state that tripped it is derived from the log.
   */
  private pauseIfStuck(): void {
    const seat = this.config.seats.dm;
    if (this.state.stalledTurns >= this.silentTurnPauseLimit) {
      throw new SessionPausedError(
        seat,
        `No one has spoken or changed the game state for ${this.state.stalledTurns} turns in a ` +
          `row. Resuming gives the table another ${this.silentTurnPauseLimit} turns; check the ` +
          "seats' model output.",
        'backstop'
      );
    }
    if (this.state.idleHandOffs >= this.idleHandOffLimit) {
      throw new SessionPausedError(
        seat,
        `The DM handed off ${this.state.idleHandOffs} times in a row with no player character able ` +
          `to respond. Resuming gives the table another ${this.idleHandOffLimit} chances; resolve ` +
          'the downed party.',
        'backstop'
      );
    }
  }

  private async startSession(): Promise<void> {
    const recorder = this.newRecorder();
    recorder.emit({
      type: 'session_start',
      schemaVersion: EVENT_SCHEMA_VERSION,
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
    const partyForHandOff = this.state.partyIds.map((id) => ({
      id,
      name: ownEntry(this.state.combatants, id)?.name ?? id,
    }));
    const pcNames = partyForHandOff.map((pc) => pc.name);
    // Read at call time: start_combat can add monsters mid-turn, and the DM may list them next.
    const combatantNames = () =>
      Object.values(recorder.state.combatants).map((combatant) => combatant.name);
    let mechanicsCalled = false;
    let rejections = 0;
    let ended = false;
    let toolCalls = 0;
    let callLimitHit = false;
    let pcControlRetried = false;
    // Narrations (by collapsed text) that were cut to nothing this beat: a DM that resends one
    // verbatim is rejected as a duplicate without checking it again.
    const fullyCutNarrations = new Set<string>();
    // Shared by every path that rejects a narrate call as a duplicate of one already narrated (or,
    // for a resent fully cut narration, already cut) this beat. Each call site supplies its own
    // message, since what was or was not actually narrated differs.
    const rejectDuplicateNarration = (call: ToolCall, message: string) => {
      messages.push(toolMessage(call, message));
      this.flag(recorder, seat, 'duplicate_narration', rejections, 're_prompted');
    };
    const ALREADY_NARRATED =
      'Not narrated again: you already narrated that this turn. Continue with other tools, or call hand_off.';
    const MAX_RETELLS = 3;
    const ALREADY_TOLD =
      'Not narrated: this retells what you already narrated this turn. Do not describe this moment again; continue with other tools, or call hand_off.';
    const ALREADY_CUT =
      'Not narrated: every sentence of that narration was already cut this turn because it played player characters. Continue with other tools, or call hand_off.';
    // A DM-only note about the synthesized hand_off call, emitted once the loop reaches it and
    // its fate is known (`applyHandOffProse` cannot know yet whether it will run).
    const noteProseHandOff = (
      handOffProse: ReturnType<typeof applyHandOffProse>,
      call: ToolCall,
      reason?: string
    ) => {
      if (
        call.id !== handOffProse.proseHandOffCallId ||
        handOffProse.proseHandOffLines === undefined
      ) {
        return;
      }
      const base = handOffProseBase(handOffProse.proseHandOffLines);
      recorder.emit({
        type: 'ooc_note',
        visibility: 'dm',
        text:
          reason === undefined
            ? `${base} and treated as a hand_off call.`
            : `${base}. The hand_off call it implied was not executed: ${reason}.`,
      });
    };

    let retells = 0;
    let retellLimitHit = false;
    for (
      let step = 0;
      step < this.maxDmStepsPerBeat && !ended && !callLimitHit && !retellLimitHit;
      step++
    ) {
      const response = await this.callModel(seat, recorder.turnId, messages, DM_TOOL_SCHEMAS);
      const { calls: rawCalls, proseCallId } = dmCallsFromResponse(
        response,
        `auto-narrate-${step}`
      );
      const handOffProse = applyHandOffProse(rawCalls, partyForHandOff, step);
      if (handOffProse.note) {
        recorder.emit({ type: 'ooc_note', visibility: 'dm', text: handOffProse.note });
      }
      const calls = handOffProse.calls;
      // Prose that became a narrate call is not also kept as the assistant's text.
      messages.push({
        role: 'assistant',
        content: proseCallId || response.toolCalls.length === 0 ? '' : response.text,
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
        // The engine's prose call does not count toward the cap, so it never crowds out a real call.
        const counted = call.id !== proseCallId && call.id !== handOffProse.proseHandOffCallId;
        if (counted && !ended && !skipRest && toolCalls >= this.maxDmToolCallsPerBeat) {
          callLimitHit = true;
        }
        if (ended || skipRest || callLimitHit || retellLimitHit) {
          const why = ended
            ? 'your turn already ended with hand_off'
            : callLimitHit
              ? 'you reached the tool call limit for this turn'
              : retellLimitHit
                ? 'you kept retelling the same moment, so your turn is over'
                : 'an earlier call was rejected';
          messages.push(toolMessage(call, `Not executed: ${why}.`));
          noteProseHandOff(handOffProse, call, why);
          continue;
        }
        if (counted) toolCalls++;
        const prepared = prepareToolCall(call, DM_TOOLS);
        if (!prepared.ok) {
          messages.push(toolMessage(call, prepared.error));
          this.flag(recorder, seat, 'invalid_tool_call', rejections, 're_prompted');
          // Kept for review: the model only sees this in a tool message, not the committed log.
          recorder.emit({
            type: 'ooc_note',
            visibility: 'dm',
            text: `Invalid tool call (${call.name}): ${prepared.error}`,
          });
          noteProseHandOff(handOffProse, call, prepared.error);
          skipRest = true;
          continue;
        }
        let text = prepared.def.narrativeText?.(prepared.args);
        let args = prepared.args;
        let removed = '';
        // What each trim below cost this narration, held back until the call actually runs: the
        // trimmed text can still be rejected, or cut to nothing by a later trim, and then nothing
        // was cut from narration. A trim that cuts everything records itself where it happens.
        let leakTrim: string | null = null;
        let checkerTrim: CheckerTrim | null = null;
        let repeatsTrim: string | null = null;
        let violation = text
          ? validateDmText(text, {
              pcNames,
              combatantNames: combatantNames(),
              mechanicsToolCalled: mechanicsCalled,
              // The checker replaces this rule only while it is still working; once it has
              // disabled itself for the run, the verb list resumes so something is still watching.
              skipPcControl: Boolean(this.config.seats.checker) && !this.checkerDisabled,
            })
          : null;
        // A leak is mechanical (prompt state such as ids, HP blocks, or turn-order lines), so it
        // is stripped on sight instead of costing a rejection/retry: the good prose around it
        // survives. Only narrate calls are trimmed this way, matching the checker's trim path
        // below; a leak in another DM text path falls through to the ordinary violation handling.
        if (call.name === 'narrate' && violation?.rule === 'dm_state_leak') {
          const { kept: stripped, removed: leaked } = violation.strip ?? { kept: '', removed: [] };
          const listed = leaked.join(' | ');
          if (!stripped) {
            // Nothing survives, so there is nothing left to reject: the trim is final here.
            this.noteStateLeak(recorder, seat, listed);
            fullyCutNarrations.add(collapseWhitespace(text!));
            messages.push(
              toolMessage(call, `Not narrated: all of it leaked prompt state. ${listed}`)
            );
            continue;
          }
          leakTrim = listed;
          args = { ...(prepared.args as Record<string, unknown>), text: stripped };
          removed = ` Removed text that leaked prompt state: ${listed}`;
          text = stripped;
          violation = validateDmText(text, {
            pcNames,
            combatantNames: combatantNames(),
            mechanicsToolCalled: mechanicsCalled,
            skipPcControl: Boolean(this.config.seats.checker) && !this.checkerDisabled,
          });
        }
        if (call.name === 'narrate' && text && narratedThisBeat(recorder, text)) {
          rejectDuplicateNarration(call, ALREADY_NARRATED);
          continue;
        }
        // A paraphrase of this turn's earlier narration is turned away before it costs a checker
        // call. Exact repeats are left to the repeats trim below, so only what they leave counts.
        if (call.name === 'narrate' && text) {
          const earlier = narrationSinceLastEvent(recorder);
          const fresh = cutRepeats(text, { narratedThisBeat: earlier, recentPlayerLines: [] }).kept;
          if (fresh && retellsNarration(fresh, earlier)) {
            retells++;
            rejectDuplicateNarration(call, ALREADY_TOLD);
            // A DM stuck retelling one moment is not going to stop by itself (session 010 went on
            // until the tool-call limit), so after a few turned-away retellings the turn ends.
            if (retells >= MAX_RETELLS) retellLimitHit = true;
            continue;
          }
        }
        if (violation && call.id === proseCallId) {
          // Prose the engine turned into narration is dropped on a violation, without costing a
          // retry or blocking the calls the model actually made. A DM-only note keeps a record.
          messages.push(
            toolMessage(call, `Not narrated (${violation.rule}): ${violation.message}`)
          );
          recorder.emit({
            type: 'ooc_note',
            visibility: 'dm',
            text: `Dropped DM prose (${violation.rule}): ${text}`,
          });
          continue;
        }
        if (violation && rejections < this.maxValidatorRetries) {
          rejections++;
          messages.push(
            toolMessage(
              call,
              `Rejected (${violation.rule}): ${violation.message} Call the tool again with corrected text.`
            )
          );
          this.flag(recorder, seat, violation.rule, rejections, 're_prompted');
          skipRest = true;
          continue;
        }
        if (call.name === 'narrate' && text) {
          if (fullyCutNarrations.has(collapseWhitespace(text))) {
            // This exact narration was already cut to nothing this beat: nothing new to check.
            rejectDuplicateNarration(call, ALREADY_CUT);
            continue;
          }
          const { findings, reply } = await this.checkPcControl(recorder, text);
          if (findings.length > 0) {
            const listed = describeFindings(findings);
            if (call.id !== proseCallId && !pcControlRetried) {
              pcControlRetried = true;
              messages.push(
                toolMessage(
                  call,
                  `Rejected (${DM_CONTROLS_PC_CHECKER_RULE}): these sentences play player characters: ${listed}. Rewrite the narration without them and call narrate again.`
                )
              );
              this.flag(recorder, seat, DM_CONTROLS_PC_CHECKER_RULE, 1, 're_prompted');
              // Kept for review: the DM's rejected draft and the checker's raw reply, DM-only.
              recorder.emit({
                type: 'ooc_note',
                visibility: 'dm',
                text: `Rejected DM draft (${DM_CONTROLS_PC_CHECKER_RULE}): ${text}`,
              });
              this.logCheckerReply(recorder, reply);
              skipRest = true;
              continue;
            }
            // A second offense this beat, or prose the engine narrated: cut only those sentences.
            const kept = cutSentences(text, findings);
            if (kept && narratedThisBeat(recorder, kept)) {
              // The cut narration is identical to one already narrated this beat: treat it as a
              // duplicate instead of narrating (and flagging trimmed) a second time.
              rejectDuplicateNarration(call, ALREADY_NARRATED);
              continue;
            }
            const trim: CheckerTrim = { listed, retries: pcControlRetried ? 1 : 0, reply };
            if (!kept) {
              // Nothing survives for a later trim to cut away: this trim is final here.
              this.noteCheckerTrim(recorder, seat, trim);
              fullyCutNarrations.add(collapseWhitespace(text));
              messages.push(
                toolMessage(
                  call,
                  `Not narrated: every sentence played a player character. ${listed}`
                )
              );
              continue;
            }
            checkerTrim = trim;
            args = { ...(prepared.args as Record<string, unknown>), text: kept };
            removed += ` Removed sentences that played player characters: ${listed}`;
          }
        }
        // Last: cut any sentence that only repeats what this beat already narrated, or quotes a
        // player's own recent line back at them. Runs after both trims above so it sees their
        // output, not the model's original draft.
        if (call.name === 'narrate' && text) {
          const current = (args as Record<string, unknown>).text as string;
          // This beat's own narration, plus the DM's narration from the last few committed beats:
          // a line can repeat one said several beats ago, not only one said earlier in this beat.
          const recentNarrations = [
            ...recorder.events
              .filter((event) => event.type === 'narration')
              .map((event) => event.text),
            ...narrationsFromRecentBeats(this.history, REPEAT_LOOKBACK_BEATS),
          ];
          const repeats = cutRepeats(current, {
            narratedThisBeat: recentNarrations,
            recentPlayerLines: recentPlayerLines(this.history),
          });
          if (repeats.removed.length > 0) {
            const listed = repeats.removed.join(' | ');
            if (!repeats.kept) {
              // Nothing survives to narrate, so this trim is final here.
              this.noteRepeatsTrim(recorder, seat, listed);
              fullyCutNarrations.add(collapseWhitespace(current));
              messages.push(
                toolMessage(
                  call,
                  `Not narrated: every sentence repeated text already narrated this turn, or a player's own words. ${listed}`
                )
              );
              continue;
            }
            repeatsTrim = listed;
            args = { ...(args as Record<string, unknown>), text: repeats.kept };
            removed += ` Removed repeated sentences: ${listed}. They were already told; do not retell this moment.`;
          }
        }
        // The call is past every rejection and every later trim, so the trims above really did
        // reach narration. They are recorded in the order they cut.
        if (leakTrim !== null) this.noteStateLeak(recorder, seat, leakTrim);
        if (checkerTrim !== null) this.noteCheckerTrim(recorder, seat, checkerTrim);
        if (repeatsTrim !== null) this.noteRepeatsTrim(recorder, seat, repeatsTrim);
        const execution = await runPreparedCall(prepared.def, args, context);
        if (!execution.ok) {
          messages.push(toolMessage(call, `Error: ${execution.error}`));
          this.flag(recorder, seat, 'tool_error', rejections, 're_prompted');
          // Kept for review: the model only sees this in a tool message, not the committed log.
          recorder.emit({
            type: 'ooc_note',
            visibility: 'dm',
            text: `Tool error (${call.name}): ${execution.error}`,
          });
          noteProseHandOff(handOffProse, call, execution.error);
          skipRest = true;
          continue;
        }
        // Retries are exhausted: the output stands, flagged only once it actually took effect.
        if (violation) this.flag(recorder, seat, violation.rule, rejections, 'accepted_with_flag');
        if (MECHANICS_TOOL_NAMES.has(call.name)) mechanicsCalled = true;
        if (execution.outcome.endsBeat) ended = true;
        messages.push(toolMessage(call, execution.outcome.result + removed));
        noteProseHandOff(handOffProse, call);
      }
      // Past the target the closing instruction is repeated as its own message after each step:
      // in the DM's prompt it sits at the end of a long block, and session 012 narrated past it
      // for 14 spoken minutes until the hard stop cut the session off mid-scene.
      const phase = clockPhase(recorder.state, this.targetMinutes);
      if (!ended && (phase === 'end_at_scene_break' || phase === 'hard_stop')) {
        messages.push({ role: 'user', content: clockInstruction(phase) });
      }
    }

    if (!ended) {
      const rule = retellLimitHit
        ? 'dm_retell_limit'
        : callLimitHit
          ? 'dm_tool_call_limit'
          : 'dm_step_limit';
      this.flag(recorder, seat, rule, rejections, 'forced_hand_off');
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
      if (!takesTurn(combatant)) {
        const found = advanceCombat(recorder.state, { inclusive: true });
        if (found) recorder.emit({ type: 'combat_turn', ...found });
        else recorder.emit({ type: 'combat_end' });
      }
    }
    recorder.emit({ type: 'turn_end', actor: 'dm' });

    const phase = clockPhase(recorder.state, this.targetMinutes);
    const sceneBreak = recorder.events.some((event) => event.type === 'scene_change');
    if (sceneBreak && (phase === 'end_at_scene_break' || phase === 'hard_stop')) {
      this.closeCombatIfRunning(recorder);
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
      view: playerView(this.state, pcId),
      transcript: this.transcript('player'),
      instruction,
    });
    const otherPcNames = this.state.partyIds
      .filter((id) => id !== pcId)
      .map((id) => ownEntry(this.state.combatants, id)?.name ?? id);
    const context = this.toolContext(recorder, pcId, seat);
    // The whole session's public lines, not a window: nothing is committed to `this.history`
    // mid-turn, so this stays accurate across every retry below.
    const earlierLines = pcDialogueLines(this.history, pcId);
    let repeatRePrompted = false;

    for (let attempt = 0; ; attempt++) {
      const response = await this.callModel(seat, recorder.turnId, messages, PLAYER_TOOL_SCHEMAS);
      const calls = callsFromResponse(response, 'speak', `auto-speak-${attempt}`);
      messages.push({
        role: 'assistant',
        content: response.toolCalls.length > 0 ? response.text : '',
        toolCalls: calls,
      });

      const accepted: { call: ToolCall; def: AnyToolDef; args: unknown }[] = [];
      const problems: { rule: string; message: string }[] = [];
      let repeatsToFlag = false;
      for (const call of calls) {
        const prepared = prepareToolCall(call, PLAYER_TOOLS);
        if (!prepared.ok) {
          problems.push({ rule: 'invalid_tool_call', message: prepared.error });
          // Kept for review: the model only sees this in a tool message, not the committed log.
          recorder.emit({
            type: 'ooc_note',
            visibility: 'dm',
            text: `Invalid tool call (${call.name}): ${prepared.error}`,
          });
          continue;
        }
        const text = prepared.def.narrativeText?.(prepared.args);
        const violation = text ? validatePlayerText(text, { otherPcNames }) : null;
        if (violation) {
          problems.push(violation);
          continue;
        }
        if (text && REPEAT_CHECKED_TOOL_NAMES.has(prepared.def.name)) {
          const repeats = repeatedSentences(text, earlierLines);
          if (repeats.length > 0) {
            // Only re-prompt while the turn still has a retry to spend: without that check the
            // call would be dropped here and never re-issued, losing the line.
            if (!repeatRePrompted && attempt < this.maxValidatorRetries) {
              repeatRePrompted = true;
              problems.push({
                rule: 'player_repeats_self',
                message: `You already said that this session: "${repeats[0]}". Say something new, in your own words.`,
              });
              continue;
            }
            // No retry left, or re-prompted once already this turn and it still repeats: speak it
            // as-is (spec: never drop or trim a player's words) and flag it once the call actually
            // executes below.
            repeatsToFlag = true;
          }
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
        this.flag(recorder, seat, ruleList(problems), attempt + 1, 're_prompted');
        continue;
      }

      // At this point `problems` is empty unless retries are exhausted (otherwise we would have
      // re-prompted above), so a checkpoint here brackets exactly this attempt's accepted calls.
      const checkpoint = recorder.checkpoint();
      let tookTurn = false;
      const toolErrors: { name: string; message: string }[] = [];
      for (const item of accepted) {
        const execution = await runPreparedCall(item.def, item.args, context);
        if (!execution.ok) {
          problems.push({ rule: 'tool_error', message: execution.error });
          toolErrors.push({ name: item.def.name, message: execution.error });
          continue;
        }
        if (TURN_ACTION_TOOL_NAMES.has(item.def.name)) tookTurn = true;
      }

      const executionFailed = problems.some((problem) => problem.rule === 'tool_error');
      if (executionFailed && attempt < this.maxValidatorRetries) {
        // Roll back so none of this attempt's successful calls leave events behind, then log the
        // errors (after the rollback, so the notes survive it) and re-prompt instead of forcing a
        // pass.
        recorder.rollback(checkpoint);
        this.logToolErrors(recorder, toolErrors);
        const summary = problems.map((problem) => `${problem.rule}: ${problem.message}`).join(' ');
        for (const call of calls) messages.push(toolMessage(call, `Not executed. ${summary}`));
        this.flag(recorder, seat, ruleList(problems), attempt + 1, 're_prompted');
        continue;
      }
      this.logToolErrors(recorder, toolErrors);

      // An accepted repeat joins whatever else this attempt hit, so its flag is not lost when the
      // same attempt also had, say, a tool error.
      const flagged = repeatsToFlag ? [...problems, { rule: 'player_repeats_self' }] : problems;
      if (flagged.length > 0) {
        this.flag(
          recorder,
          seat,
          ruleList(flagged),
          attempt,
          tookTurn ? 'accepted_with_flag' : 'forced_pass'
        );
      }
      if (!tookTurn) recorder.emit({ type: 'pass', actor: pcId });
      break;
    }

    recorder.emit({ type: 'turn_end', actor: pcId });
    await this.commit(recorder);
  }

  /**
   * A dying PC's turn (spec §5): the engine rolls the death saving throw itself, with no model
   * call, records the roll and whatever it changed, then advances the combat turn as any turn
   * does. It writes no prose — the DM sees the roll in its transcript and narrates it next beat.
   */
  private async deathSaveTurn(combatantId: string): Promise<void> {
    const recorder = this.newRecorder();
    const combatant = ownEntry(this.state.combatants, combatantId);
    if (!combatant) throw new Error(`No combatant "${combatantId}" to roll a death save for`);
    const d20 = rollD20(this.deps.rng);
    const { combatant: after } = rollDeathSave(combatant, d20.natural);
    recorder.emit({
      type: 'roll',
      actor: combatant.id,
      kind: 'save',
      label: `${combatant.name} death saving throw`,
      expr: '1d20',
      rolls: d20.rolls,
      modifier: 0,
      total: d20.natural,
      target: DEATH_SAVE_DC,
      outcome: d20.natural >= DEATH_SAVE_DC ? 'success' : 'failure',
      mode: d20.mode,
    });
    emitCombatantChanges(recorder, combatant, after, 'death_save');
    recorder.emit({ type: 'turn_end', actor: combatant.id });
    const advance = advanceCombat(recorder.state);
    if (advance) recorder.emit({ type: 'combat_turn', ...advance });
    else recorder.emit({ type: 'combat_end' });
    await this.commit(recorder);
  }

  /** Closes combat before the session ends, so a fight is never left running across the cut. */
  private closeCombatIfRunning(recorder: TurnRecorder): void {
    if (recorder.state.combat) recorder.emit({ type: 'combat_end' });
  }

  /** Records a validator outcome for the lore audit and review (spec §5.6: every case is flagged). */
  private flag(
    recorder: TurnRecorder,
    seat: string,
    rule: string,
    retries: number,
    resolution: 're_prompted' | 'accepted_with_flag' | 'forced_pass' | 'forced_hand_off' | 'trimmed'
  ): void {
    recorder.emit({ type: 'validator_flag', visibility: 'dm', seat, rule, retries, resolution });
  }

  /** Records a `dm_state_leak` trim: the flag, and a DM-only note naming the lines it cut. */
  private noteStateLeak(recorder: TurnRecorder, seat: string, listed: string): void {
    this.flag(recorder, seat, 'dm_state_leak', 0, 'trimmed');
    recorder.emit({
      type: 'ooc_note',
      visibility: 'dm',
      text: `Cut from DM narration (dm_state_leak): ${listed}`,
    });
  }

  /** Records a checker trim: the flag, a DM-only note naming the sentences it cut, and the reply. */
  private noteCheckerTrim(recorder: TurnRecorder, seat: string, trim: CheckerTrim): void {
    this.flag(recorder, seat, DM_CONTROLS_PC_CHECKER_RULE, trim.retries, 'trimmed');
    recorder.emit({
      type: 'ooc_note',
      visibility: 'dm',
      text: `Cut from DM narration (${DM_CONTROLS_PC_CHECKER_RULE}): ${trim.listed}`,
    });
    this.logCheckerReply(recorder, trim.reply);
  }

  /** Records a `repeated_text` trim: the flag, and a DM-only note naming the sentences it cut. */
  private noteRepeatsTrim(recorder: TurnRecorder, seat: string, listed: string): void {
    this.flag(recorder, seat, 'repeated_text', 0, 'trimmed');
    recorder.emit({
      type: 'ooc_note',
      visibility: 'dm',
      text: `Cut from DM narration (repeated_text): ${listed}`,
    });
  }

  /** Kept for review: the checker's raw reply text, DM-only. Logs nothing when there is none. */
  private logCheckerReply(recorder: TurnRecorder, reply: string | undefined): void {
    if (reply !== undefined && reply.trim() !== '') {
      recorder.emit({ type: 'ooc_note', visibility: 'dm', text: `Checker reply: ${reply}` });
    }
  }

  /** Kept for review, DM-only: one tool error's message. Callers log this after any rollback. */
  private logToolErrors(
    recorder: TurnRecorder,
    errors: readonly { name: string; message: string }[]
  ): void {
    for (const error of errors) {
      recorder.emit({
        type: 'ooc_note',
        visibility: 'dm',
        text: `Tool error (${error.name}): ${error.message}`,
      });
    }
  }

  /**
   * Asks the checker seat which sentences of a DM narration play a player character, and returns
   * only findings that really appear in the narration, plus the checker's raw reply text (for the
   * caller to log alongside a retry or a cut) when one was received. Never pauses the session: a
   * failed or unreadable check leaves the narration unchecked, with a DM-only note (and, when a
   * reply was received but unreadable, the raw reply logged right after), and repeated failures
   * stop checking for the rest of the run.
   */
  private async checkPcControl(
    recorder: TurnRecorder,
    narration: string
  ): Promise<{ findings: PcControlFinding[]; reply?: string }> {
    const seat = this.config.seats.checker;
    if (!seat || this.checkerDisabled) return { findings: [] };
    const members = this.state.partyIds.map((id) => ({
      id,
      name: ownEntry(this.state.combatants, id)?.name ?? id,
    }));
    const messages = this.deps.prompts.pcControlCheck({
      party: members.map((pc) => pc.name),
      declarations: declarationsSinceDm(this.history, this.state),
      narration,
    });
    let findings: PcControlFinding[] | null = null;
    let failure = 'Checker reply unreadable; narration not checked.';
    let reply: string | undefined;
    try {
      const response = ModelResponse.safeParse(
        await this.deps.model.complete({
          seat,
          turnId: recorder.turnId,
          messages,
          tools: [],
          toolChoice: 'auto',
          incompleteReplyAttempts: CHECKER_REPLY_ATTEMPTS,
        })
      );
      if (response.success) {
        reply = response.data.text;
        findings = parseCheckerReply(response.data.text);
      }
    } catch (error) {
      failure = `Checker unavailable (${error instanceof Error ? error.message : String(error)}); narration not checked.`;
    }
    if (findings === null) {
      this.checkerFailures++;
      recorder.emit({ type: 'ooc_note', visibility: 'dm', text: failure });
      this.logCheckerReply(recorder, reply);
      if (this.checkerFailures >= this.maxCheckerFailures) {
        this.checkerDisabled = true;
        recorder.emit({
          type: 'ooc_note',
          visibility: 'dm',
          text: `Checker failed ${this.checkerFailures} times in a row; narration is not checked for the rest of this run.`,
        });
      }
      return { findings: [] };
    }
    this.checkerFailures = 0;
    const npcNames = [
      ...Object.values(this.state.npcs).map((npc) => npc.name),
      ...Object.values(this.state.combatants)
        .filter((combatant) => combatant.kind !== 'pc')
        .map((combatant) => combatant.name),
    ];
    return {
      findings: verifyFindings(narration, partyFindings(findings, members, npcNames)),
      reply,
    };
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
        ? `${name} has declared their combat action (see recent events). Resolve it with tools, narrate the result, then call hand_off.` +
          // Not dead code: the cap belongs to combat, and a "resolve" beat outside combat would
          // otherwise inherit it silently. `nextActor` only asks for one during a fight today, so
          // the guard keeps that coupling explicit rather than assumed.
          (this.state.combat !== null
            ? " Keep this turn's narration to at most three sentences: what the character's action " +
              'achieves and what it costs. Save detail for scene beats.'
            : '')
        : reason === 'monster'
          ? `It is ${name}'s turn (id: ${combatantId}). Act for it with tools, narrate, then call hand_off. ` +
            "Keep this turn's narration to at most three sentences: what the creature does and what it costs. " +
            'Save detail for scene beats.'
          : 'Continue the story: narrate what happens next, resolve any declared actions with tools, then call hand_off.';
    const clock = clockInstruction(clockPhase(this.state, this.targetMinutes));
    return [nudge, base, shareInstruction(this.state), clock].filter(Boolean).join(' ');
  }

  /**
   * Runs `operation`, retrying any failure after each of `retryDelaysMs` in turn; once the delays
   * run out, pauses the session on `seat` with the last failure's message.
   */
  private async withRetries<T>(seat: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
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

  /** Calls the model and validates its response; a malformed response is a failed attempt. */
  private callModel(
    seat: string,
    turnId: string,
    messages: ChatMessage[],
    tools: ToolSchema[]
  ): Promise<ModelResponse> {
    return this.withRetries(seat, async () => {
      const parsed = ModelResponse.safeParse(
        // Every turn must end in a tool call (hand_off, speak, act, pass...), so require one;
        // a seat's client config may relax this for servers that do not support it.
        await this.deps.model.complete({ seat, turnId, messages, tools, toolChoice: 'required' })
      );
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`
        );
        throw new Error(`Malformed model response (${issues.join('; ')})`);
      }
      return parsed.data;
    });
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
      clockPhase: () => clockPhase(recorder.state, this.targetMinutes),
      actorId,
      seat,
    };
  }

  /** Retries a lore search on the same schedule as model calls, then pauses seat "lore". */
  private searchLore(query: string, limit: number): Promise<LoreHit[]> {
    return this.withRetries('lore', () => this.deps.lore.search(query, limit));
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
