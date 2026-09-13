import { describe, expect, it } from 'vitest';
import { describeSlots, restoreSlots, slotsRemaining, spendSlot } from '../src/slots';
import { makeCombatant } from '../src/testing';

const caster = makeCombatant({
  id: 'caster',
  name: 'Oona',
  spellSlots: [
    { level: 1, max: 4, used: 1 },
    { level: 2, max: 2, used: 2 },
  ],
});

describe('spell slots', () => {
  it('reports remaining slots', () => {
    expect(slotsRemaining(caster, 1)).toBe(3);
    expect(slotsRemaining(caster, 2)).toBe(0);
    expect(slotsRemaining(caster, 3)).toBe(0);
  });

  it('spends a slot', () => {
    expect(slotsRemaining(spendSlot(caster, 1), 1)).toBe(2);
  });

  it('refuses to spend a slot that is not available', () => {
    expect(() => spendSlot(caster, 2)).toThrow(
      'Oona has no level 2 spell slots left (slots: L1 3/4, L2 0/2)'
    );
  });

  it('restores all slots', () => {
    expect(describeSlots(restoreSlots(caster))).toBe('L1 4/4, L2 2/2');
  });
});
