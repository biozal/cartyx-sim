import { rollD20, rollDice, type D20Roll, type DiceResult, type RollMode } from './dice';
import { RulesError } from './errors';
import { applyDamage } from './hp';
import type { Rng } from './rng';
import type { Attack, Combatant } from './schemas';

export interface AttackResult {
  attack: Attack;
  d20: D20Roll;
  total: number;
  targetAc: number;
  hit: boolean;
  critical: boolean;
  damage: DiceResult | null;
  /** The target after damage was applied (unchanged on a miss). */
  target: Combatant;
}

export function findAttack(combatant: Combatant, name: string): Attack {
  const attack = combatant.attacks.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!attack) {
    const known = combatant.attacks.map((a) => a.name).join(', ') || 'none';
    throw new RulesError(
      `${combatant.name} has no attack named "${name}". Known attacks: ${known}`
    );
  }
  return attack;
}

/** Natural 20 always hits and doubles damage dice; natural 1 always misses. */
export function rollAttack(
  attack: Attack,
  target: Combatant,
  rng: Rng,
  mode: RollMode = 'normal'
): AttackResult {
  if (target.dead) throw new RulesError(`${target.name} is already dead`);
  const d20 = rollD20(rng, mode);
  const total = d20.natural + attack.bonus;
  const critical = d20.natural === 20;
  const hit = critical || (d20.natural !== 1 && total >= target.ac);
  const base = { attack, d20, total, targetAc: target.ac, hit, critical };
  if (!hit) return { ...base, damage: null, target };
  const damage = rollDice(attack.damage, rng, { critical });
  return { ...base, damage, target: applyDamage(target, damage.total) };
}

export function resolveAttack(
  attacker: Combatant,
  target: Combatant,
  attackName: string,
  rng: Rng,
  mode: RollMode = 'normal'
): AttackResult {
  return rollAttack(findAttack(attacker, attackName), target, rng, mode);
}
