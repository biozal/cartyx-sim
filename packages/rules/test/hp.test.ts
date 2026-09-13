import { describe, expect, it } from 'vitest';
import { RulesError } from '../src/errors';
import { addCondition, applyDamage, applyHealing, removeCondition } from '../src/hp';
import { makeCombatant } from '../src/testing';

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
