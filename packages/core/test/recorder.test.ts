import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { FIXED_NOW, now, startedState } from './helpers';

describe('TurnRecorder', () => {
  it('stamps seq, time, turn id, and default visibility', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn-7', now);
    const event = recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    expect(event).toMatchObject({
      seq: 1,
      ts: FIXED_NOW.toISOString(),
      turnId: 'turn-7',
      visibility: 'public',
    });
    expect(recorder.emit({ type: 'ooc_note', visibility: 'dm', text: 'note' }).seq).toBe(2);
    expect(recorder.events).toHaveLength(2);
  });

  it('applies each event to its working state', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    expect(recorder.state.scene).toEqual({ location: 'Lab', loreEntityId: undefined });
    expect(state.scene).toBeNull();
  });

  it('rejects invalid events without recording them', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    expect(() =>
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: '',
        emotion: 'neutral',
      })
    ).toThrow();
    expect(recorder.events).toHaveLength(0);
    expect(recorder.state).toBe(state);
  });
});

describe('MemorySink', () => {
  it('appends and returns copies of its events', async () => {
    const sink = new MemorySink();
    const { history } = startedState();
    await sink.append(history);
    const read = await sink.readAll();
    read.pop();
    expect(await sink.readAll()).toHaveLength(1);
  });
});
