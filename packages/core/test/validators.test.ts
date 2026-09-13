import { describe, expect, it } from 'vitest';
import { validateDmText, validatePlayerText } from '../src/validators';

const pcNames = ['Kira Vale', 'Tomas Reed'];

describe('validateDmText', () => {
  it.each([
    'Kira decides to open the door.',
    'Tomas Reed draws his sword and charges.',
    'kira says she agrees.',
  ])('flags the DM controlling a PC: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'dm_controls_pc'
    );
  });

  it.each([
    'The goblin deals 7 damage to you.',
    'You take 5 points of fire damage.',
    'Kira loses 3 hit points.',
    'The guard rolls a 17.',
  ])('flags invented mechanics: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'mechanics_without_tool'
    );
  });

  it('allows numbers after a mechanics tool ran this beat', () => {
    expect(
      validateDmText('The blade bites deep for 7 damage.', { pcNames, mechanicsToolCalled: true })
    ).toBeNull();
  });

  it.each([
    'The sentry slams Tomas into the workbench.',
    'Kira, the lock clicks open under your fingers.',
    'Three crystal engines hum along the far wall.',
  ])('accepts ordinary narration: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
  });

  it('stays linear on adversarial input instead of matching quadratically', () => {
    const text = 'hp '.repeat(40_000);
    const start = performance.now();
    validateDmText(text, { pcNames, mechanicsToolCalled: false });
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('validatePlayerText', () => {
  const otherPcNames = ['Kira Vale'];

  it('flags a player controlling another PC', () => {
    expect(
      validatePlayerText('Kira attacks the engine with her wrench.', { otherPcNames })?.rule
    ).toBe('player_controls_other');
  });

  it.each(['I successfully pick the lock.', 'I roll a 20!'])(
    'flags a player narrating outcomes: "%s"',
    (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    }
  );

  it.each([
    'I try to convince the guard to let us pass.',
    'I convince the guard to let us pass.',
    'Careful, Kira.',
    'I swing my longsword at the sentry.',
  ])('accepts declared attempts: "%s"', (text) => {
    expect(validatePlayerText(text, { otherPcNames })).toBeNull();
  });

  describe('G4.1: only flags completed-outcome phrasing', () => {
    it.each([
      'I hit the orc with my warhammer.',
      'Can we convince them to stand down?',
      'I hope we succeed.',
      'I attack the goblin.',
      'We try to persuade the guard.',
    ])('accepts: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })).toBeNull();
    });

    it.each([
      'I successfully pick the lock.',
      'I killed the orc.',
      'The guard is convinced and lets us pass.',
      'I roll a 20!',
      'It works perfectly.',
      'The goblin falls dead.',
      'I convinced the guard.',
    ])('flags: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    });
  });
});
