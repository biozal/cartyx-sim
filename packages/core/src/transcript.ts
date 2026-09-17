import type { SimEvent } from './events';
import { ownEntry, type GameState } from './state';

export type Audience = 'dm' | 'player';

function nameOf(id: string, state: GameState): string {
  return ownEntry(state.combatants, id)?.name ?? ownEntry(state.npcs, id)?.name ?? id;
}

/** True when the entity is a combatant whose stats are hidden from players (any non-PC). */
function isHiddenStats(id: string, state: GameState): boolean {
  return ownEntry(state.combatants, id)?.kind !== 'pc';
}

/** How an HP value moved, without exposing the numbers themselves. */
export type HpTrend = 'down' | 'wounded' | 'recovers' | 'unchanged' | 'unknown';

const NUMERIC_STRING = /^\s*-?\d+(\.\d+)?\s*$/;

/** Whether `value` is a finite number, or a string that reads as one (`Number` also accepts `true`,
 * `null`, `[]`, hex, and whitespace-only strings as numbers, which are not HP values). */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) return Number(value);
  return undefined;
}

/**
 * Compares two HP values coarsely: `unknown` when either is not a finite number, `down` when
 * `after` is at or below zero, `wounded` for a drop, `recovers` for a rise, else `unchanged`.
 */
export function hpTrend(before: unknown, after: unknown): HpTrend {
  const from = asNumber(before);
  const to = asNumber(after);
  if (from === undefined || to === undefined) return 'unknown';
  if (to <= 0) return 'down';
  if (to < from) return 'wounded';
  if (to > from) return 'recovers';
  return 'unchanged';
}

/** Spec §5.5: monster AC and HP never enter a player prompt or transcript. */
function describeHpChange(name: string, before: unknown, after: unknown): string {
  switch (hpTrend(before, after)) {
    case 'down':
      return `[state] ${name} is down`;
    case 'wounded':
      return `[state] ${name} is wounded`;
    case 'recovers':
      return `[state] ${name} recovers`;
    case 'unchanged':
      return `[state] ${name} is unchanged`;
    case 'unknown':
      return `[state] ${name} changes condition`;
  }
}

/**
 * A death save tally as "2 successes, 1 failure". Both seats see it: the table can see how a
 * dying friend is doing. Takes the raw `after` value, which an old log could hold anything in.
 */
function countDeathSaves(after: unknown): string {
  const tally = after as { successes?: unknown; failures?: unknown } | null;
  const successes = asNumber(tally?.successes) ?? 0;
  const failures = asNumber(tally?.failures) ?? 0;
  return `${successes} success${successes === 1 ? '' : 'es'}, ${failures} failure${failures === 1 ? '' : 's'}`;
}

/** One human-readable transcript line for an event, or null if the event is not shown. */
export function describeEvent(
  event: SimEvent,
  state: GameState,
  audience: Audience = 'dm'
): string | null {
  switch (event.type) {
    case 'narration':
      return `DM: ${event.text}`;
    case 'dialogue':
      return `${nameOf(event.speaker, state)}${event.overlaps === undefined ? '' : ' (interrupting)'}: "${event.text}"`;
    case 'action':
      return `${nameOf(event.actor, state)} attempts: ${event.intent}${event.target ? ` (target: ${nameOf(event.target, state)})` : ''}`;
    case 'pass':
      return `${nameOf(event.actor, state)} holds back.`;
    case 'roll': {
      const hideTarget = audience === 'player' && event.kind === 'attack';
      const against = event.target === undefined || hideTarget ? '' : ` vs ${event.target}`;
      const outcome = event.outcome ? ` — ${event.outcome}` : '';
      return `[roll] ${event.label}: ${event.total}${against}${outcome}`;
    }
    case 'state_change':
      if (event.field === 'hp') {
        const name = nameOf(event.entity, state);
        if (audience === 'player' && isHiddenStats(event.entity, state)) {
          return describeHpChange(name, event.before, event.after);
        }
        return `[state] ${name} HP ${String(event.before)} → ${String(event.after)}`;
      }
      if (event.field === 'conditions') {
        const after = Array.isArray(event.after) ? event.after.join(', ') : '';
        return `[state] ${nameOf(event.entity, state)} conditions: ${after || 'none'}`;
      }
      if (event.field === 'dead' && event.after === true) {
        return `[state] ${nameOf(event.entity, state)} dies`;
      }
      if (event.field === 'deathSaves') {
        return `[state] ${nameOf(event.entity, state)} death saves: ${countDeathSaves(event.after)}`;
      }
      // Becoming unstable always comes with a death save failure, which says it on its own line.
      if (event.field === 'stable' && event.after === true) {
        return `[state] ${nameOf(event.entity, state)} is stable`;
      }
      return null;
    case 'scene_change':
      return `[scene] ${event.location}`;
    case 'npc_introduced':
      return `[npc] ${event.name} (npcId: ${event.npcId}): ${event.description}`;
    case 'combat_start':
      return `[combat] Initiative: ${event.order.map((e) => `${nameOf(e.combatantId, state)} ${e.total}`).join(', ')}`;
    case 'combat_turn':
      return `[combat] Round ${event.round}: ${nameOf(event.combatantId, state)}'s turn`;
    case 'combat_end':
      return '[combat] Combat ends';
    case 'lore_lookup':
      return `[lore] "${event.query}": ${event.used.length} relevant result(s)`;
    case 'lore_invention':
      return `[invented] ${event.fact}`;
    default:
      return null;
  }
}

/** The last `limit` transcript lines. Players only ever see public events. */
export function renderTranscript(
  events: readonly SimEvent[],
  state: GameState,
  audience: Audience,
  limit: number
): string {
  return events
    .filter((event) => audience === 'dm' || event.visibility === 'public')
    .map((event) => describeEvent(event, state, audience))
    .filter((line): line is string => line !== null)
    .slice(-limit)
    .join('\n');
}
