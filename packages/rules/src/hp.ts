import { RulesError } from './errors';
import type { Combatant, Condition, DeathSaves } from './schemas';

/** The DC of a death saving throw, and the count of either result that settles it. */
export const DEATH_SAVE_DC = 10;
const DEATH_SAVE_LIMIT = 3;

const NO_DEATH_SAVES: DeathSaves = { successes: 0, failures: 0 };

function assertAmount(kind: string, amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RulesError(`${kind} must be a non-negative integer, got ${amount}`);
  }
}

/** A player character at 0 HP who is not dead: the only combatant death saves apply to. */
function assertDown(combatant: Combatant): void {
  if (combatant.kind !== 'pc') {
    throw new RulesError(`${combatant.name} is not a player character and has no death saves`);
  }
  if (combatant.dead) throw new RulesError(`${combatant.name} is already dead`);
  if (combatant.hp > 0) throw new RulesError(`${combatant.name} is not at 0 HP`);
}

export function addCondition(combatant: Combatant, condition: Condition): Combatant {
  if (combatant.conditions.includes(condition)) return combatant;
  return { ...combatant, conditions: [...combatant.conditions, condition] };
}

export function removeCondition(combatant: Combatant, condition: Condition): Combatant {
  return { ...combatant, conditions: combatant.conditions.filter((c) => c !== condition) };
}

/** What a death saving throw did to the character who rolled it. */
export type DeathSaveOutcome = 'success' | 'failure' | 'stable' | 'dead' | 'revived';

/**
 * Applies one death saving throw to a dying PC, given the d20 result the caller rolled (so dice
 * stay in one place). A natural 20 wakes them at 1 HP, a natural 1 counts as two failures, three
 * successes stabilize them, and three failures kill them.
 */
export function rollDeathSave(
  combatant: Combatant,
  roll: number
): { combatant: Combatant; outcome: DeathSaveOutcome } {
  assertDown(combatant);
  if (combatant.stable) throw new RulesError(`${combatant.name} is stable, not dying`);
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) {
    throw new RulesError(`A death saving throw must be a d20 result, got ${roll}`);
  }
  if (roll === 20) {
    const awake = removeCondition(combatant, 'unconscious');
    return { combatant: { ...awake, hp: 1, deathSaves: NO_DEATH_SAVES }, outcome: 'revived' };
  }
  if (roll < DEATH_SAVE_DC) {
    const failed = failDeathSaves(combatant, roll === 1 ? 2 : 1);
    return { combatant: failed.combatant, outcome: failed.dead ? 'dead' : 'failure' };
  }
  const successes = combatant.deathSaves.successes + 1;
  if (successes < DEATH_SAVE_LIMIT) {
    return {
      combatant: { ...combatant, deathSaves: { ...combatant.deathSaves, successes } },
      outcome: 'success',
    };
  }
  return {
    combatant: { ...combatant, deathSaves: NO_DEATH_SAVES, stable: true },
    outcome: 'stable',
  };
}

/**
 * Adds failed death saves to a PC at 0 HP: what damage at 0 HP costs (one for a hit, two for a
 * critical), and what makes a stable character dying again. The third failure kills them.
 */
export function failDeathSaves(
  combatant: Combatant,
  count: number
): { combatant: Combatant; dead: boolean } {
  assertDown(combatant);
  if (!Number.isInteger(count) || count < 1) {
    throw new RulesError(`Death save failures must be a positive integer, got ${count}`);
  }
  const failures = Math.min(DEATH_SAVE_LIMIT, combatant.deathSaves.failures + count);
  const dead = failures >= DEATH_SAVE_LIMIT;
  return {
    combatant: {
      ...combatant,
      deathSaves: { ...combatant.deathSaves, failures },
      stable: false,
      dead,
    },
    dead,
  };
}

/**
 * Temp HP absorbs damage first. At 0 HP, monsters and NPCs die; PCs fall unconscious unless the
 * damage left over after reaching 0 is at least their max HP (massive damage). A PC already at 0
 * HP loses no more HP: the hit costs death saving throw failures instead, two on a critical.
 */
export function applyDamage(
  combatant: Combatant,
  amount: number,
  options: { critical?: boolean } = {}
): Combatant {
  assertAmount('Damage', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is already dead`);
  const absorbed = Math.min(combatant.tempHp, amount);
  const remaining = amount - absorbed;
  const hp = Math.max(0, combatant.hp - remaining);
  const next: Combatant = { ...combatant, tempHp: combatant.tempHp - absorbed, hp };
  if (hp > 0) return next;
  const overflow = remaining - combatant.hp;
  if (combatant.kind !== 'pc' || overflow >= combatant.maxHp) return { ...next, dead: true };
  if (combatant.hp === 0) return failDeathSaves(next, options.critical ? 2 : 1).combatant;
  return addCondition(next, 'unconscious');
}

/** Healing a PC back above 0 HP wakes them and clears their death saves and stability. */
export function applyHealing(combatant: Combatant, amount: number): Combatant {
  assertAmount('Healing', amount);
  if (combatant.dead) throw new RulesError(`${combatant.name} is dead and cannot be healed`);
  const hp = Math.min(combatant.maxHp, combatant.hp + amount);
  const healed: Combatant = { ...combatant, hp };
  if (combatant.hp > 0 || hp === 0) return healed;
  const revived: Combatant = { ...healed, deathSaves: NO_DEATH_SAVES, stable: false };
  return removeCondition(revived, 'unconscious');
}
