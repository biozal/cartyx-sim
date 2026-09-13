import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { act, declareSpell, interject, pass, speak } from '../src/tools/player';
import { kira, now, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

function kiraHarness(options: { spoken?: boolean; slotsUsed?: number } = {}) {
  const started = startedState([
    { ...kira, spellSlots: [{ level: 1, max: 2, used: options.slotsUsed ?? 0 }] },
    tomas,
  ]);
  let { state, history } = started;
  if (options.spoken) {
    const recorder = new TurnRecorder(state, 'dm-turn', now);
    recorder.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The door bursts open.',
      emotion: 'excited',
    });
    state = recorder.state;
    history = [...history, ...recorder.events];
  }
  return toolHarness({ state, history, actorId: 'kira' });
}

describe('player tools', () => {
  it('speak emits PC dialogue', async () => {
    const harness = kiraHarness();
    await harness.run(speak, { text: 'Who is there?', emotion: 'afraid' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'dialogue',
      speaker: 'kira',
      speakerKind: 'pc',
      emotion: 'afraid',
    });
  });

  it('act declares an attempt', async () => {
    const harness = kiraHarness();
    await harness.run(act, { intent: 'check the door for traps', targetId: 'door' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'action',
      actor: 'kira',
      target: 'door',
    });
  });

  it('interject overlaps the most recent line from someone else', async () => {
    const harness = kiraHarness({ spoken: true });
    await harness.run(interject, { text: 'Wait—!' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'dialogue',
      overlaps: 1,
      emotion: 'surprised',
    });
  });

  it('interject needs a line to overlap and stays short', async () => {
    expect(await kiraHarness().run(interject, { text: 'Wait!' })).toEqual({
      ok: false,
      error: 'There is no line to interject over yet.',
    });
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    expect(await kiraHarness({ spoken: true }).run(interject, { text: long })).toEqual({
      ok: false,
      error: 'Interjections must be 12 words or fewer.',
    });
  });

  it('declare_spell checks slots but leaves resolution to the DM', async () => {
    const harness = kiraHarness();
    await harness.run(declareSpell, {
      spell: 'Magic Missile',
      slotLevel: 1,
      targetIds: ['sentry-1'],
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'action',
      intent: 'casts Magic Missile at level 1 targeting sentry-1',
    });
    expect(harness.recorder.state.combatants.kira?.spellSlots[0]?.used).toBe(0);
    expect(
      await kiraHarness({ slotsUsed: 2 }).run(declareSpell, { spell: 'Shield', slotLevel: 1 })
    ).toEqual({
      ok: false,
      error: 'You have no level 1 spell slots left (slots: L1 0/2).',
    });
  });

  it('pass emits a pass', async () => {
    const harness = kiraHarness();
    await harness.run(pass);
    expect(harness.recorder.events[0]).toMatchObject({ type: 'pass', actor: 'kira' });
  });
});
