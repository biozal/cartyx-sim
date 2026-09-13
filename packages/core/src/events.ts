import { Combatant, InitiativeEntry } from '@cartyx-sim/rules';
import { z } from 'zod';

export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'amused',
  'angry',
  'sad',
  'afraid',
  'surprised',
  'whisper',
  'sarcastic',
  'determined',
  'pained',
] as const;
export const Emotion = z.enum(EMOTIONS);
export type Emotion = z.infer<typeof Emotion>;

export const Visibility = z.enum(['public', 'dm']);
export type Visibility = z.infer<typeof Visibility>;

export const StateField = z.enum([
  'hp',
  'tempHp',
  'maxHp',
  'conditions',
  'dead',
  'spellSlots',
  'inventory',
  'level',
]);
export type StateField = z.infer<typeof StateField>;

export const HandOffTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pcs'), ids: z.array(z.string().min(1).max(200)).min(1) }),
  z.object({ kind: z.literal('party') }),
  z.object({ kind: z.literal('open') }),
]);
export type HandOffTarget = z.infer<typeof HandOffTarget>;

const base = {
  seq: z.number().int().min(0),
  ts: z.string().min(1),
  turnId: z.string().min(1),
  visibility: Visibility,
};

export const SimEvent = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session_start'),
    session: z.number().int().min(1),
    loreCommit: z.string(),
    targetMinutes: z.number().positive(),
    party: z.array(Combatant).min(1),
  }),
  z.object({
    ...base,
    type: z.literal('session_end'),
    reason: z.enum(['target_reached', 'hard_stop', 'manual']),
  }),
  z.object({
    ...base,
    type: z.literal('narration'),
    speaker: z.literal('dm'),
    text: z.string().min(1),
    emotion: Emotion,
  }),
  z.object({
    ...base,
    type: z.literal('dialogue'),
    speaker: z.string().min(1),
    speakerKind: z.enum(['pc', 'npc']),
    text: z.string().min(1),
    emotion: Emotion,
    overlaps: z.number().int().min(0).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('action'),
    actor: z.string().min(1),
    intent: z.string().min(1),
    target: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('pass'), actor: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('roll'),
    actor: z.string().min(1),
    kind: z.enum(['check', 'save', 'attack', 'damage', 'healing', 'initiative']),
    label: z.string().min(1),
    expr: z.string().min(1),
    rolls: z.array(z.number().int()),
    modifier: z.number().int(),
    total: z.number().int(),
    target: z.number().int().optional(),
    outcome: z.enum(['success', 'failure', 'hit', 'miss', 'critical']).optional(),
    /** d20 mode, set on checks, saves, and attacks. */
    mode: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
    /** The combatant this roll affects, when it differs from the roller (e.g. an attack target). */
    subject: z.string().min(1).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('state_change'),
    entity: z.string().min(1),
    field: StateField,
    before: z.unknown(),
    after: z.unknown(),
    cause: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('combatant_added'), combatant: Combatant }),
  z.object({
    ...base,
    type: z.literal('lore_lookup'),
    query: z.string().min(1),
    hits: z.array(z.object({ chunkId: z.string(), source: z.string(), score: z.number() })),
    used: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal('lore_invention'),
    fact: z.string().min(1),
    reason: z.string().min(1),
    query: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('npc_introduced'),
    npcId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    invented: z.boolean(),
    loreEntityId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('scene_change'),
    location: z.string().min(1),
    artPrompt: z.string().min(1),
    loreEntityId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('hand_off'),
    target: HandOffTarget,
    responders: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal('combat_start'), order: z.array(InitiativeEntry).min(1) }),
  z.object({
    ...base,
    type: z.literal('combat_turn'),
    round: z.number().int().min(1),
    turnIndex: z.number().int().min(0),
    combatantId: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal('combat_end') }),
  z.object({ ...base, type: z.literal('turn_end'), actor: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('validator_flag'),
    seat: z.string().min(1),
    rule: z.string().min(1),
    retries: z.number().int().min(0),
    resolution: z.enum(['accepted_with_flag', 'forced_pass', 'forced_hand_off']),
  }),
  z.object({ ...base, type: z.literal('ooc_note'), text: z.string().min(1) }),
]);
export type SimEvent = z.output<typeof SimEvent>;
export type SimEventType = SimEvent['type'];
