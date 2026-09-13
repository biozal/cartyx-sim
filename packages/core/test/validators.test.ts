import { describe, expect, it } from 'vitest';
import { validateDmText, validatePlayerText } from '../src/validators';

const pcNames = ['Kira Vale', 'Tomas Reed'];

describe('validateDmText', () => {
  it.each([
    'Kira decides to open the door.',
    'Tomas Reed draws his sword and charges.',
    'Kira says she agrees.',
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

  describe('G4.2: catches past-tense, adverb, vocative, and Unicode PC control', () => {
    const elodieParty = [...pcNames, 'Élodie Marsh'];

    it.each([
      'Kira drew her hammer and attacked the goblin.',
      'Kira decided to follow the shadow.',
      'Kira quickly draws her hammer.',
      'Kira, you draw your hammer and charge.',
    ])('flags: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
        'dm_controls_pc'
      );
    });

    it('flags a Unicode PC name: "Élodie draws her bow."', () => {
      expect(
        validateDmText('Élodie draws her bow.', {
          pcNames: elodieParty,
          mechanicsToolCalled: false,
        })?.rule
      ).toBe('dm_controls_pc');
    });

    it.each([
      'Kira, the lock clicks open under your fingers.',
      'The sentry slams Tomas into the workbench.',
      'Kira, you notice fresh scratches on the housing.',
      'Kira hears a click.',
    ])('still accepts: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
    });
  });

  describe('G4.3: fewer DM validator false positives', () => {
    it('accepts a capitalized common word that only lowercase-matches a PC first name', () => {
      expect(
        validateDmText('The guards will attack at dawn.', {
          pcNames: ['Will Harrow'],
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it('accepts a PC first name that appears lowercase as an ordinary word', () => {
      expect(
        validateDmText('The old sage says nothing.', {
          pcNames: ['Sage Thorn'],
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it('accepts a mechanics-shaped number with no damage/HP noun', () => {
      expect(
        validateDmText('The merchant takes 5 gold from the table.', {
          pcNames,
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it.each([
      'The goblin deals 7 damage to you.',
      'You take 5 points of fire damage.',
      'Kira loses 3 hit points.',
      'The guard rolls a 17.',
      'Tomas regains 4 hit points.',
    ])('still flags mechanics without a tool: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
        'mechanics_without_tool'
      );
    });
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

  describe('F1: questions and opinions are not outcome claims', () => {
    it.each([
      'Who killed the professor?',
      'I am convinced this is a trap.',
      'Has anyone persuaded the dean yet?',
      'Do you know how it works?',
    ])('accepts: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })).toBeNull();
    });

    it.each([
      'I killed the orc.',
      'I convinced the guard.',
      'I successfully pick the lock.',
      'The goblin falls dead.',
      'I roll a 20!',
    ])('still flags: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    });

    it.each(['I roll a 20! Did it work?', 'Who killed him? I killed the orc.'])(
      'flags a claim in a non-question sentence next to a question: "%s"',
      (text) => {
        expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
      }
    );

    it.each([
      'we killed '.repeat(20_000),
      'I am '.repeat(40_000),
      'it works '.repeat(22_223),
      '?'.repeat(200_000),
      ' '.repeat(200_000),
    ])('stays fast on 200,000 characters of adversarial input (case %#)', (text) => {
      const start = performance.now();
      validatePlayerText(text.slice(0, 200_000), { otherPcNames });
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});
