import { describe, expect, it } from 'vitest';
import { rollInitiative } from '../src/initiative';
import { scriptedRng } from '../src/rng';
import { makeCombatant } from '../src/testing';

const abilities = (dex: number) => ({ str: 10, dex, con: 10, int: 10, wis: 10, cha: 10 });

describe('rollInitiative', () => {
  it('orders by total, then Dex modifier, then input order', () => {
    const slow = makeCombatant({ id: 'slow', abilities: abilities(8) });
    const quick = makeCombatant({ id: 'quick', abilities: abilities(16) });
    const tieA = makeCombatant({ id: 'tie-a', abilities: abilities(12) });
    const tieB = makeCombatant({ id: 'tie-b', abilities: abilities(12) });
    const order = rollInitiative([slow, quick, tieA, tieB], scriptedRng([19, 10, 12, 12]));
    expect(order.map((e) => [e.combatantId, e.total])).toEqual([
      ['slow', 18],
      ['quick', 13],
      ['tie-a', 13],
      ['tie-b', 13],
    ]);
    expect(order[1]).toEqual({ combatantId: 'quick', roll: 10, dexMod: 3, total: 13 });
  });
});
