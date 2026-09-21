import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { initialState } from '../src/state';

function recorder(): TurnRecorder {
  return new TurnRecorder(initialState(), 'turn-1', () => new Date('2026-09-20T00:00:00.000Z'));
}

function inventionSeqs(events: readonly { type: string }[]): (number | undefined)[] {
  return events
    .filter(
      (event): event is { type: 'lore_invention'; narrationSeq?: number } & typeof event =>
        event.type === 'lore_invention'
    )
    .map((event) => event.narrationSeq);
}

describe('linkInventions', () => {
  it('links an invention to the first narration that follows it in the turn', () => {
    const turn = recorder();
    turn.emit({
      type: 'lore_invention',
      visibility: 'dm',
      fact: 'A salt-line ward',
      reason: 'gap',
    });
    const narration = turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'A salt line crosses the threshold.',
      emotion: 'neutral',
    });
    turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The door stands open beyond it.',
      emotion: 'neutral',
    });
    turn.linkInventions();
    expect(inventionSeqs(turn.events)).toEqual([narration.seq]);
  });

  it('falls back to the last narration before it when nothing follows', () => {
    const turn = recorder();
    const narration = turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'A salt line crosses the threshold.',
      emotion: 'neutral',
    });
    turn.emit({
      type: 'lore_invention',
      visibility: 'dm',
      fact: 'A salt-line ward',
      reason: 'gap',
    });
    turn.linkInventions();
    expect(inventionSeqs(turn.events)).toEqual([narration.seq]);
  });

  it('leaves the link absent when the turn narrated nothing', () => {
    const turn = recorder();
    turn.emit({
      type: 'lore_invention',
      visibility: 'dm',
      fact: 'A salt-line ward',
      reason: 'gap',
    });
    turn.linkInventions();
    expect(inventionSeqs(turn.events)).toEqual([undefined]);
  });

  it('links two inventions in one turn to their own following narrations', () => {
    const turn = recorder();
    turn.emit({ type: 'lore_invention', visibility: 'dm', fact: 'one', reason: 'gap' });
    const first = turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The first detail lands.',
      emotion: 'neutral',
    });
    turn.emit({ type: 'lore_invention', visibility: 'dm', fact: 'two', reason: 'gap' });
    const second = turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The second detail lands.',
      emotion: 'neutral',
    });
    turn.linkInventions();
    expect(inventionSeqs(turn.events)).toEqual([first.seq, second.seq]);
  });

  it('is idempotent, so a rolled-back and re-linked turn keeps one answer', () => {
    const turn = recorder();
    turn.emit({ type: 'lore_invention', visibility: 'dm', fact: 'one', reason: 'gap' });
    const narration = turn.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The detail lands.',
      emotion: 'neutral',
    });
    turn.linkInventions();
    turn.linkInventions();
    expect(inventionSeqs(turn.events)).toEqual([narration.seq]);
  });
});
