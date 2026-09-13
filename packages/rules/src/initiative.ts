import { abilityModifier } from './checks';
import type { Rng } from './rng';
import type { Combatant, InitiativeEntry } from './schemas';

/** Rolls d20 + Dex for each combatant in input order; sorts by total, then Dex modifier, then input order. */
export function rollInitiative(combatants: readonly Combatant[], rng: Rng): InitiativeEntry[] {
  const rolled = combatants.map((combatant, index) => {
    const roll = rng.die(20);
    const dexMod = abilityModifier(combatant.abilities.dex);
    return { index, entry: { combatantId: combatant.id, roll, dexMod, total: roll + dexMod } };
  });
  rolled.sort(
    (a, b) => b.entry.total - a.entry.total || b.entry.dexMod - a.entry.dexMod || a.index - b.index
  );
  return rolled.map((r) => r.entry);
}
