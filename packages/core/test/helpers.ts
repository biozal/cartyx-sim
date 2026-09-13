import type { Combatant } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import type { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import { initialState, type GameState } from '../src/state';

export const FIXED_NOW = new Date('2026-09-13T12:00:00.000Z');
export const now = () => FIXED_NOW;

export const kira = makeCombatant({
  id: 'kira',
  name: 'Kira Vale',
  abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  skillProficiencies: ['investigation'],
  ac: 15,
  maxHp: 10,
  hp: 10,
  spellSlots: [{ level: 1, max: 2, used: 0 }],
  attacks: [{ name: 'Light Hammer', bonus: 5, damage: '1d4+3', damageType: 'bludgeoning' }],
  inventory: [{ name: 'Healing Potion', quantity: 1 }],
});

export const tomas = makeCombatant({
  id: 'tomas',
  name: 'Tomas Reed',
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 12 },
  saveProficiencies: ['str', 'con'],
  ac: 16,
  maxHp: 12,
  hp: 12,
  attacks: [{ name: 'Longsword', bonus: 5, damage: '1d8+3', damageType: 'slashing' }],
});

/** A state and history just after session_start with the given party. */
export function startedState(party: Combatant[] = [kira, tomas]): {
  state: GameState;
  history: SimEvent[];
} {
  const recorder = new TurnRecorder(initialState(), 'setup', now);
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 60,
    party,
  });
  return { state: recorder.state, history: [...recorder.events] };
}
