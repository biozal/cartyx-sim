import { describe, expect, it } from 'vitest';
import { finishLine, sliceText } from '../src/normalize';
import {
  narrationPieces,
  segmentNarration,
  type NarrationPiece,
  type QuoteLabel,
  type SegmentedNarration,
} from '../src/narration';

const PARTY = [
  { id: 'kira', name: 'Kira Vale' },
  { id: 'tomas', name: 'Tomas Reed' },
];

const CREATURE =
  'The slit opens.\n\n' +
  '*"You... opened... the door,"* it rasps, the voice sounding like grinding stones.\n\n' +
  'The creature takes a step forward.\n\n' +
  '**Hand off.**';

function texts(segmented: SegmentedNarration, pieces: NarrationPiece[]) {
  return pieces.map((piece) => ({
    kind: piece.kind,
    speaker: piece.speaker,
    text: finishLine(sliceText(segmented.mask.raw, piece.ranges)),
    ...(piece.dmWrotePc ? { dmWrotePc: piece.dmWrotePc } : {}),
  }));
}

describe('segmentNarration', () => {
  it('drops the hand-off line, finds the quote, and numbers it for the prompt', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    expect(segmented.blocks).toHaveLength(3);
    expect(segmented.dropped).toHaveLength(1);
    const drop = segmented.dropped[0]!;
    expect(drop.reason).toBe('hand_off');
    expect(CREATURE.slice(drop.start, drop.end)).toBe('**Hand off.**');
    expect(segmented.quotes.map((quote) => quote.text)).toEqual(['You... opened... the door.']);
    expect(segmented.promptText).toBe(
      'The slit opens.\n\n' +
        '[[1]]"You... opened... the door," it rasps, the voice sounding like grinding stones.\n\n' +
        'The creature takes a step forward.'
    );
  });

  it('drops DM prefixes and joins consecutive lines into one block', () => {
    const raw = 'DM: The mist clears.\n**DM:** Silence.';
    const segmented = segmentNarration(raw, PARTY);
    expect(segmented.dropped.map((drop) => [drop.reason, raw.slice(drop.start, drop.end)])).toEqual(
      [
        ['dm_prefix', 'DM:'],
        ['dm_prefix', '**DM:**'],
      ]
    );
    expect(texts(segmented, narrationPieces(segmented, []))).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'The mist clears. Silence.' },
    ]);
  });

  it('makes each list item its own narration line', () => {
    const segmented = segmentNarration('You see:\n- a rusted gate\n- **two** statues', PARTY);
    expect(texts(segmented, narrationPieces(segmented, [])).map((piece) => piece.text)).toEqual([
      'You see.',
      'a rusted gate.',
      'two statues.',
    ]);
  });

  it('removes a hand-off line naming a party member but keeps one naming a stranger', () => {
    const segmented = segmentNarration('Dust falls.\nHand off to Kira Vale.', PARTY);
    expect(segmented.dropped.map((drop) => drop.reason)).toEqual(['hand_off']);
    const kept = segmentNarration('Dust falls.\nHand off to Zed.', PARTY);
    expect(kept.dropped).toEqual([]);
  });

  it('skips quotes with no words', () => {
    expect(segmentNarration('A sound: "..." then nothing.', PARTY).quotes).toEqual([]);
  });
});

describe('narrationPieces', () => {
  it('splits a quote labeled as speech into its own dialogue line', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    const labels: QuoteLabel[] = [{ kind: 'speech', speaker: 'npc-faceless-creature' }];
    expect(texts(segmented, narrationPieces(segmented, labels))).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'The slit opens.' },
      { kind: 'dialogue', speaker: 'npc-faceless-creature', text: 'You... opened... the door.' },
      {
        kind: 'narration',
        speaker: 'dm',
        text: 'it rasps, the voice sounding like grinding stones.',
      },
      { kind: 'narration', speaker: 'dm', text: 'The creature takes a step forward.' },
    ]);
  });

  it('leaves a quote labeled as narration inside the narration, without quote marks', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    const pieces = texts(segmented, narrationPieces(segmented, [{ kind: 'narration' }]));
    expect(pieces.map((piece) => piece.text)).toEqual([
      'The slit opens.',
      'You... opened... the door, it rasps, the voice sounding like grinding stones.',
      'The creature takes a step forward.',
    ]);
  });

  it('keeps DM-written PC dialogue in the DM voice with a flag', () => {
    const segmented = segmentNarration('Kira nods. "We go now," she says.', PARTY);
    const pieces = narrationPieces(segmented, [
      { kind: 'speech', speaker: 'dm', dmWrotePc: 'kira' },
    ]);
    expect(texts(segmented, pieces)).toEqual([
      { kind: 'narration', speaker: 'dm', text: 'Kira nods.' },
      { kind: 'dialogue', speaker: 'dm', text: 'We go now.', dmWrotePc: 'kira' },
      { kind: 'narration', speaker: 'dm', text: 'she says.' },
    ]);
  });

  it('runs an unclosed quote to the end of its block', () => {
    const segmented = segmentNarration('She hisses "Leave now and never return.', PARTY);
    const pieces = narrationPieces(segmented, [{ kind: 'speech', speaker: 'npc-hag' }]);
    expect(texts(segmented, pieces).map((piece) => piece.text)).toEqual([
      'She hisses.',
      'Leave now and never return.',
    ]);
  });

  it('throws when the label count does not match the quotes', () => {
    const segmented = segmentNarration(CREATURE, PARTY);
    expect(() => narrationPieces(segmented, [])).toThrow(/1 quote/);
  });
});
