import { Emotion } from '@cartyx-sim/core';
import { z } from 'zod';

/** Bumped whenever `script.json` changes incompatibly. */
export const SCRIPT_SCHEMA_VERSION = 1;

/** A problem the user can fix (a bad `speakers.json`, a log that cannot be scripted). */
export class ScriptError extends Error {
  override name = 'ScriptError';
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const Speaker = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['dm', 'pc', 'npc']),
  /** An NPC the DM voiced without an `npc_introduced` event. */
  unlisted: z.boolean().optional(),
  /** The seq of the event where an unlisted NPC first speaks. */
  firstSeq: z.number().int().min(0).optional(),
});
export type Speaker = z.infer<typeof Speaker>;

/** Character offsets `[start, end)` into an event's text (`text`, or `intent` for actions). */
export const TextSource = z.object({
  seq: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type TextSource = z.infer<typeof TextSource>;

export const DropReason = z.enum(['stage_direction', 'hand_off', 'dm_prefix']);
export type DropReason = z.infer<typeof DropReason>;

export const DroppedSpan = TextSource.extend({ reason: DropReason, text: z.string() });
export type DroppedSpan = z.infer<typeof DroppedSpan>;

const EventSource = z.object({ seq: z.number().int().min(0) });
const LineId = z.string().regex(/^L\d{4,}$/);

export const VoicedLine = z.object({
  id: LineId,
  kind: z.enum(['narration', 'dialogue', 'action']),
  speaker: z.string().min(1),
  text: z.string().min(1),
  emotion: Emotion,
  sources: z.array(TextSource).min(1),
  dropped: z.array(DroppedSpan).optional(),
  /** The id of the line this interjection talks over. */
  overlaps: LineId.optional(),
  /** Set when the DM wrote this player character's words; the line stays in the DM's voice. */
  flags: z.object({ dmWrotePc: z.string().min(1) }).optional(),
});
export type VoicedLine = z.infer<typeof VoicedLine>;

export const RollLine = z.object({
  id: LineId,
  kind: z.literal('roll'),
  sources: z.array(EventSource).length(1),
  roll: z.object({
    actor: z.string(),
    actorName: z.string(),
    kind: z.enum(['check', 'save', 'attack', 'damage', 'healing', 'initiative']),
    label: z.string(),
    total: z.number().int(),
    target: z.number().int().optional(),
    outcome: z.enum(['success', 'failure', 'hit', 'miss', 'critical']).optional(),
    mode: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
    subject: z.string().optional(),
    subjectName: z.string().optional(),
  }),
});
export type RollLine = z.infer<typeof RollLine>;

export const SceneLine = z.object({
  id: LineId,
  kind: z.literal('scene'),
  sources: z.array(EventSource).length(1),
  scene: z.object({
    location: z.string(),
    artPrompt: z.string(),
    loreEntityId: z.string().optional(),
  }),
});
export type SceneLine = z.infer<typeof SceneLine>;

export const CombatLine = z.object({
  id: LineId,
  kind: z.literal('combat'),
  sources: z.array(EventSource).length(1),
  combat: z.discriminatedUnion('phase', [
    z.object({
      phase: z.literal('start'),
      order: z.array(z.object({ combatantId: z.string(), name: z.string(), total: z.number() })),
    }),
    z.object({
      phase: z.literal('turn'),
      round: z.number().int(),
      combatantId: z.string(),
      name: z.string(),
    }),
    z.object({ phase: z.literal('end') }),
  ]),
});
export type CombatLine = z.infer<typeof CombatLine>;

export const StateLine = z.object({
  id: LineId,
  kind: z.literal('state'),
  sources: z.array(EventSource).length(1),
  state: z.object({
    entity: z.string(),
    name: z.string(),
    field: z.enum(['hp', 'conditions', 'dead', 'deathSaves', 'stable']),
    before: z.unknown(),
    after: z.unknown(),
    /** True for anyone but a player character: the book hides their HP numbers. */
    hidden: z.boolean(),
  }),
});
export type StateLine = z.infer<typeof StateLine>;

export const PauseLine = z.object({
  id: LineId,
  kind: z.literal('pause'),
  sources: z.array(EventSource).length(1),
  pause: z.object({ reason: z.string() }),
});
export type PauseLine = z.infer<typeof PauseLine>;

export const ScriptLine = z.union([
  VoicedLine,
  RollLine,
  SceneLine,
  CombatLine,
  StateLine,
  PauseLine,
]);
export type ScriptLine = z.infer<typeof ScriptLine>;
export type LineKind = ScriptLine['kind'];
export type LineDraft = DistributiveOmit<ScriptLine, 'id'>;

/** The line kinds that carry spoken `text` and a `speaker`, as opposed to a silent cue. */
export const VOICED_KINDS: readonly LineKind[] = ['narration', 'dialogue', 'action'];

/** Whether `line` is one of the voiced kinds (`VOICED_KINDS`), narrowing it to `VoicedLine`. */
export function isVoiced(line: ScriptLine): line is VoicedLine {
  return VOICED_KINDS.includes(line.kind);
}

export const Note = z.object({
  seq: z.number().int().min(0),
  text: z.string().min(1),
  /** Spans dropped from an event that produced no line to attach them to. */
  dropped: z.array(DroppedSpan).optional(),
});
export type Note = z.infer<typeof Note>;

export const ScriptFile = z.object({
  scriptSchemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  campaign: z.string().min(1),
  session: z.number().int().min(1),
  eventsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  speakers: z.array(Speaker),
  lines: z.array(ScriptLine),
  notes: z.array(Note),
});
export type ScriptFile = z.infer<typeof ScriptFile>;

/** `speakers.json`: per speaker id, an optional merge target and an optional display name. */
export const SpeakerOverrides = z.record(
  z.string().min(1),
  z.object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() }).strict()
);
export type SpeakerOverrides = z.infer<typeof SpeakerOverrides>;
