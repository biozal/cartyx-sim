import { describe, expect, it } from 'vitest';
import { buildScript } from '../src/build';
import { invariantViolations } from '../src/invariants';
import type { ScriptFile, VoicedLine } from '../src/schema';
import { eventLog, narration, SHA } from './helpers';

const EVENTS = eventLog([
  narration('## The Hall\nDM: Dust.\n- a gate\n\n"Who goes there?" a voice asks.\n\nHand off.'),
  {
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'neutral',
    text: '"Me." I step forward. "Kira."',
  },
]);

async function built(): Promise<ScriptFile> {
  return (await buildScript({ campaign: 'a', session: 1, eventsSha256: SHA, events: EVENTS }))
    .script;
}

describe('invariantViolations', () => {
  it('finds nothing wrong with a built script', async () => {
    expect(invariantViolations(await built(), EVENTS)).toEqual([]);
  });

  it('reports a line whose text does not come from its sources', async () => {
    const script = await built();
    (script.lines[0] as VoicedLine).text = 'Invented words.';
    expect(invariantViolations(script, EVENTS)).toEqual([
      expect.stringMatching(/^L0001: text "Invented words\." does not match its sources/),
    ]);
  });

  it('reports source text that ends up in no line and was not dropped', async () => {
    const script = await built();
    script.lines.splice(-1, 1);
    expect(invariantViolations(script, EVENTS)).toEqual([
      expect.stringMatching(/^seq 2: .* is in no line and was not dropped$/),
    ]);
  });

  it('reports ids out of sequence and sources outside a spoken event', async () => {
    const script = await built();
    const line = script.lines[0] as VoicedLine;
    line.id = 'L0009';
    line.sources = [{ seq: 0, start: 0, end: 3 }];
    const problems = invariantViolations(script, EVENTS);
    expect(problems).toContain('L0009: expected id L0001');
    expect(problems).toContain('L0009: source 0:0-3 is not in a spoken event');
  });

  it('reports a dropped span whose text does not match its source', async () => {
    const script = await built();
    const line = script.lines.find(
      (candidate): candidate is VoicedLine => 'dropped' in candidate && !!candidate.dropped?.length
    )!;
    const span = line.dropped![0]!;
    span.text = 'x';
    expect(invariantViolations(script, EVENTS)).toContain(
      `${line.id}: dropped span ${span.seq}:${span.start}-${span.end} does not match its source`
    );
  });

  it('reports a dropped span whose end runs past its source text', async () => {
    const script = await built();
    const line = script.lines.find(
      (candidate): candidate is VoicedLine => 'dropped' in candidate && !!candidate.dropped?.length
    )!;
    const span = line.dropped![0]!;
    span.end += 1000;
    expect(invariantViolations(script, EVENTS)).toContain(
      `${line.id}: dropped span ${span.seq}:${span.start}-${span.end} does not match its source`
    );
  });

  it('reports a dropped span with a negative start even when the negative-index slice matches', async () => {
    const script = await built();
    const line = script.lines.find(
      (candidate): candidate is VoicedLine => 'dropped' in candidate && !!candidate.dropped?.length
    )!;
    const span = line.dropped![0]!;
    const event = EVENTS.find((candidate) => candidate.seq === span.seq)!;
    const sourceLength =
      event.type === 'narration' || event.type === 'dialogue' ? event.text.length : 0;
    // A negative start this far below zero maps to the same non-negative index, so
    // `text.slice(span.start, span.end)` still equals `span.text` by coincidence.
    span.start -= sourceLength;
    expect(invariantViolations(script, EVENTS)).toContain(
      `${line.id}: dropped span ${span.seq}:${span.start}-${span.end} does not match its source`
    );
  });

  it('reports a line whose source points at a non-public event', async () => {
    const log = eventLog([
      narration('The gate creaks.'),
      { ...narration('Note.'), visibility: 'dm' },
    ]);
    const script = (
      await buildScript({ campaign: 'a', session: 1, eventsSha256: SHA, events: log })
    ).script;
    const line = script.lines[0] as VoicedLine;
    line.sources = [{ seq: 2, start: 0, end: 5 }];
    line.text = 'Note.';
    expect(invariantViolations(script, log)).toContain('L0001: source 2 is not a public event');
  });
});
