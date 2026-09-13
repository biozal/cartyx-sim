import type { Combatant, Condition } from '@cartyx-sim/rules';
import { ownEntry, type GameState } from './state';

/** How a non-PC combatant looks to the players: a coarse status, never numbers. */
export type VisibleStatus = 'unhurt' | 'wounded' | 'down' | 'dead';

export interface VisibleAlly {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  conditions: Condition[];
  dead: boolean;
}

export interface VisibleCombatant {
  id: string;
  name: string;
  kind: 'npc' | 'monster';
  status: VisibleStatus;
}

/**
 * Everything a player prompt may use. Built from `GameState` but containing no monster or NPC
 * stat blocks, so a `PromptBuilder` cannot leak them by construction (spec §5.5).
 */
export interface PlayerView {
  /** The player's own full character sheet. */
  pc: Combatant;
  /** The other party members' visible vitals. */
  allies: VisibleAlly[];
  /** Non-PC combatants in play, by coarse status only. */
  others: VisibleCombatant[];
  npcs: { npcId: string; name: string }[];
  scene: string | null;
  inCombat: boolean;
}

function visibleStatus(combatant: Combatant): VisibleStatus {
  if (combatant.dead) return 'dead';
  if (combatant.hp === 0) return 'down';
  return combatant.hp < combatant.maxHp ? 'wounded' : 'unhurt';
}

export function playerView(state: GameState, pcId: string): PlayerView {
  const pc = ownEntry(state.combatants, pcId);
  if (!pc) throw new Error(`No party member "${pcId}" in the game state`);
  const allies = state.partyIds
    .filter((id) => id !== pcId)
    .map((id) => ownEntry(state.combatants, id))
    .filter((ally) => ally !== undefined)
    .map(({ id, name, hp, maxHp, conditions, dead }) => ({
      id,
      name,
      hp,
      maxHp,
      conditions: [...conditions],
      dead,
    }));
  const others = Object.values(state.combatants)
    .filter((combatant) => combatant.kind !== 'pc')
    .map((combatant) => ({
      id: combatant.id,
      name: combatant.name,
      kind: combatant.kind as 'npc' | 'monster',
      status: visibleStatus(combatant),
    }));
  const npcs = Object.values(state.npcs).map(({ npcId, name }) => ({ npcId, name }));
  return {
    pc: structuredClone(pc),
    allies,
    others,
    npcs,
    scene: state.scene?.location ?? null,
    inCombat: state.combat !== null,
  };
}
