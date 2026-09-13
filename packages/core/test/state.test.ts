import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import {
  advanceCombat,
  applyEvent,
  foldEvents,
  initialState,
  nextActor,
  selectResponders,
} from '../src/state';
import { kira, now, startedState, tomas } from './helpers';

function recorderAfterStart() {
  const { state } = startedState();
  return new TurnRecorder(state, 'turn', now);
}

const sentry = makeCombatant({ id: 'sentry-1', name: 'Sentry', kind: 'monster', hp: 5, maxHp: 5 });

describe('applyEvent', () => {
  it('rejects events that are not after the last seq', () => {
    const { state, history } = startedState();
    expect(() => applyEvent(state, history[0]!)).toThrow('is not after last seq 0');
  });

  it('does not mutate the previous state', () => {
    const recorder = recorderAfterStart();
    const before = recorder.state;
    recorder.emit({ type: 'narration', speaker: 'dm', text: 'Hello there.', emotion: 'neutral' });
    expect(before.spokenWords).toBe(0);
    expect(recorder.state.spokenWords).toBe(2);
  });

  it('loads the party on session_start and waits for the DM', () => {
    const { state } = startedState();
    expect(state.session).toBe(1);
    expect(state.partyIds).toEqual(['kira', 'tomas']);
    expect(state.combatants.kira).toEqual(kira);
    expect(nextActor(state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('counts spoken words per speaker and tracks silent turns', () => {
    const recorder = recorderAfterStart();
    recorder.emit({
      type: 'dialogue',
      speaker: 'kira',
      speakerKind: 'pc',
      text: 'One two three',
      emotion: 'neutral',
    });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    recorder.emit({ type: 'turn_end', actor: 'tomas' });
    expect(recorder.state.wordsBySpeaker).toEqual({ kira: 3 });
    expect(recorder.state.spokenWords).toBe(3);
    expect(recorder.state.silentTurns).toBe(1);
    expect(recorder.state.turnWords).toBe(0);
  });

  it('counts stalled turns for turns with no progress, and resets on progress', () => {
    const recorder = recorderAfterStart();
    // hand_off and pass are bookkeeping, not progress: this turn is stalled.
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira'] });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    expect(recorder.state.stalledTurns).toBe(1);
    recorder.emit({ type: 'pass', actor: 'kira' });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    expect(recorder.state.stalledTurns).toBe(2);

    // A state_change is progress even with no spoken words, so the next turn resets the count.
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'hp',
      before: 10,
      after: 8,
      cause: 'test',
    });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    expect(recorder.state.stalledTurns).toBe(0);
  });

  it('resets every backstop counter on session_paused', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: [] });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    expect(recorder.state.stalledTurns).toBe(1);
    expect(recorder.state.silentTurns).toBe(1);
    expect(recorder.state.idleHandOffs).toBe(1);
    recorder.emit({
      type: 'session_paused',
      visibility: 'dm',
      seat: 'dm',
      reason: 'stuck',
      kind: 'backstop',
    });
    expect(recorder.state.stalledTurns).toBe(0);
    expect(recorder.state.silentTurns).toBe(0);
    expect(recorder.state.idleHandOffs).toBe(0);
  });

  it('queues hand-off responders and removes them as they finish', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira', 'tomas'] });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'response' });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'tomas', reason: 'response' });
    recorder.emit({ type: 'turn_end', actor: 'tomas' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('applies state changes and validates the result', () => {
    const recorder = recorderAfterStart();
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'hp',
      before: 10,
      after: 4,
      cause: 'test',
    });
    expect(recorder.state.combatants.kira?.hp).toBe(4);
    expect(() =>
      recorder.emit({
        type: 'state_change',
        entity: 'kira',
        field: 'hp',
        before: 4,
        after: -1,
        cause: 'test',
      })
    ).toThrow();
    expect(() =>
      recorder.emit({
        type: 'state_change',
        entity: 'ghost',
        field: 'hp',
        before: 1,
        after: 0,
        cause: 'test',
      })
    ).toThrow('unknown combatant "ghost"');
  });

  it('runs the combat turn cycle', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'combatant_added', combatant: sentry });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'sentry-1', roll: 18, dexMod: 0, total: 18 },
        { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
      ],
    });
    expect(nextActor(recorder.state)).toEqual({
      kind: 'dm',
      reason: 'monster',
      combatantId: 'sentry-1',
    });
    recorder.emit({ type: 'combat_turn', round: 1, turnIndex: 1, combatantId: 'kira' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'combat_turn' });
    recorder.emit({ type: 'turn_end', actor: 'kira' });
    expect(nextActor(recorder.state)).toEqual({
      kind: 'dm',
      reason: 'resolve',
      combatantId: 'kira',
    });
    recorder.emit({ type: 'combat_end' });
    expect(recorder.state.combat).toBeNull();
    expect(nextActor(recorder.state)).toEqual({ kind: 'dm', reason: 'beat' });
  });

  it('reports the end of the session', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'session_end', reason: 'manual' });
    expect(nextActor(recorder.state)).toEqual({ kind: 'ended' });
  });
});

describe('foldEvents', () => {
  it('matches applying events one at a time', () => {
    const recorder = recorderAfterStart();
    recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    const { history } = startedState();
    const all = [...history, ...recorder.events].map((event) => SimEvent.parse(event));
    expect(foldEvents(all)).toEqual(recorder.state);
    expect(foldEvents([])).toEqual(initialState());
  });
});

describe('advanceCombat', () => {
  function combatState(hp: { kira: number; tomas: number; sentry: number }, turnIndex: number) {
    const { state } = startedState([
      { ...kira, hp: hp.kira },
      { ...tomas, hp: hp.tomas },
    ]);
    return {
      ...state,
      combatants: { ...state.combatants, 'sentry-1': { ...sentry, hp: hp.sentry } },
      combat: {
        order: [
          { combatantId: 'sentry-1', roll: 1, dexMod: 0, total: 20 },
          { combatantId: 'kira', roll: 1, dexMod: 0, total: 15 },
          { combatantId: 'tomas', roll: 1, dexMod: 0, total: 10 },
        ],
        round: 1,
        turnIndex,
        declared: true,
      },
    };
  }

  it('moves to the next combatant who can act', () => {
    expect(advanceCombat(combatState({ kira: 0, tomas: 12, sentry: 5 }, 0))).toEqual({
      round: 1,
      turnIndex: 2,
      combatantId: 'tomas',
    });
  });

  it('wraps into the next round', () => {
    expect(advanceCombat(combatState({ kira: 10, tomas: 12, sentry: 5 }, 2))).toEqual({
      round: 2,
      turnIndex: 0,
      combatantId: 'sentry-1',
    });
  });

  it('returns null when nobody can act', () => {
    expect(advanceCombat(combatState({ kira: 0, tomas: 0, sentry: 0 }, 0))).toBeNull();
  });

  it('with inclusive, returns the current combatant when they can still act', () => {
    expect(
      advanceCombat(combatState({ kira: 10, tomas: 12, sentry: 5 }, 1), { inclusive: true })
    ).toEqual({ round: 1, turnIndex: 1, combatantId: 'kira' });
  });

  it('with inclusive, searches forward from the current index when they cannot', () => {
    expect(
      advanceCombat(combatState({ kira: 0, tomas: 12, sentry: 5 }, 1), { inclusive: true })
    ).toEqual({ round: 1, turnIndex: 2, combatantId: 'tomas' });
  });

  it('with inclusive, wraps into the next round when nobody from the current index onward can act', () => {
    expect(
      advanceCombat(combatState({ kira: 10, tomas: 0, sentry: 0 }, 2), { inclusive: true })
    ).toEqual({ round: 2, turnIndex: 1, combatantId: 'kira' });
  });

  it('with inclusive, returns null when nobody can act', () => {
    expect(
      advanceCombat(combatState({ kira: 0, tomas: 0, sentry: 0 }, 0), { inclusive: true })
    ).toBeNull();
  });
});

describe('selectResponders', () => {
  const { state } = startedState();
  const chatty = { ...state, wordsBySpeaker: { kira: 40, tomas: 3 } };

  it('keeps named PCs who can act, in the order given', () => {
    const downed = { ...chatty, combatants: { ...chatty.combatants, tomas: { ...tomas, hp: 0 } } };
    expect(selectResponders({ kind: 'pcs', ids: ['tomas', 'kira'] }, downed)).toEqual(['kira']);
  });

  it('orders the whole party quietest first', () => {
    expect(selectResponders({ kind: 'party' }, chatty)).toEqual(['tomas', 'kira']);
  });

  it('gives the open floor to the two quietest players', () => {
    const three = startedState([kira, tomas, makeCombatant({ id: 'oona' })]).state;
    const counts = { ...three, wordsBySpeaker: { kira: 40, tomas: 3, oona: 10 } };
    expect(selectResponders({ kind: 'open' }, counts)).toEqual(['tomas', 'oona']);
  });

  it('returns nobody during combat', () => {
    const fighting = { ...chatty, combat: { order: [], round: 1, turnIndex: 0, declared: false } };
    expect(selectResponders({ kind: 'party' }, fighting)).toEqual([]);
  });
});
