import { Combatant, type CombatantInput } from './schemas';

/** Builds a valid combatant with plain defaults (all abilities 10, AC 10, 10 HP) for tests and fixtures. */
export function makeCombatant(
  overrides: Partial<CombatantInput> & Pick<CombatantInput, 'id'>
): Combatant {
  return Combatant.parse({
    name: overrides.id,
    kind: 'pc',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 2,
    ac: 10,
    maxHp: 10,
    hp: 10,
    ...overrides,
  });
}
