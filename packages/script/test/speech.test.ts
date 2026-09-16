import { describe, expect, it } from 'vitest';
import { finishLine, sliceText, type Range } from '../src/normalize';
import { cleanAction, splitSpeech } from '../src/speech';

function spoken(
  raw: string,
  names: readonly string[] = []
): { lines: string[]; directions: string[] } {
  const split = splitSpeech(raw, names);
  return {
    lines: split.lines.map((ranges) => finishLine(sliceText(raw, ranges))),
    directions: split.directions.map((range: Range) => raw.slice(range.start, range.end)),
  };
}

describe('splitSpeech', () => {
  it('splits quoted speech from a stage direction between quotes (Kira, avalon 003 #7)', () => {
    const raw =
      '"Holding its breath, you say. Or holding us for it." I keep my voice low, eyes drifting ' +
      'along the tree line before settling on the archway. "Whatever made this place empty, ' +
      'it\'s not in a hurry. So neither should we be."';
    expect(spoken(raw)).toEqual({
      lines: [
        'Holding its breath, you say. Or holding us for it.',
        "Whatever made this place empty, it's not in a hurry. So neither should we be.",
      ],
      directions: [
        'I keep my voice low, eyes drifting along the tree line before settling on the archway.',
      ],
    });
  });

  it('drops a trailing stage direction and ends a comma-final quote with a period', () => {
    expect(spoken('"No blood means they didn\'t feed here," I say quietly.')).toEqual({
      lines: ["No blood means they didn't feed here."],
      directions: ['I say quietly.'],
    });
  });

  it('keeps unquoted speech whole and removes a stray trailing quote (Kira, avalon 004 #7)', () => {
    const raw =
      "Heavy, maybe. But heavy things can be traps as easily as treasures. I'd rather know " +
      'what we\'re walking into before we walk in."';
    expect(spoken(raw)).toEqual({
      lines: [
        "Heavy, maybe. But heavy things can be traps as easily as treasures. I'd rather know " +
          "what we're walking into before we walk in.",
      ],
      directions: [],
    });
  });

  it('removes wrapping and doubled quotes', () => {
    expect(spoken('"Agreed, Bram. That light is pulsing."”').lines).toEqual([
      'Agreed, Bram. That light is pulsing.',
    ]);
  });

  it('keeps a self-correction slip as spoken, without emphasis marks', () => {
    expect(spoken("Kira's — I mean, *my* — take is this: we wait.").lines).toEqual([
      "Kira's — I mean, my — take is this: we wait.",
    ]);
  });

  it('keeps a line with a scare-quoted word whole', () => {
    expect(spoken('The "door" it\'s talking about is the seal.').lines).toEqual([
      "The door it's talking about is the seal.",
    ]);
  });

  it('keeps a line whole when a leading quote covers only a small part of it', () => {
    expect(spoken('"Door" is the wrong word for what this thing guards, friend.').lines).toEqual([
      'Door is the wrong word for what this thing guards, friend.',
    ]);
  });

  it('returns no lines for text with no words', () => {
    expect(spoken('"..."')).toEqual({ lines: [], directions: [] });
  });

  it('records source ranges that reproduce each line', () => {
    const raw = '"Stay close." I raise my lantern. "And quiet."';
    const split = splitSpeech(raw);
    expect(split.lines.map((ranges) => sliceText(raw, ranges))).toEqual([
      'Stay close.',
      'And quiet.',
    ]);
    for (const range of split.directions) {
      expect(split.mask.keptText(range.start, range.end)).toBe('');
    }
  });
});

describe('splitSpeech direction rule', () => {
  it('drops a leading first-person action', () => {
    expect(spoken('I nod slowly. "Let\'s go, then."')).toEqual({
      lines: ["Let's go, then."],
      directions: ['I nod slowly.'],
    });
  });

  it('drops a short trailing speech tag', () => {
    expect(spoken('"Hello," she says.')).toEqual({
      lines: ['Hello.'],
      directions: ['she says.'],
    });
  });

  it('drops a long speech tag between two quotes', () => {
    expect(
      spoken('"Stay back," I say, drawing my blade and stepping between them. "Now."')
    ).toEqual({
      lines: ['Stay back.', 'Now.'],
      directions: ['I say, drawing my blade and stepping between them.'],
    });
  });

  it("accepts the speaker's own name as a tag subject", () => {
    const raw = '"Wait." Kira whispers it, barely moving.';
    const split = splitSpeech(raw, ['Kira Vale', 'Kira']);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'Kira whispers it, barely moving.',
    ]);
  });

  it.each([
    'Aye, the "old road" is safer.',
    'I think "Stay back" is wise.',
    '"Never." Well, I don\'t.',
    '"Go." I let him go once.',
    'I nod. "Fine." We should move before dark.',
    'I nod slowly. "Stay back," I say. "Now',
  ])('keeps %j whole', (raw) => {
    expect(spoken(raw).directions).toEqual([]);
    expect(spoken(raw).lines).toHaveLength(1);
  });
});

describe('cleanAction', () => {
  it('removes emphasis and quote marks', () => {
    const raw = 'Edge toward the *crumbling* archway, "carefully"';
    const { ranges } = cleanAction(raw);
    expect(finishLine(sliceText(raw, ranges))).toBe(
      'Edge toward the crumbling archway, carefully.'
    );
  });
});
