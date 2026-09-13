import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  checkLabel,
  checkModifier,
  proficiencyBonusForLevel,
  resolveCheck,
} from '../src/checks';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const kira = makeCombatant({
  id: 'kira',
  name: 'Kira Vale',
  abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  proficiencyBonus: 2,
  saveProficiencies: ['int'],
  skillProficiencies: ['investigation'],
  skillExpertise: ['arcana'],
});

describe('abilityModifier', () => {
  it.each([
    [1, -5],
    [8, -1],
    [10, 0],
    [11, 0],
    [16, 3],
    [20, 5],
  ])('score %i gives %i', (score, modifier) => {
    expect(abilityModifier(score)).toBe(modifier);
  });
});

describe('proficiencyBonusForLevel', () => {
  it.each([
    [1, 2],
    [4, 2],
    [5, 3],
    [9, 4],
    [17, 6],
  ])('level %i gives +%i', (level, bonus) => {
    expect(proficiencyBonusForLevel(level)).toBe(bonus);
  });
});

describe('checkModifier', () => {
  it('uses the raw ability modifier for ability checks', () => {
    expect(checkModifier(kira, { type: 'ability', ability: 'str' })).toBe(-1);
  });

  it('adds proficiency to proficient skills', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'investigation' })).toBe(5);
  });

  it('adds double proficiency for expertise', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'arcana' })).toBe(7);
  });

  it('adds nothing for untrained skills', () => {
    expect(checkModifier(kira, { type: 'skill', skill: 'stealth' })).toBe(2);
  });

  it('adds proficiency only to proficient saves', () => {
    expect(checkModifier(kira, { type: 'save', ability: 'int' })).toBe(5);
    expect(checkModifier(kira, { type: 'save', ability: 'wis' })).toBe(1);
  });
});

describe('checkLabel', () => {
  it('names checks and saves for the transcript', () => {
    expect(checkLabel({ type: 'skill', skill: 'sleightOfHand' })).toBe('Sleight Of Hand check');
    expect(checkLabel({ type: 'save', ability: 'dex' })).toBe('Dexterity save');
    expect(checkLabel({ type: 'ability', ability: 'str' })).toBe('Strength check');
  });
});

describe('resolveCheck', () => {
  it('succeeds when the total meets the DC', () => {
    const result = resolveCheck(
      kira,
      { type: 'skill', skill: 'investigation' },
      13,
      scriptedRng([8])
    );
    expect(result.total).toBe(13);
    expect(result.success).toBe(true);
  });

  it('fails below the DC, even on a natural 20 with a low total', () => {
    const weak = makeCombatant({
      id: 'weak',
      abilities: { str: 1, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    const result = resolveCheck(weak, { type: 'ability', ability: 'str' }, 25, scriptedRng([20]));
    expect(result.total).toBe(15);
    expect(result.success).toBe(false);
  });

  it('applies advantage', () => {
    const result = resolveCheck(
      kira,
      { type: 'ability', ability: 'int' },
      15,
      scriptedRng([3, 12]),
      'advantage'
    );
    expect(result.d20.rolls).toEqual([3, 12]);
    expect(result.total).toBe(15);
  });
});
