import { describe, expect, it } from 'vitest';
import { formatModifier, parseDice, rollD20, rollDice } from '../src/dice';
import { RulesError } from '../src/errors';
import { scriptedRng } from '../src/rng';

describe('parseDice', () => {
  it('parses dice with a modifier', () => {
    expect(parseDice('2d6+3')).toEqual({ terms: [{ count: 2, sides: 6 }], modifier: 3 });
  });

  it('treats a bare "d20" as one die and ignores spaces and case', () => {
    expect(parseDice(' D20 ')).toEqual({ terms: [{ count: 1, sides: 20 }], modifier: 0 });
  });

  it('parses multiple terms and negative flat modifiers', () => {
    expect(parseDice('1d8+1d6-2')).toEqual({
      terms: [
        { count: 1, sides: 8 },
        { count: 1, sides: 6 },
      ],
      modifier: -2,
    });
  });

  it('parses a flat number', () => {
    expect(parseDice('5')).toEqual({ terms: [], modifier: 5 });
  });

  it.each(['', '2x6', 'd1', '-1d4', '1d4-1d6', '1d', '0d6'])('rejects "%s"', (expr) => {
    expect(() => parseDice(expr)).toThrow(RulesError);
  });

  it('rejects a die size over 1000', () => {
    expect(() => parseDice('1d1001')).toThrow(RulesError);
  });

  it('rejects a huge die size that would hang the engine', () => {
    expect(() => parseDice('1d5000000000')).toThrow(RulesError);
  });

  it('accepts a die size of exactly 1000', () => {
    expect(parseDice('1d1000')).toEqual({ terms: [{ count: 1, sides: 1000 }], modifier: 0 });
  });
});

describe('rollDice', () => {
  it('sums the dice and the modifier', () => {
    expect(rollDice('2d6+3', scriptedRng([3, 5]))).toEqual({
      expr: '2d6+3',
      rolls: [3, 5],
      modifier: 3,
      total: 11,
    });
  });

  it('doubles the dice but not the modifier on a critical', () => {
    const result = rollDice('1d8+2', scriptedRng([4, 6]), { critical: true });
    expect(result.rolls).toEqual([4, 6]);
    expect(result.total).toBe(12);
  });

  it('G3.4: records the doubled dice in expr on a critical', () => {
    const result = rollDice('1d4+3', scriptedRng([1, 2]), { critical: true });
    expect(result.expr).toBe('2d4+3');
  });

  it('leaves a non-critical expr unchanged', () => {
    expect(rollDice('1d4+3', scriptedRng([1])).expr).toBe('1d4+3');
  });

  it('never returns a negative total', () => {
    expect(rollDice('1d4-5', scriptedRng([1])).total).toBe(0);
  });
});

describe('rollD20', () => {
  it('rolls once in normal mode', () => {
    expect(rollD20(scriptedRng([11]))).toEqual({ rolls: [11], natural: 11, mode: 'normal' });
  });

  it('keeps the higher roll with advantage', () => {
    expect(rollD20(scriptedRng([5, 17]), 'advantage').natural).toBe(17);
  });

  it('keeps the lower roll with disadvantage', () => {
    expect(rollD20(scriptedRng([5, 17]), 'disadvantage').natural).toBe(5);
  });
});

describe('formatModifier', () => {
  it('always shows a sign', () => {
    expect(formatModifier(3)).toBe('+3');
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(-1)).toBe('-1');
  });
});
