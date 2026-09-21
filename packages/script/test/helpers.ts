import { initialState, TurnRecorder, type EventInput, type SimEvent } from '@cartyx-sim/core';
import type { Combatant } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import type { Labeler, LabelRequest, LabelResult } from '../src/attribution';

export const KIRA = makeCombatant({ id: 'kira', name: 'Kira Vale' });
export const TOMAS = makeCombatant({ id: 'tomas', name: 'Tomas Reed' });
export const SHA = 'a'.repeat(64);

const NOW = () => new Date('2026-09-16T12:00:00.000Z');

/** A valid log: `session_start` (seq 0) with the party, then `inputs` as seq 1, 2, … */
export function eventLog(inputs: EventInput[], party: Combatant[] = [KIRA, TOMAS]): SimEvent[] {
  const recorder = new TurnRecorder(initialState(), 'test-turn', NOW);
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 60,
    party,
  });
  for (const input of inputs) recorder.emit(input);
  return [...recorder.events];
}

export function narration(text: string): EventInput {
  return { type: 'narration', speaker: 'dm', text, emotion: 'neutral' };
}

/** A labeler that records requests and answers with `answer`. */
export class FakeLabeler implements Labeler {
  readonly requests: LabelRequest[] = [];

  constructor(private readonly answer: (request: LabelRequest) => LabelResult) {}

  async label(request: LabelRequest): Promise<LabelResult> {
    this.requests.push(request);
    return this.answer(request);
  }
}
