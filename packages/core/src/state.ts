import { Combatant, type InitiativeEntry } from '@cartyx-sim/rules';
import type { HandOffTarget, SimEvent } from './events';
import { countWords } from './text';

export interface NpcRecord {
  npcId: string;
  name: string;
  invented: boolean;
  loreEntityId?: string;
}

export interface CombatState {
  order: InitiativeEntry[];
  round: number;
  turnIndex: number;
  /** Whether the PC whose turn it is has already declared an action. */
  declared: boolean;
}

export interface GameState {
  session: number | null;
  /** Set from `session_start`; authoritative for every clock decision once a session has begun. */
  targetMinutes: number | null;
  /** Set from `session_start`; a resume with a different configured lore commit is rejected. */
  loreCommit: string | null;
  lastSeq: number;
  ended: boolean;
  partyIds: string[];
  combatants: Record<string, Combatant>;
  npcs: Record<string, NpcRecord>;
  scene: { location: string; loreEntityId?: string } | null;
  combat: CombatState | null;
  /** PCs the DM handed off to who have not taken their turn yet (exploration only). */
  pendingResponders: string[];
  spokenWords: number;
  wordsBySpeaker: Record<string, number>;
  /** Consecutive completed turns with no spoken words. */
  silentTurns: number;
  /** Spoken words so far in the turn being recorded. */
  turnWords: number;
}

export const OPEN_FLOOR_RESPONDERS = 2;

/**
 * Looks up an own property only, so ids like "constructor" or "__proto__" — which resolve on the
 * prototype chain with plain bracket access — correctly miss instead of returning a built-in.
 */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function initialState(): GameState {
  return {
    session: null,
    targetMinutes: null,
    loreCommit: null,
    lastSeq: -1,
    ended: false,
    partyIds: [],
    combatants: {},
    npcs: {},
    scene: null,
    combat: null,
    pendingResponders: [],
    spokenWords: 0,
    wordsBySpeaker: {},
    silentTurns: 0,
    turnWords: 0,
  };
}

/** Pure reducer: returns a new state with the event applied. */
export function applyEvent(state: GameState, event: SimEvent): GameState {
  if (event.seq <= state.lastSeq) {
    throw new Error(`Event seq ${event.seq} is not after last seq ${state.lastSeq}`);
  }
  const next = structuredClone(state);
  next.lastSeq = event.seq;

  switch (event.type) {
    case 'session_start':
      next.session = event.session;
      next.targetMinutes = event.targetMinutes;
      next.loreCommit = event.loreCommit;
      next.ended = false;
      next.partyIds = event.party.map((pc) => pc.id);
      for (const pc of event.party) next.combatants[pc.id] = pc;
      next.combat = null;
      next.pendingResponders = [];
      break;
    case 'session_end':
      next.ended = true;
      break;
    case 'narration':
    case 'dialogue': {
      const words = countWords(event.text);
      next.spokenWords += words;
      next.turnWords += words;
      next.wordsBySpeaker[event.speaker] = (next.wordsBySpeaker[event.speaker] ?? 0) + words;
      break;
    }
    case 'state_change': {
      const combatant = ownEntry(next.combatants, event.entity);
      if (!combatant) throw new Error(`state_change for unknown combatant "${event.entity}"`);
      next.combatants[event.entity] = Combatant.parse({ ...combatant, [event.field]: event.after });
      break;
    }
    case 'combatant_added':
      next.combatants[event.combatant.id] = event.combatant;
      break;
    case 'npc_introduced':
      next.npcs[event.npcId] = {
        npcId: event.npcId,
        name: event.name,
        invented: event.invented,
        loreEntityId: event.loreEntityId,
      };
      break;
    case 'scene_change':
      next.scene = { location: event.location, loreEntityId: event.loreEntityId };
      break;
    case 'hand_off':
      if (!next.combat) next.pendingResponders = [...event.responders];
      break;
    case 'combat_start':
      next.combat = { order: event.order, round: 1, turnIndex: 0, declared: false };
      next.pendingResponders = [];
      break;
    case 'combat_turn':
      if (!next.combat) throw new Error('combat_turn without an active combat');
      next.combat.round = event.round;
      next.combat.turnIndex = event.turnIndex;
      next.combat.declared = false;
      break;
    case 'combat_end':
      next.combat = null;
      next.pendingResponders = [];
      break;
    case 'turn_end':
      next.silentTurns = next.turnWords > 0 ? 0 : next.silentTurns + 1;
      next.turnWords = 0;
      if (next.partyIds.includes(event.actor)) {
        if (next.combat) next.combat.declared = true;
        else next.pendingResponders = next.pendingResponders.filter((id) => id !== event.actor);
      }
      break;
    default:
      break;
  }
  return next;
}

export function foldEvents(events: readonly SimEvent[]): GameState {
  return events.reduce(applyEvent, initialState());
}

export function isUp(combatant: Combatant | undefined): combatant is Combatant {
  return combatant !== undefined && !combatant.dead && combatant.hp > 0;
}

export type NextActor =
  | { kind: 'ended' }
  | { kind: 'dm'; reason: 'beat' | 'resolve' | 'monster'; combatantId?: string }
  | { kind: 'pc'; pcId: string; reason: 'response' | 'combat_turn' };

export function nextActor(state: GameState): NextActor {
  if (state.ended) return { kind: 'ended' };
  if (state.combat) {
    const entry = state.combat.order[state.combat.turnIndex];
    const combatant = entry ? state.combatants[entry.combatantId] : undefined;
    if (combatant?.kind === 'pc') {
      return state.combat.declared
        ? { kind: 'dm', reason: 'resolve', combatantId: combatant.id }
        : { kind: 'pc', pcId: combatant.id, reason: 'combat_turn' };
    }
    return { kind: 'dm', reason: 'monster', combatantId: entry?.combatantId };
  }
  const responder = state.pendingResponders[0];
  return responder
    ? { kind: 'pc', pcId: responder, reason: 'response' }
    : { kind: 'dm', reason: 'beat' };
}

/**
 * The next combatant in initiative order who can act, or null if nobody can. With `inclusive`,
 * the search starts at the current turn index instead of the one after it (no round increment
 * when it resolves there) — for checking whether the combatant whose turn it already is can act.
 */
export function advanceCombat(
  state: GameState,
  options: { inclusive?: boolean } = {}
): { round: number; turnIndex: number; combatantId: string } | null {
  const combat = state.combat;
  if (!combat) return null;
  const count = combat.order.length;
  const start = options.inclusive ? 0 : 1;
  for (let offset = start; offset <= count; offset++) {
    const position = combat.turnIndex + offset;
    const entry = combat.order[position % count]!;
    if (isUp(state.combatants[entry.combatantId])) {
      return {
        round: combat.round + Math.floor(position / count),
        turnIndex: position % count,
        combatantId: entry.combatantId,
      };
    }
  }
  return null;
}

/** Who responds to a hand-off. Quietest players first, so no seat disappears. Empty in combat. */
export function selectResponders(target: HandOffTarget, state: GameState): string[] {
  if (state.combat) return [];
  const active = state.partyIds.filter((id) => isUp(state.combatants[id]));
  const quietestFirst = [...active].sort(
    (a, b) => (state.wordsBySpeaker[a] ?? 0) - (state.wordsBySpeaker[b] ?? 0)
  );
  switch (target.kind) {
    case 'pcs':
      return target.ids.filter((id) => active.includes(id));
    case 'party':
      return quietestFirst;
    case 'open':
      return quietestFirst.slice(0, OPEN_FLOOR_RESPONDERS);
  }
}
