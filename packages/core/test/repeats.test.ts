import { describe, expect, it } from 'vitest';
import { cutRepeats, repeatedSentences, retellsNarration } from '../src/repeats';

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

  it('matches the style of the mark that opened the quote, not other marks in the narration', () => {
    const out = cutRepeats(
      'She says “fine.” He nods. "Take the long road. The old gate groans open again."',
      {
        narratedThisBeat: ['The old gate groans open again.'],
        recentPlayerLines: [],
      }
    );
    expect(out.kept).toBe('She says “fine.” He nods. "Take the long road."');
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

describe('retellsNarration', () => {
  // Session 010: the DM told Kira's step toward the monolith, then told it again in new words.
  const told =
    "She steps forward on the beat. The mist does not part. A thick tendril of cold vapor lashes out from the base of the monolith, wrapping around Kira's ankle with surprising strength. It yanks her off balance, and a wave of magical energy blasts against her chest, sending her skidding back five paces.";

  it('flags a paraphrase of narration already told this turn (session 010)', () => {
    expect(
      retellsNarration(
        'Kira calls out the count, raising her hammer as she measures the rhythm. On the third beat, she steps forward. A tendril of cold vapor lashes out from the monolith and wraps her ankle, and magical energy blasts her back five paces.',
        [told]
      )
    ).toBe(true);
  });

  it('flags a miss told again in other words (session 007)', () => {
    expect(
      retellsNarration("Mira's light hammer swings wide, missing the hooded figure entirely.", [
        "Mira's light hammer flies wide, striking the wall with a dull thud as the hooded figure sidesteps the attack.",
      ])
    ).toBe(true);
  });

  it('keeps narration that moves the story on, even when it names the same things', () => {
    expect(
      retellsNarration(
        'Behind Kira, the monolith cracks down its center. Silver light spills across the clearing, and somewhere beyond the trees a bell begins to toll.',
        [told]
      )
    ).toBe(false);
  });

  it('keeps a short new beat after a long opening that named the same places', () => {
    // Session 010's real opening narration (268 words).
    const opening =
      "The party moves forward in formation. Kira takes point, her light hammer gripped tight as she steps onto the pale stone path. The mist parts cleanly at her boots, revealing the smooth, bone-white surface beneath. She pauses occasionally, watching the vapors curl and retreat, before continuing deeper into the woods.\n\nTomas falls to the rear, his longsword held ready, his gaze constantly scanning the dense, shadowed tree line for any sign of movement. Mira and Bram walk side-by-side in the middle, their footsteps muffled by the thickening fog that clings to their ankles but refuses to rise above their knees.\n\nThe ancient oaks tower overhead, their interlocking branches blotting out the morning sun. As they walk deeper, the silence of the woods begins to shift. A low, whispering sound rises from the mist\u2014a hushed, echoing murmur that sounds like voices speaking in a language just out of reach. The air grows noticeably colder, carrying the sharp scent of damp earth and ozone.\n\nAfter several minutes of tense walking, the canopy suddenly breaks. The path opens into a small, perfectly circular clearing bathed in an eerie, shadowless light. At its center stands a massive stone monolith, ancient and moss-draped, covered in spiraling carvings that seem to shift and twist when viewed from the corner of the eye. The mist pools thickly around the base of the stone, swirling like a slow, breathing entity.\n\nThe group halts at the edge of the clearing. The whispering fades to a near-silence, leaving only the sound of wind through the leaves and the group's own breathing. The monolith stands waiting, silent and imposing.";
    expect(
      retellsNarration(
        'The mist around the base of the monolith stirs. A pale figure steps out of the stone, its carvings glowing as it raises a hand toward the party.',
        [opening]
      )
    ).toBe(false);
  });

  it('counts a possessive and either apostrophe as the same word', () => {
    const told =
      "Kira's hammer strikes the ghoul's skull with a sickening crack, and the ghoul reels.";
    expect(
      retellsNarration(
        'Kira’s hammer strikes the ghoul’s skull with a sickening crack; the ghoul reels.',
        [told]
      )
    ).toBe(true);
  });

  it('never judges a short line or the first narration of a turn', () => {
    expect(retellsNarration('Kira, what do you do?', [told])).toBe(false);
    expect(retellsNarration(told, [])).toBe(false);
  });
});
