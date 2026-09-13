import { describe, expect, it } from 'vitest';
import { resolveAttack, rollAttack } from '../src/combat';
import { RulesError } from '../src/errors';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const fighter = makeCombatant({
  id: 'fighter',
  attacks: [{ name: 'Longsword', bonus: 5, damage: '1d8+3', damageType: 'slashing' }],
});
const goblin = makeCombatant({ id: 'goblin', kind: 'monster', ac: 15, hp: 7, maxHp: 7 });

describe('resolveAttack', () => {
  it('hits when the total meets AC and applies damage', () => {
    const result = resolveAttack(fighter, goblin, 'longsword', scriptedRng([10, 2]));
    expect(result.total).toBe(15);
    expect(result.hit).toBe(true);
    expect(result.critical).toBe(false);
    expect(result.damage?.total).toBe(5);
    expect(result.target.hp).toBe(2);
  });

  it('misses below AC and leaves the target unchanged', () => {
    const result = resolveAttack(fighter, goblin, 'Longsword', scriptedRng([9]));
    expect(result.hit).toBe(false);
    expect(result.damage).toBeNull();
    expect(result.target).toBe(goblin);
  });

  it('always misses on a natural 1', () => {
    const sure = makeCombatant({
      id: 'sure',
      attacks: [{ name: 'Blade', bonus: 30, damage: '1d4', damageType: 'slashing' }],
    });
    expect(resolveAttack(sure, goblin, 'Blade', scriptedRng([1])).hit).toBe(false);
  });

  it('always hits on a natural 20 and doubles the damage dice', () => {
    const armored = makeCombatant({ id: 'armored', kind: 'monster', ac: 30, hp: 40, maxHp: 40 });
    const result = resolveAttack(fighter, armored, 'Longsword', scriptedRng([20, 4, 6]));
    expect(result.hit).toBe(true);
    expect(result.critical).toBe(true);
    expect(result.damage?.total).toBe(13);
    expect(result.target.hp).toBe(27);
  });

  it('lists known attacks when the name is wrong', () => {
    expect(() => resolveAttack(fighter, goblin, 'Axe', scriptedRng([10]))).toThrow(
      'Known attacks: Longsword'
    );
  });

  it('refuses to attack the dead', () => {
    const corpse = { ...goblin, hp: 0, dead: true };
    expect(() => rollAttack(fighter.attacks[0]!, corpse, scriptedRng([10]))).toThrow(RulesError);
  });
});
