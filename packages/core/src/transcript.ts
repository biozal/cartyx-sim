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

/** Spec §5.5: monster AC and HP never enter a player prompt or transcript. */
function describeHpChange(name: string, before: unknown, after: unknown): string {
  const from = typeof before === 'number' ? before : Number(before);
  const to = typeof after === 'number' ? after : Number(after);
  if (to === 0) return `[state] ${name} is down`;
  if (to < from) return `[state] ${name} is wounded`;
  return `[state] ${name} recovers`;
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
