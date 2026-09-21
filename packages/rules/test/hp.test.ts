import { describe, expect, it } from 'vitest';
import { RulesError } from '../src/errors';
import {
  addCondition,
  applyDamage,
  applyHealing,
  failDeathSaves,
  removeCondition,
  rollDeathSave,
} from '../src/hp';
import type { Combatant } from '../src/schemas';
import { makeCombatant } from '../src/testing';

/** A player character at 0 HP and unconscious, with the given death saves so far. */
function dying(successes = 0, failures = 0): Combatant {
  return makeCombatant({
    id: 'pc',
    hp: 0,
    maxHp: 10,
    conditions: ['unconscious'],
    deathSaves: { successes, failures },
  });
}

describe('applyDamage', () => {
  it('spends temp HP before HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 10, maxHp: 10, tempHp: 3 });
    const hurt = applyDamage(pc, 5);
    expect(hurt.tempHp).toBe(0);
    expect(hurt.hp).toBe(8);
  });

  it('kills a monster at 0 HP', () => {
    const goblin = makeCombatant({ id: 'goblin', kind: 'monster', hp: 5, maxHp: 7 });
    const result = applyDamage(goblin, 9);
    expect(result.hp).toBe(0);
    expect(result.dead).toBe(true);
  });

  it('knocks a PC unconscious at 0 HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 4, maxHp: 10 });
    const result = applyDamage(pc, 6);
    expect(result.hp).toBe(0);
    expect(result.dead).toBe(false);
    expect(result.conditions).toContain('unconscious');
  });

  it('kills a PC outright on massive damage', () => {
    const pc = makeCombatant({ id: 'pc', hp: 4, maxHp: 10 });
    expect(applyDamage(pc, 14).dead).toBe(true);
  });

  it('adds a death save failure instead of HP loss for a PC already at 0 HP', () => {
    const hurt = applyDamage(dying(1, 0), 3);
    expect(hurt.hp).toBe(0);
    expect(hurt.deathSaves).toEqual({ successes: 1, failures: 1 });
    expect(hurt.dead).toBe(false);
  });

  it('costs a dying PC nothing when the damage is 0', () => {
    const untouched = applyDamage(dying(), 0);
    expect(untouched.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(untouched.dead).toBe(false);
  });

  it('costs a dying PC nothing when temp HP soaks the whole hit', () => {
    const shielded = makeCombatant({
      id: 'pc',
      hp: 0,
      maxHp: 10,
      tempHp: 5,
      conditions: ['unconscious'],
    });
    const struck = applyDamage(shielded, 3);
    expect(struck.tempHp).toBe(2);
    expect(struck.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(struck.dead).toBe(false);
  });

  it('still adds a failure when a single point gets through to a dying PC', () => {
    expect(applyDamage(dying(), 1).deathSaves).toEqual({ successes: 0, failures: 1 });
    expect(applyDamage(dying(), 1, { critical: true }).deathSaves).toEqual({
      successes: 0,
      failures: 2,
    });
  });

  it('adds two failures for a critical hit on a PC at 0 HP', () => {
    expect(applyDamage(dying(), 3, { critical: true }).deathSaves).toEqual({
      successes: 0,
      failures: 2,
    });
  });

  it('kills a PC whose third failure comes from damage at 0 HP', () => {
    const killed = applyDamage(dying(0, 2), 3);
    expect(killed.dead).toBe(true);
    expect(killed.deathSaves.failures).toBe(3);
  });

  it('makes a stable PC unstable again when struck', () => {
    const stable = makeCombatant({ id: 'pc', hp: 0, maxHp: 10, stable: true });
    const struck = applyDamage(stable, 2);
    expect(struck.stable).toBe(false);
    expect(struck.deathSaves).toEqual({ successes: 0, failures: 1 });
    expect(struck.dead).toBe(false);
  });

  it('still kills a PC at 0 HP outright on massive damage', () => {
    expect(applyDamage(dying(), 10).dead).toBe(true);
  });

  it('rejects negative or fractional damage and damage to the dead', () => {
    const pc = makeCombatant({ id: 'pc' });
    expect(() => applyDamage(pc, -1)).toThrow(RulesError);
    expect(() => applyDamage(pc, 1.5)).toThrow(RulesError);
    expect(() => applyDamage({ ...pc, dead: true }, 1)).toThrow('already dead');
  });

  it('does not mutate the input', () => {
    const pc = makeCombatant({ id: 'pc', hp: 10 });
    applyDamage(pc, 3);
    expect(pc.hp).toBe(10);
  });
});

describe('applyHealing', () => {
  it('caps at max HP', () => {
    const pc = makeCombatant({ id: 'pc', hp: 8, maxHp: 10 });
    expect(applyHealing(pc, 5).hp).toBe(10);
  });

  it('wakes an unconscious PC', () => {
    const down = makeCombatant({ id: 'pc', hp: 0, maxHp: 10, conditions: ['unconscious'] });
    const healed = applyHealing(down, 3);
    expect(healed.hp).toBe(3);
    expect(healed.conditions).not.toContain('unconscious');
  });

  it('cannot heal the dead', () => {
    const corpse = makeCombatant({ id: 'pc', hp: 0, dead: true });
    expect(() => applyHealing(corpse, 5)).toThrow('dead and cannot be healed');
  });

  it('clears death saves and stability when it brings a PC above 0 HP', () => {
    const healed = applyHealing({ ...dying(2, 1), stable: true }, 4);
    expect(healed.hp).toBe(4);
    expect(healed.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(healed.stable).toBe(false);
    expect(healed.conditions).not.toContain('unconscious');
  });
});

describe('rollDeathSave', () => {
  it('wakes the PC at 1 HP on a natural 20', () => {
    const { combatant, outcome } = rollDeathSave(dying(0, 2), 20);
    expect(outcome).toBe('revived');
    expect(combatant.hp).toBe(1);
    expect(combatant.conditions).not.toContain('unconscious');
    expect(combatant.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(combatant.stable).toBe(false);
  });

  it('counts a natural 1 as two failures', () => {
    const { combatant, outcome } = rollDeathSave(dying(1, 0), 1);
    expect(outcome).toBe('failure');
    expect(combatant.deathSaves).toEqual({ successes: 1, failures: 2 });
    expect(combatant.dead).toBe(false);
  });

  it('kills on a natural 1 that brings the failures to three or more', () => {
    const { combatant, outcome } = rollDeathSave(dying(0, 2), 1);
    expect(outcome).toBe('dead');
    expect(combatant.dead).toBe(true);
    expect(combatant.deathSaves.failures).toBe(3);
  });

  it('counts 10 or more as a success', () => {
    const { combatant, outcome } = rollDeathSave(dying(1, 1), 10);
    expect(outcome).toBe('success');
    expect(combatant.deathSaves).toEqual({ successes: 2, failures: 1 });
  });

  it('stabilizes on the third success, still unconscious at 0 HP', () => {
    const { combatant, outcome } = rollDeathSave(dying(2, 1), 15);
    expect(outcome).toBe('stable');
    expect(combatant.stable).toBe(true);
    expect(combatant.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(combatant.hp).toBe(0);
    expect(combatant.conditions).toContain('unconscious');
  });

  it('counts 9 or less as a failure', () => {
    const { combatant, outcome } = rollDeathSave(dying(1, 0), 9);
    expect(outcome).toBe('failure');
    expect(combatant.deathSaves).toEqual({ successes: 1, failures: 1 });
    expect(combatant.dead).toBe(false);
  });

  it('kills on the third failure, keeping the saves for the record', () => {
    const { combatant, outcome } = rollDeathSave(dying(1, 2), 3);
    expect(outcome).toBe('dead');
    expect(combatant.dead).toBe(true);
    expect(combatant.deathSaves).toEqual({ successes: 1, failures: 3 });
  });

  it('does not mutate the input', () => {
    const pc = dying(1, 1);
    rollDeathSave(pc, 12);
    expect(pc.deathSaves).toEqual({ successes: 1, failures: 1 });
  });

  it('rejects anyone who is not a dying player character, and an impossible roll', () => {
    expect(() => rollDeathSave(makeCombatant({ id: 'pc', hp: 4 }), 12)).toThrow(RulesError);
    expect(() => rollDeathSave({ ...dying(), dead: true }, 12)).toThrow('already dead');
    expect(() => rollDeathSave({ ...dying(), stable: true }, 12)).toThrow('is stable');
    expect(() =>
      rollDeathSave(makeCombatant({ id: 'goblin', kind: 'monster', hp: 0 }), 12)
    ).toThrow(RulesError);
    expect(() => rollDeathSave(dying(), 21)).toThrow(RulesError);
    expect(() => rollDeathSave(dying(), 0)).toThrow(RulesError);
  });
});

describe('failDeathSaves', () => {
  it('adds the given number of failures', () => {
    const { combatant, dead } = failDeathSaves(dying(1, 0), 2);
    expect(combatant.deathSaves).toEqual({ successes: 1, failures: 2 });
    expect(dead).toBe(false);
  });

  it('kills at three failures and caps the count there', () => {
    const { combatant, dead } = failDeathSaves(dying(0, 2), 2);
    expect(dead).toBe(true);
    expect(combatant.dead).toBe(true);
    expect(combatant.deathSaves.failures).toBe(3);
  });

  it('makes a stable PC unstable with that many failures', () => {
    const { combatant } = failDeathSaves(
      makeCombatant({ id: 'pc', hp: 0, maxHp: 10, stable: true }),
      2
    );
    expect(combatant.stable).toBe(false);
    expect(combatant.deathSaves).toEqual({ successes: 0, failures: 2 });
  });

  it('rejects anyone who is not a player character at 0 HP, and a bad count', () => {
    expect(() => failDeathSaves(makeCombatant({ id: 'pc', hp: 4 }), 1)).toThrow(RulesError);
    expect(() => failDeathSaves({ ...dying(), dead: true }, 1)).toThrow('already dead');
    expect(() =>
      failDeathSaves(makeCombatant({ id: 'goblin', kind: 'monster', hp: 0 }), 1)
    ).toThrow(RulesError);
    expect(() => failDeathSaves(dying(), 0)).toThrow(RulesError);
  });
});

describe('conditions', () => {
  it('adds a condition once', () => {
    const pc = makeCombatant({ id: 'pc' });
    const poisoned = addCondition(addCondition(pc, 'poisoned'), 'poisoned');
    expect(poisoned.conditions).toEqual(['poisoned']);
  });

  it('removes a condition', () => {
    const pc = makeCombatant({ id: 'pc', conditions: ['prone', 'poisoned'] });
    expect(removeCondition(pc, 'prone').conditions).toEqual(['poisoned']);
  });
});
