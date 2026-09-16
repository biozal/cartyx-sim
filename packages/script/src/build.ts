import {
  applyEvent,
  countWords,
  initialState,
  ownEntry,
  slugify,
  type GameState,
  type SimEvent,
} from '@cartyx-sim/core';
import { fallbackLabels, type Labeler, type LabelRequest, type SpanLabel } from './attribution';
import { invariantViolations } from './invariants';
import { narrationPieces, segmentNarration, type QuoteLabel } from './narration';
import { finishLine, sliceText, type Range } from './normalize';
import {
  isVoiced,
  SCRIPT_SCHEMA_VERSION,
  ScriptError,
  ScriptFile,
  type DroppedSpan,
  type DropReason,
  type LineDraft,
  type LineKind,
  type Note,
  type ScriptLine,
  type SpeakerOverrides,
  type VoicedLine,
} from './schema';
import { applySpeakerOverrides, SpeakerTable } from './speakers';
import { cleanAction, splitSpeech } from './speech';

export interface BuildInput {
  campaign: string;
  session: number;
  eventsSha256: string;
  events: readonly SimEvent[];
  /** Attributes quotes in narration; without one, rules decide. */
  labeler?: Labeler;
  speakers?: SpeakerOverrides;
}

export interface BuildStats {
  lines: Partial<Record<LineKind, number>>;
  /** Quotes labeled by each source. */
  labels: { model: number; cache: number; fallback: number };
  stageDirections: number;
  spokenWords: number;
  /** Ids of NPC speakers with no `npc_introduced` event. */
  unlisted: string[];
}

type VoicedDraft = Omit<VoicedLine, 'id'>;
type SessionStart = Extract<SimEvent, { type: 'session_start' }>;
type Narration = Extract<SimEvent, { type: 'narration' }>;
type Dialogue = Extract<SimEvent, { type: 'dialogue' }>;
type Action = Extract<SimEvent, { type: 'action' }>;

interface Draft {
  line: LineDraft;
  /** The seq of the event an interjection talks over. */
  overlapsSeq?: number;
}

const NO_LINE_NOTE = 'Dropped text from an event that produced no line.';

function nameOf(state: GameState, id: string): string {
  return ownEntry(state.combatants, id)?.name ?? ownEntry(state.npcs, id)?.name ?? id;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function voiced(
  kind: VoicedLine['kind'],
  speaker: string,
  seq: number,
  raw: string,
  ranges: readonly Range[],
  emotion: VoicedLine['emotion']
): VoicedDraft | null {
  const text = finishLine(sliceText(raw, ranges));
  if (text === '') return null;
  const sources = ranges.map((range) => ({ seq, start: range.start, end: range.end }));
  return { kind, speaker, text, emotion, sources };
}

function isDraft(line: VoicedDraft | null): line is VoicedDraft {
  return line !== null;
}

function toDropped(seq: number, raw: string, range: Range, reason: DropReason): DroppedSpan {
  const { start, end } = range;
  return { seq, start, end, reason, text: raw.slice(start, end) };
}

class ScriptBuilder {
  readonly drafts: Draft[] = [];
  readonly notes: Note[] = [];
  readonly speakers: SpeakerTable;
  readonly counts = { model: 0, cache: 0, fallback: 0, stageDirections: 0 };
  private state: GameState = initialState();
  private readonly party: { id: string; name: string }[];
  private readonly descriptions = new Map<string, string>();
  private sceneNpcs: string[] = [];
  private readonly newLabels: string[] = [];

  constructor(
    private readonly input: BuildInput,
    start: SessionStart
  ) {
    this.party = start.party.map((pc) => ({ id: pc.id, name: pc.name }));
    this.speakers = new SpeakerTable(this.party);
  }

  async run(): Promise<void> {
    let pause: { seq: number; reason: string } | undefined;
    for (const event of this.input.events) {
      this.state = applyEvent(this.state, event);
      if (event.type === 'session_paused') {
        pause = { seq: event.seq, reason: event.reason };
        continue;
      }
      if (pause) {
        this.push({
          kind: 'pause',
          sources: [{ seq: pause.seq }],
          pause: { reason: pause.reason },
        });
        pause = undefined;
      }
      if (event.type === 'scene_change') this.sceneNpcs = [];
      if (event.type === 'npc_introduced') {
        this.descriptions.set(event.npcId, event.description);
        if (!this.sceneNpcs.includes(event.npcId)) this.sceneNpcs.push(event.npcId);
      }
      if (event.visibility === 'public') await this.add(event);
    }
  }

  private push(line: LineDraft, overlapsSeq?: number): void {
    this.drafts.push(overlapsSeq === undefined ? { line } : { line, overlapsSeq });
  }

  private async add(event: SimEvent): Promise<void> {
    const seq = event.seq;
    switch (event.type) {
      case 'dialogue':
        return this.addSpeech(event);
      case 'action':
        return this.addAction(event);
      case 'narration':
        return this.addNarration(event);
      case 'roll':
        return this.push({
          kind: 'roll',
          sources: [{ seq }],
          roll: {
            actor: event.actor,
            actorName: nameOf(this.state, event.actor),
            kind: event.kind,
            label: event.label,
            total: event.total,
            target: event.target,
            outcome: event.outcome,
            mode: event.mode,
            subject: event.subject,
            subjectName:
              event.subject === undefined ? undefined : nameOf(this.state, event.subject),
          },
        });
      case 'scene_change':
        return this.push({
          kind: 'scene',
          sources: [{ seq }],
          scene: {
            location: event.location,
            artPrompt: event.artPrompt,
            loreEntityId: event.loreEntityId,
          },
        });
      case 'combat_start':
        return this.push({
          kind: 'combat',
          sources: [{ seq }],
          combat: {
            phase: 'start',
            order: event.order.map((entry) => ({
              combatantId: entry.combatantId,
              name: nameOf(this.state, entry.combatantId),
              total: entry.total,
            })),
          },
        });
      case 'combat_turn':
        return this.push({
          kind: 'combat',
          sources: [{ seq }],
          combat: {
            phase: 'turn',
            round: event.round,
            combatantId: event.combatantId,
            name: nameOf(this.state, event.combatantId),
          },
        });
      case 'combat_end':
        return this.push({ kind: 'combat', sources: [{ seq }], combat: { phase: 'end' } });
      case 'state_change': {
        if (event.field !== 'hp' && event.field !== 'conditions' && event.field !== 'dead') {
          return;
        }
        if (event.field === 'dead' && event.after !== true) return;
        return this.push({
          kind: 'state',
          sources: [{ seq }],
          state: {
            entity: event.entity,
            name: nameOf(this.state, event.entity),
            field: event.field,
            before: event.before,
            after: event.after,
            hidden: ownEntry(this.state.combatants, event.entity)?.kind !== 'pc',
          },
        });
      }
      default:
        return;
    }
  }

  private addSpeech(event: Dialogue): void {
    const split = splitSpeech(event.text);
    const speaker =
      event.speakerKind === 'pc'
        ? this.speakers.pc(event.speaker)
        : this.speakers.npc(event.speaker, nameOf(this.state, event.speaker));
    const lines = split.lines
      .map((ranges) => voiced('dialogue', speaker, event.seq, event.text, ranges, event.emotion))
      .filter(isDraft);
    const dropped = split.directions.map((range) =>
      toDropped(event.seq, event.text, range, 'stage_direction')
    );
    this.counts.stageDirections += dropped.length;
    this.pushEvent(event.seq, lines, dropped, event.overlaps);
  }

  private addAction(event: Action): void {
    const { ranges } = cleanAction(event.intent);
    const speaker =
      ownEntry(this.state.combatants, event.actor)?.kind === 'pc'
        ? this.speakers.pc(event.actor)
        : this.speakers.npc(event.actor, nameOf(this.state, event.actor));
    const line = voiced('action', speaker, event.seq, event.intent, ranges, 'neutral');
    this.pushEvent(event.seq, line ? [line] : [], []);
  }

  private async addNarration(event: Narration): Promise<void> {
    const segmented = segmentNarration(event.text, this.party);
    const labels =
      segmented.quotes.length === 0 ? [] : await this.labelQuotes(event.seq, segmented);
    const lines = narrationPieces(segmented, labels)
      .map((piece) => {
        const emotion = piece.kind === 'dialogue' ? 'neutral' : event.emotion;
        const line = voiced(
          piece.kind,
          piece.speaker,
          event.seq,
          event.text,
          piece.ranges,
          emotion
        );
        if (line && piece.dmWrotePc) line.flags = { dmWrotePc: piece.dmWrotePc };
        return line;
      })
      .filter(isDraft);
    const dropped = segmented.dropped.map((span) =>
      toDropped(event.seq, event.text, span, span.reason)
    );
    this.pushEvent(event.seq, lines, dropped);
  }

  private async labelQuotes(
    seq: number,
    segmented: ReturnType<typeof segmentNarration>
  ): Promise<QuoteLabel[]> {
    const request: LabelRequest = {
      seq,
      narration: segmented.promptText,
      quotes: segmented.quotes.map((quote) => quote.text),
      npcs: Object.values(this.state.npcs).map((npc) => ({
        id: npc.npcId,
        name: npc.name,
        description: this.descriptions.get(npc.npcId) ?? '',
      })),
      pcs: this.party.map((pc) => ({ ...pc })),
      newLabels: [...this.newLabels],
    };
    const result = this.input.labeler ? await this.input.labeler.label(request) : undefined;
    let labels: SpanLabel[];
    if (result?.labels) {
      labels = result.labels;
      this.counts[result.source] += labels.length;
    } else {
      labels = fallbackLabels(request, this.sceneNpcs);
      this.counts.fallback += labels.length;
      if (result) this.notes.push({ seq, text: `Quotes attributed by rules: ${result.reason}.` });
    }
    return labels.map((label) => this.toQuoteLabel(label, seq));
  }

  private toQuoteLabel(label: SpanLabel, seq: number): QuoteLabel {
    switch (label.kind) {
      case 'none':
        return { kind: 'narration' };
      case 'pc':
        return { kind: 'speech', speaker: 'dm', dmWrotePc: label.id };
      case 'npc':
        return {
          kind: 'speech',
          speaker: this.speakers.npc(label.id, nameOf(this.state, label.id)),
        };
      case 'new': {
        if (!this.newLabels.includes(label.label)) this.newLabels.push(label.label);
        const id = `npc-${slugify(label.label)}`;
        const speaker = ownEntry(this.state.npcs, id)
          ? this.speakers.npc(id, nameOf(this.state, id))
          : this.speakers.unlisted(id, capitalize(label.label), seq);
        return { kind: 'speech', speaker };
      }
    }
  }

  /**
   * Adds one event's lines. Each dropped span goes on the last of those lines that starts at or
   * before it (else the first); with no line, the spans go on a note.
   */
  private pushEvent(
    seq: number,
    lines: VoicedDraft[],
    dropped: DroppedSpan[],
    overlapsSeq?: number
  ): void {
    if (lines.length === 0) {
      if (dropped.length > 0) this.notes.push({ seq, text: NO_LINE_NOTE, dropped });
      return;
    }
    for (const span of dropped) {
      const owner = lines.findLast((line) => line.sources[0]!.start <= span.start) ?? lines[0]!;
      (owner.dropped ??= []).push(span);
    }
    lines.forEach((line, index) => this.push(line, index === 0 ? overlapsSeq : undefined));
  }
}

function assignIds(drafts: readonly Draft[]): ScriptLine[] {
  const firstLine = new Map<number, string>();
  const lines = drafts.map((draft, index) => {
    const id = `L${String(index + 1).padStart(4, '0')}`;
    const seq = draft.line.sources[0]!.seq;
    if (!firstLine.has(seq)) firstLine.set(seq, id);
    return { ...draft.line, id } as ScriptLine;
  });
  drafts.forEach((draft, index) => {
    const line = lines[index]!;
    if (draft.overlapsSeq === undefined || !isVoiced(line)) return;
    const target = firstLine.get(draft.overlapsSeq);
    if (target !== undefined && target !== line.id) line.overlaps = target;
  });
  return lines;
}

function summarize(script: ScriptFile, counts: ScriptBuilder['counts']): BuildStats {
  const lines: Partial<Record<LineKind, number>> = {};
  let spokenWords = 0;
  for (const line of script.lines) {
    lines[line.kind] = (lines[line.kind] ?? 0) + 1;
    if (isVoiced(line)) spokenWords += countWords(line.text);
  }
  return {
    lines,
    labels: { model: counts.model, cache: counts.cache, fallback: counts.fallback },
    stageDirections: counts.stageDirections,
    spokenWords,
    unlisted: script.speakers.filter((speaker) => speaker.unlisted).map((speaker) => speaker.id),
  };
}

/**
 * Turns an event log into a script. Text only ever comes from the log: the build drops, splits,
 * and attributes it, and checks its own output with `invariantViolations` before returning.
 */
export async function buildScript(
  input: BuildInput
): Promise<{ script: ScriptFile; stats: BuildStats }> {
  const start = input.events[0];
  if (!start || start.type !== 'session_start') {
    throw new ScriptError('The event log does not begin with session_start.');
  }
  const builder = new ScriptBuilder(input, start);
  await builder.run();
  let lines = assignIds(builder.drafts);
  let speakers = builder.speakers.list();
  if (input.speakers) {
    ({ speakers, lines } = applySpeakerOverrides(speakers, lines, input.speakers));
  }
  const script = ScriptFile.parse({
    scriptSchemaVersion: SCRIPT_SCHEMA_VERSION,
    campaign: input.campaign,
    session: input.session,
    eventsSha256: input.eventsSha256,
    speakers,
    lines,
    notes: builder.notes,
  });
  const violations = invariantViolations(script, input.events);
  if (violations.length > 0) {
    throw new Error(`The script build broke its own rules (a bug):\n${violations.join('\n')}`);
  }
  return { script, stats: summarize(script, builder.counts) };
}
