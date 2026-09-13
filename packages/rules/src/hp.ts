import { RulesError } from './errors';
import type { Combatant, Condition } from './schemas';

function assertAmount(kind: string, amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RulesError(`${kind} must be a non-negative integer, got ${amount}`);
  }
}

export function addCondition(combatant: Combatant, condition: Condition): Combatant {
  if (combatant.conditions.includes(condition)) return combatant;
  return { ...combatant, conditions: [...combatant.conditions, condition] };
}

export function removeCondition(combatant: Combatant, condition: Condition): Combatant {
  return { ...combatant, conditions: combatant.conditions.filter((c) => c !== condition) };
}

/**
 * Temp HP absorbs damage first. At 0 HP, monsters and NPCs die; PCs fall unconscious unless the
 * damage left over after reaching 0 is at least their max HP (massive damage).
 */
export function applyDamage(combatant: Combatant, amount: number): Combatant {
  assertAmount('Damage', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is already dead`);
  const absorbed = Math.min(combatant.tempHp, amount);
  const remaining = amount - absorbed;
  const hp = Math.max(0, combatant.hp - remaining);
  const next: Combatant = { ...combatant, tempHp: combatant.tempHp - absorbed, hp };
  if (hp > 0) return next;
  const overflow = remaining - combatant.hp;
  if (combatant.kind !== 'pc' || overflow >= combatant.maxHp) return { ...next, dead: true };
  return addCondition(next, 'unconscious');
}

export function applyHealing(combatant: Combatant, amount: number): Combatant {
  assertAmount('Healing', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is dead and cannot be healed`);
  const hp = Math.min(combatant.maxHp, combatant.hp + amount);
  const healed: Combatant = { ...combatant, hp };
  return combatant.hp === 0 && hp > 0 ? removeCondition(healed, 'unconscious') : healed;
}
