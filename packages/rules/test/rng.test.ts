import { describe, expect, it } from 'vitest';
import { scriptedRng, secureRng, seededRng } from '../src/rng';

function rollMany(die: (sides: number) => number, sides: number, count: number): number[] {
  return Array.from({ length: count }, () => die(sides));
}

describe('seededRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect(rollMany((s) => a.die(s), 20, 50)).toEqual(rollMany((s) => b.die(s), 20, 50));
  });

  it('produces different sequences for different seeds', () => {
    const a = seededRng(1);
    const b = seededRng(2);
    expect(rollMany((s) => a.die(s), 20, 20)).not.toEqual(rollMany((s) => b.die(s), 20, 20));
  });

  it('stays within 1..sides and reaches both ends', () => {
    const rng = seededRng(7);
    const rolls = rollMany((s) => rng.die(s), 6, 2000);
    expect(Math.min(...rolls)).toBe(1);
    expect(Math.max(...rolls)).toBe(6);
  });
});

describe('secureRng', () => {
  it('stays within 1..sides', () => {
    const rng = secureRng();
    const rolls = rollMany((s) => rng.die(s), 20, 2000);
    expect(Math.min(...rolls)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...rolls)).toBeLessThanOrEqual(20);
  });

  it('rejects a sides value that would hang the loop instead of looping forever', () => {
    const rng = secureRng();
    expect(() => rng.die(5_000_000_000)).toThrow();
  }, 2000);

  it('rejects non-integer or out-of-range sides', () => {
    const rng = secureRng();
    expect(() => rng.die(1)).toThrow();
    expect(() => rng.die(2.5)).toThrow();
    expect(() => rng.die(2 ** 32 + 1)).toThrow();
  });
});

describe('scriptedRng', () => {
  it('returns the scripted values in order', () => {
    const rng = scriptedRng([3, 18]);
    expect(rng.die(6)).toBe(3);
    expect(rng.die(20)).toBe(18);
  });

  it('throws when exhausted', () => {
    const rng = scriptedRng([1]);
    rng.die(4);
    expect(() => rng.die(4)).toThrow('scriptedRng exhausted after 1 rolls');
  });

  it('rejects values that do not fit the die', () => {
    expect(() => scriptedRng([7]).die(6)).toThrow('out of range for d6');
  });
});
