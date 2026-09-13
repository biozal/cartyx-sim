import { describe, expect, it } from 'vitest';
import { addItem, removeItem } from '../src/inventory';
import { makeCombatant } from '../src/testing';

const pc = makeCombatant({
  id: 'pc',
  name: 'Tomas',
  inventory: [{ name: 'Healing Potion', quantity: 2 }],
});

describe('inventory', () => {
  it('merges items case-insensitively', () => {
    expect(addItem(pc, 'healing potion').inventory).toEqual([
      { name: 'Healing Potion', quantity: 3 },
    ]);
  });

  it('adds new items', () => {
    expect(addItem(pc, ' Rope ', 1).inventory).toContainEqual({ name: 'Rope', quantity: 1 });
  });

  it('removes part of a stack', () => {
    expect(removeItem(pc, 'Healing Potion').inventory).toEqual([
      { name: 'Healing Potion', quantity: 1 },
    ]);
  });

  it('removes the entry when the stack is used up', () => {
    expect(removeItem(pc, 'Healing Potion', 2).inventory).toEqual([]);
  });

  it('refuses to remove more than is held', () => {
    expect(() => removeItem(pc, 'Healing Potion', 3)).toThrow(
      'Tomas has 2 × "Healing Potion", cannot remove 3'
    );
    expect(() => removeItem(pc, 'Rope')).toThrow('has 0 × "Rope"');
  });

  it('rejects non-positive quantities', () => {
    expect(() => addItem(pc, 'Rope', 0)).toThrow('positive integer');
  });
});
