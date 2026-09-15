import { describe, expect, it } from 'vitest';
import { extractHandOffProse } from '../src/hand-off-prose';

const party = [
  { id: 'kira', name: 'Kira Vale' },
  { id: 'mira', name: 'Mira Sol' },
  { id: 'tomas', name: 'Tomas Reed' },
];

describe('extractHandOffProse', () => {
  it.each(['party', 'group', 'players', 'everyone', 'all of you', 'you all', 'the party'])(
    'maps "%s" to the party',
    (phrase) => {
      const result = extractHandOffProse(`Hand off to ${phrase}.`, party);
      expect(result.target).toEqual({ kind: 'party' });
    }
  );

  it('maps a single PC named by first name', () => {
    const result = extractHandOffProse('Hand off to Kira.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('maps a single PC named by full name', () => {
    const result = extractHandOffProse('Hand off to Kira Vale.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('maps two PCs named together, in party order', () => {
    const result = extractHandOffProse('Hand off to Kira and Mira.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira', 'mira'] });
  });

  it('maps a comma-separated list of three PCs', () => {
    const result = extractHandOffProse('Hand off to Kira, Mira, and Tomas.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira', 'mira', 'tomas'] });
  });

  it('leaves a line naming an unknown PC untouched (no fallback to the party)', () => {
    const text = 'Hand off to Bram.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a line naming an unknown name with diacritics untouched', () => {
    const text = 'Hand off to Élise.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('matches a PC name with diacritics when the party has that member', () => {
    const withElise = [...party, { id: 'elise', name: 'Élise Durand' }];
    const result = extractHandOffProse('Hand off to Élise.', withElise);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['elise'] });
  });

  it.each(['anyone', 'whoever wants to act', 'whoever'])('maps "%s" to open', (phrase) => {
    const result = extractHandOffProse(`Hand off to ${phrase}.`, party);
    expect(result.target).toEqual({ kind: 'open' });
  });

  it('matches a leading "DM:" prefix, keeping the raw line in `lines`', () => {
    const result = extractHandOffProse('DM: Hand off to Kira.', party);
    expect(result.lines).toEqual(['DM: Hand off to Kira.']);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('matches surrounding ** emphasis, keeping the raw line in `lines`', () => {
    const result = extractHandOffProse('**Hand off to the party.**', party);
    expect(result.lines).toEqual(['**Hand off to the party.**']);
    expect(result.target).toEqual({ kind: 'party' });
  });

  it('matches "DM:" outside a whole-line emphasis wrap', () => {
    const result = extractHandOffProse('DM: **Hand off to Kira.**', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('matches an emphasis-wrapped "DM:" prefix ahead of plain text', () => {
    const result = extractHandOffProse('**DM:** Hand off to Kira.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('matches "Handing off to <name>!"', () => {
    const result = extractHandOffProse('Handing off to Kira!', party);
    expect(result.lines).toEqual(['Handing off to Kira!']);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira'] });
  });

  it('leaves a narrative sentence containing "hands off … to" untouched', () => {
    const text = 'Kira hands off the torch to Mira.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a hand-off line with trailing narration after the name untouched', () => {
    const text = 'Hand off to Kira. She draws her blade and Mira watches.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a hand-off line with a trailing question untouched', () => {
    const text = 'Hand off to the party. What do you do?';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves untouched an emphasis-wrapped line with more emphasis inside it', () => {
    const text = '*Hand off to Kira.* The dwarf nods, *grim*';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a hand-off line qualified by a clause about timing untouched', () => {
    const text = 'Hand off to the next watch when the bell rings.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a hand-off line naming a PC but qualified by a clause untouched', () => {
    const text = 'Hand off to Kira when the bell rings.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('returns an empty text when the text is only the hand-off line', () => {
    const result = extractHandOffProse('Hand off to the party.', party);
    expect(result.text).toBe('');
  });

  it('removes a line in the middle of the text and collapses blank lines', () => {
    const text = 'First paragraph.\n\nHand off to Kira.\n\nSecond paragraph.';
    const result = extractHandOffProse(text, party);
    expect(result.text).toBe('First paragraph.\n\nSecond paragraph.');
    expect(result.lines).toEqual(['Hand off to Kira.']);
  });

  it('collapses whitespace-only blank lines left around a removed line', () => {
    const text = 'A.\n  \nHand off to Kira.\n  \nB.';
    const result = extractHandOffProse(text, party);
    expect(result.text).toBe('A.\n\nB.');
  });

  it('uses the target from the last of two matched lines', () => {
    const text = 'Hand off to Kira.\n\nHand off to Tomas.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual(['Hand off to Kira.', 'Hand off to Tomas.']);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['tomas'] });
  });

  it('leaves a line with a leading stray separator untouched', () => {
    const text = 'Hand off to , Mira.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a line with a trailing stray separator untouched', () => {
    const text = 'Hand off to Mira,';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('leaves a line with a dangling "and" untouched', () => {
    const text = 'Hand off to Mira and.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
  });

  it('matches names joined with no spaces around the comma', () => {
    const result = extractHandOffProse('Hand off to Kira,Mira.', party);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['kira', 'mira'] });
  });

  describe('a party member whose full name contains a separator word', () => {
    const partyWithSaltAndPepper = [
      { id: 'salt-and-pepper', name: 'Salt and Pepper' },
      { id: 'mira', name: 'Mira Ashdown' },
    ];

    it('matches the full name alone', () => {
      const result = extractHandOffProse('Hand off to Salt and Pepper.', partyWithSaltAndPepper);
      expect(result.target).toEqual({ kind: 'pcs', ids: ['salt-and-pepper'] });
    });

    it('matches the full name followed by another PC', () => {
      const result = extractHandOffProse(
        'Hand off to Salt and Pepper and Mira.',
        partyWithSaltAndPepper
      );
      expect(result.target).toEqual({ kind: 'pcs', ids: ['salt-and-pepper', 'mira'] });
    });
  });

  describe('two party members sharing a first name', () => {
    const partyWithSharedFirstName = [
      { id: 'kira-vale', name: 'Kira Vale' },
      { id: 'kira-stone', name: 'Kira Stone' },
    ];

    it('leaves the shared first name unresolved', () => {
      const text = 'Hand off to Kira.';
      const result = extractHandOffProse(text, partyWithSharedFirstName);
      expect(result.lines).toEqual([]);
      expect(result.target).toBeUndefined();
      expect(result.text).toBe(text);
    });

    it('still matches a full name', () => {
      const result = extractHandOffProse('Hand off to Kira Stone.', partyWithSharedFirstName);
      expect(result.target).toEqual({ kind: 'pcs', ids: ['kira-stone'] });
    });
  });

  it('resolves a huge run of whitespace inside the phrase in well under a second', () => {
    const text = `Hand off to Mira${' '.repeat(50000)}x.`;
    const start = performance.now();
    const result = extractHandOffProse(text, party);
    const elapsed = performance.now() - start;
    expect(result.lines).toEqual([]);
    expect(result.target).toBeUndefined();
    expect(result.text).toBe(text);
    expect(elapsed).toBeLessThan(1000);
  });
});
