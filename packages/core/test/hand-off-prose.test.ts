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

  it('falls back to the party for an unknown name', () => {
    const result = extractHandOffProse('Hand off to Bram.', party);
    expect(result.target).toEqual({ kind: 'party' });
  });

  it.each(['anyone', 'whoever wants to act', 'whoever'])('maps "%s" to open', (phrase) => {
    const result = extractHandOffProse(`Hand off to ${phrase}.`, party);
    expect(result.target).toEqual({ kind: 'open' });
  });

  it('matches a leading "DM:" prefix', () => {
    const result = extractHandOffProse('DM: Hand off to Bram.', party);
    expect(result.lines).toEqual(['Hand off to Bram.']);
    expect(result.target).toEqual({ kind: 'party' });
  });

  it('matches surrounding ** emphasis', () => {
    const result = extractHandOffProse('**Hand off to the party.**', party);
    expect(result.lines).toEqual(['Hand off to the party.']);
    expect(result.target).toEqual({ kind: 'party' });
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

  it('uses the target from the last of two matched lines', () => {
    const text = 'Hand off to Kira.\n\nHand off to Tomas.';
    const result = extractHandOffProse(text, party);
    expect(result.lines).toEqual(['Hand off to Kira.', 'Hand off to Tomas.']);
    expect(result.target).toEqual({ kind: 'pcs', ids: ['tomas'] });
  });
});
