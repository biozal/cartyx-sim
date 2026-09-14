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

  it('speak removes quote marks wrapped around the whole line', async () => {
    const harness = kiraHarness();
    await harness.run(speak, { text: '"Keep an eye on that old man, Tomas."' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'dialogue',
      text: 'Keep an eye on that old man, Tomas.',
    });
  });

  it('speak keeps quote marks that are only part of the line', async () => {
    const harness = kiraHarness();
    const line = '"One word, then." (I wait a beat.) "...Which?"';
    await harness.run(speak, { text: line });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'dialogue', text: line });
  });

  it('speak rejects a line with nothing inside its quotes', async () => {
    const harness = kiraHarness();
    expect(await harness.run(speak, { text: '"   "' })).toMatchObject({ ok: false });
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('interject removes quote marks wrapped around the whole line', async () => {
    const harness = kiraHarness({ spoken: true });
    await harness.run(interject, { text: '“Wait—!”' });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'dialogue', text: 'Wait—!' });
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

  it("G5.13: interject skips the actor's own most recent line and overlaps an earlier line by someone else", async () => {
    const started = startedState([kira, tomas]);
    const recorder = new TurnRecorder(started.state, 'dm-turn', now);
    recorder.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The door bursts open.',
      emotion: 'excited',
    });
    recorder.emit({
      type: 'dialogue',
      speaker: 'kira',
      speakerKind: 'pc',
      text: 'Finally!',
      emotion: 'excited',
    });
    const history = [...started.history, ...recorder.events];
    const harness = toolHarness({ state: recorder.state, history, actorId: 'kira' });

    await harness.run(interject, { text: 'Wait—!' });

    expect(harness.recorder.events[0]).toMatchObject({ type: 'dialogue', overlaps: 1 });
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

describe('argument length limits', () => {
  it('rejects speak text over 4000 characters', async () => {
    const harness = kiraHarness();
    const result = await harness.run(speak, { text: 'a'.repeat(4001) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects act intent over 2000 characters', async () => {
    const harness = kiraHarness();
    const result = await harness.run(act, { intent: 'a'.repeat(2001) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects a declared spell name over 200 characters', async () => {
    const harness = kiraHarness();
    const result = await harness.run(declareSpell, { spell: 'a'.repeat(201), slotLevel: 0 });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an interjection with a single 4001-character token, emitting nothing', async () => {
    const harness = kiraHarness({ spoken: true });
    const result = await harness.run(interject, { text: 'a'.repeat(4001) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });
});
