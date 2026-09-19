import { describe, expect, it } from 'vitest';
import { cutRepeats, repeatedSentences } from '../src/repeats';

describe('cutRepeats', () => {
  it('cuts a sentence the DM already narrated this beat', () => {
    const out = cutRepeats('The gate groans open. Rain hammers down on the stones.', {
      narratedThisBeat: ['Rain hammers down on the stones.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({
      kept: 'The gate groans open.',
      removed: ['Rain hammers down on the stones.'],
    });
  });

  it('cuts a sentence that repeats one sentence of an earlier multi-sentence narration', () => {
    const out = cutRepeats('Thunder rolls overhead. The old gate groans open again.', {
      narratedThisBeat: ['The wind picks up. The old gate groans open again. Rain begins to fall.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({
      kept: 'Thunder rolls overhead.',
      removed: ['The old gate groans open again.'],
    });
  });

  it('matches a repeated sentence case-insensitively and ignoring punctuation', () => {
    const out = cutRepeats('THE OLD GATE GROANS OPEN AGAIN! Something new happens.', {
      narratedThisBeat: ['The old gate groans open again.'],
      recentPlayerLines: [],
    });
    expect(out.removed).toEqual(['THE OLD GATE GROANS OPEN AGAIN!']);
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
    const out = cutRepeats('Rain hammers down on the stones.', {
      narratedThisBeat: ['Rain hammers down on the stones.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: '', removed: ['Rain hammers down on the stones.'] });
  });

  it('keeps a short refrain repeated across beats instead of cutting it, like repeatedSentences does', () => {
    const out = cutRepeats('Silence.', {
      narratedThisBeat: ['Silence.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: 'Silence.', removed: [] });
  });

  it('still cuts a 5-word sentence repeated across beats', () => {
    const out = cutRepeats('The gate groans shut again.', {
      narratedThisBeat: ['The gate groans shut again.'],
      recentPlayerLines: [],
    });
    expect(out).toEqual({ kept: '', removed: ['The gate groans shut again.'] });
  });
});

describe('cutRepeats keeps quotes balanced', () => {
  it('reopens and recloses a quote whose first and last sentences were cut (session 008)', () => {
    const out = cutRepeats(
      '"Silas patches up his own problems usually," the tavern keeper grunts. "But he\'s right about one thing. That place... it\'s been quiet. Too quiet. And the sheep stopped coming near the lower pastures two days ago." He turns his sharp eyes to the party.',
      {
        narratedThisBeat: [
          '"But he\'s right about one thing. And the sheep stopped coming near the lower pastures two days ago."',
        ],
        recentPlayerLines: [],
      }
    );
    expect(out.kept).toBe(
      '"Silas patches up his own problems usually," the tavern keeper grunts. "That place... it\'s been quiet. Too quiet." He turns his sharp eyes to the party.'
    );
  });

  it('uses curly marks when the narration does', () => {
    const out = cutRepeats('“The gate is sealed for good now. Nobody leaves tonight.” He sighs.', {
      narratedThisBeat: ['“The gate is sealed for good now.'],
      recentPlayerLines: [],
    });
    expect(out.kept).toBe('“Nobody leaves tonight.” He sighs.');
  });

  it('closes a quote whose closing sentence was cut when nothing follows', () => {
    const out = cutRepeats('"Stay close. The old gate groans open again."', {
      narratedThisBeat: ['The old gate groans open again.'],
      recentPlayerLines: [],
    });
    expect(out.kept).toBe('"Stay close."');
  });

  it('leaves a narration that was unbalanced to begin with as it was', () => {
    const out = cutRepeats('The old gate groans open again. "Stay close.', {
      narratedThisBeat: ['The old gate groans open again.'],
      recentPlayerLines: [],
    });
    expect(out.kept).toBe('"Stay close.');
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
