import { RulesError } from './errors';
import type { Combatant } from './schemas';

export function slotsRemaining(combatant: Combatant, level: number): number {
  const slot = combatant.spellSlots.find((s) => s.level === level);
  return slot ? slot.max - slot.used : 0;
}

/** e.g. "L1 2/4, L2 0/2" (remaining/max). */
export function describeSlots(combatant: Combatant): string {
  return combatant.spellSlots.map((s) => `L${s.level} ${s.max - s.used}/${s.max}`).join(', ');
}

export function spendSlot(combatant: Combatant, level: number): Combatant {
  if (slotsRemaining(combatant, level) < 1) {
    const slots = describeSlots(combatant) || 'none';
    throw new RulesError(
      `${combatant.name} has no level ${level} spell slots left (slots: ${slots})`
    );
  }
  return {
    ...combatant,
    spellSlots: combatant.spellSlots.map((s) =>
      s.level === level ? { ...s, used: s.used + 1 } : s
    ),
  };
}

export function restoreSlots(combatant: Combatant): Combatant {
  return { ...combatant, spellSlots: combatant.spellSlots.map((s) => ({ ...s, used: 0 })) };
}
