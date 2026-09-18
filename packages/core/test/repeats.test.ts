import { describe, expect, it } from 'vitest';
import { cutRepeats, repeatedSentences } from '../src/repeats';

describe('cutRepeats', () => {
  it('cuts a sentence the DM already narrated this beat', () => {
    const out = cutRepeats('The gate groans open. Rain hammers the stones.', {
      narratedThisBeat: ['Rain hammers the stones.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: 'The gate groans open.', removed: ['Rain hammers the stones.'] });
  });

  it('cuts a sentence that repeats one sentence of an earlier multi-sentence narration', () => {
    const out = cutRepeats('Thunder rolls overhead. The gate groans open.', {
      narratedThisBeat: ['The wind picks up. The gate groans open. Rain begins to fall.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: 'Thunder rolls overhead.', removed: ['The gate groans open.'] });
  });

  it('matches a repeated sentence case-insensitively and ignoring punctuation', () => {
    const out = cutRepeats('THE GATE GROANS OPEN! Something new happens.', {
      narratedThisBeat: ['The gate groans open.'],
      recentPlayerLines: [],
    });
    expect(out.removed).toEqual(['THE GATE GROANS OPEN!']);
    expect(out.kept).toBe('Something new happens.');
  });

  it("cuts a sentence that quotes a player's line back", () => {
    const out = cutRepeats('Tomas leans forward. "We do not have much time," he says.', {
      narratedThisBeat: [],
      recentPlayerLines: ['We do not have much time before it comes looking.'],
    });
    expect(out.kept).toBe('Tomas leans forward.');
  });

  it("cuts a sentence that quotes a player's line back with curly quotes", () => {
    const out = cutRepeats('Tomas leans forward. “We do not have much time,” he says.', {
      narratedThisBeat: [],
      recentPlayerLines: ['We do not have much time before it comes looking.'],
    });
    expect(out.kept).toBe('Tomas leans forward.');
  });

  it('keeps a short quote and unrelated text', () => {
    const out = cutRepeats('"Go," the guard says.', {
      narratedThisBeat: [],
      recentPlayerLines: ['Go'],
    });
    expect(out.removed).toEqual([]);
  });

  it('keeps everything when nothing repeats', () => {
    const out = cutRepeats('The gate groans open. Rain hammers the stones.', {
      narratedThisBeat: ['A raven calls somewhere in the dark.'],
      recentPlayerLines: ["I'm not going in there."],
    });
    expect(out).toEqual({
      kept: 'The gate groans open. Rain hammers the stones.',
      removed: [],
    });
  });

  it('cuts to nothing when every sentence repeats', () => {
    const out = cutRepeats('Rain hammers the stones.', {
      narratedThisBeat: ['Rain hammers the stones.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: '', removed: ['Rain hammers the stones.'] });
  });
});

describe('repeatedSentences', () => {
  it('finds a sentence the speaker already said', () => {
    expect(
      repeatedSentences('My numbers are what you breathe on. We move now.', [
        'My numbers are what you breathe on.',
      ])
    ).toEqual(['My numbers are what you breathe on.']);
  });

  it('matches case-insensitively and ignoring punctuation and quote marks', () => {
    expect(
      repeatedSentences('"MY NUMBERS ARE WHAT YOU BREATHE ON!"', [
        'My numbers are what you breathe on.',
      ])
    ).toEqual(['"MY NUMBERS ARE WHAT YOU BREATHE ON!"']);
  });

  it('ignores a short line and an unrelated one', () => {
    expect(repeatedSentences('Agreed.', ['Agreed.'])).toEqual([]);
    expect(repeatedSentences('We go left at the fork.', ['We go right at the fork.'])).toEqual([]);
  });

  it('returns nothing when the speaker has not said anything yet', () => {
    expect(repeatedSentences('My numbers are what you breathe on.', [])).toEqual([]);
  });
});
