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

  it('drops a short first-person action with a prepositional tail', () => {
    const raw = '"Over here." I glance at Bram.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual(['I glance at Bram.']);
  });

  it('drops a first-person speech tag with an adverb and a participle object', () => {
    const raw = '"Down!" I say sharply, pointing at the ridge.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'I say sharply, pointing at the ridge.',
    ]);
  });

  it('drops a bare first-person action', () => {
    const raw = '"Fine." I sigh.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual(['I sigh.']);
  });

  it('drops a first-person action with a target noun phrase', () => {
    const raw = '"Quiet." I glance toward the door.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'I glance toward the door.',
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

  it.each([
    '"Captain." He asked for you by name, and he said it was urgent.',
    '"Listen." They say the old mine is haunted.',
    '"Enough!" I say we go now.',
    '"Fine." I nod; we should leave before the guards return.',
    '"Fine." I nod — we should leave before the guards return.',
    '"Fine." I nod\nWe should leave before the guards return.',
    '"Run!" I point at the ridge, they are coming from there!',
    '"Fine." I look forward to it.',
    '"Deal." I raise you ten gold.',
    '"No." I draw the line at murder.',
    '"Go." I nod to you and we should go now.',
    '"Wait." I glance at Bram, then we run.',
  ])('keeps %j whole (a clause that runs on into real speech)', (raw) => {
    expect(spoken(raw).directions).toEqual([]);
    expect(spoken(raw).lines).toHaveLength(1);
  });

  // "step" and "lean" are no longer action verbs (round 2): both take a direction word too
  // easily mistaken for a real target, so this round-1 split case is now kept whole.
  it('keeps a removed action verb whole even with an adverb', () => {
    expect(spoken('"Back." I step back slowly.')).toEqual({
      lines: ['Back. I step back slowly.'],
      directions: [],
    });
  });

  it.each([
    '"Enough." I say, bring the rope.',
    '"Go." I say, nothing.',
    '"Listen." I say, something is wrong with the well.',
    '"Fine." I say, Sterling takes first watch.',
    '"Fine." I nod, morning it is.',
    '"Go." I whisper, darling we have to run.',
    '"Go." I nod, King Aldric wants us gone and so do I.',
    '“Go.” I nod, bring the rope.',
    '"Go." I say, meaning we leave at dawn and nobody argues.',
    '"Go." They said, burning the maps is our only option.',
    '"Go." I say it, knowing full well we die here.',
    '"Go." I nod, knowing we have to leave now and you should too.',
    '"Go." I say Molly.',
    '"Go." I reply early.',
    '"Go." I say only.',
    '"Go." I call it early.',
    '"Which way?" I lean toward the east road.',
    '"Fine." I lean towards mercy.',
    '"Enough." I step down as captain.',
    '"Fine." I step up to the plate.',
    '"Deal." I step away from the deal.',
    '"Enough." I step up I\'m going first.',
    '"Go." I step in we go now.',
    '"Fine." I nod back and we go.',
    '"Fine." I nod to say yes.',
    '"Go." I say, drawing my blade and we go now.',
  ])('keeps %j whole (round 2: closed-list probe)', (raw) => {
    expect(spoken(raw).directions).toEqual([]);
    expect(spoken(raw).lines).toHaveLength(1);
  });

  it('drops a bare action with a particle participle', () => {
    const raw = '"Go." I nod, holding still.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'I nod, holding still.',
    ]);
  });

  it('drops a speech tag with a particle participle', () => {
    const raw = '"Back." I say, stepping back.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'I say, stepping back.',
    ]);
  });

  it("doesn't swallow a trailing adverb into a TARGET (the round-2 greedy-TARGET bug)", () => {
    const raw = '"Now." I glance at Bram quietly.';
    const split = splitSpeech(raw);
    expect(split.directions.map((r) => raw.slice(r.start, r.end))).toEqual([
      'I glance at Bram quietly.',
    ]);
  });

  it.each([
    '"Enough." I say, holding this bridge costs too many lives.',
    '"Fine." I nod, moving camp tonight makes sense.',
    '"Go." I say, looking back gets people killed.',
    '"Go." I say, turning back now means death.',
    '"Wait." I say, keeping watch beats sleeping.',
    '"Now." I say, pointing north run for the trees.',
    '"Go." They said, looking at the old mine people vanish.',
    '"Go." I nod, looking toward the hills where the smoke rises tonight.',
    '"Go." I nod, looking back I’m right behind.',
    '"Go." I say, pointing north it’s our only road.',
    '"Go." I say, pointing north we’re leaving tonight.',
    '"Go." I say, pointing north let’s move.',
    '“Go.” I nod, looking back you’re next.',
    '"Go." I say, pointing north we\'ll regroup at the ford.',
    '"Go." I say, pointing north they\'ll never follow.',
    '"Go." I say, pointing north we\'d better hurry.',
    '"Go." I nod, looking back we...go now.',
    '"Go." I say, pointing north that\'s the last of them.',
    '"Go." I say, pointing north don\'t let them through.',
  ])('keeps %j whole (round 3: no free-form participle tail)', (raw) => {
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
