import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SessionPausedError } from '../src/errors';
import { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { defineTool, ToolError } from '../src/tools/types';
import { FIXED_NOW, now, startedState } from './helpers';
import { toolHarness } from './tool-harness';

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

  it('checkpoint/rollback restores the working state and truncates emitted events', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'scene_change', location: 'Lab', artPrompt: 'A lab' });
    const checkpoint = recorder.checkpoint();
    recorder.emit({ type: 'scene_change', location: 'Hallway', artPrompt: 'A hallway' });
    expect(recorder.events).toHaveLength(2);
    recorder.rollback(checkpoint);
    expect(recorder.events).toHaveLength(1);
    expect(recorder.state.scene).toEqual({ location: 'Lab', loreEntityId: undefined });
  });
});

describe('atomic tool execution', () => {
  it('rolls back events and state when a tool emits then throws a ToolError', async () => {
    const harness = toolHarness();
    const breaks = defineTool({
      name: 'breaks',
      description: 'test tool that emits then throws',
      parameters: z.object({}),
      run(_args, { recorder }) {
        recorder.emit({ type: 'scene_change', location: 'Nowhere', artPrompt: 'x' });
        throw new ToolError('boom');
      },
    });
    const result = await harness.run(breaks, {});
    expect(result).toEqual({ ok: false, error: 'boom' });
    expect(harness.recorder.events).toHaveLength(0);
    expect(harness.recorder.state.scene).toBeNull();
  });

  it('treats a ZodError from recorder.emit as a tool error and rolls back prior emits', async () => {
    const harness = toolHarness();
    const breaksLate = defineTool({
      name: 'breaks-late',
      description: 'emits a valid event, then an invalid one',
      parameters: z.object({}),
      run(_args, { recorder }) {
        recorder.emit({ type: 'scene_change', location: 'Nowhere', artPrompt: 'x' });
        recorder.emit({
          type: 'state_change',
          entity: 'kira',
          field: 'hp',
          before: 10,
          after: -5,
          cause: 'test',
        });
        return { result: 'unreachable' };
      },
    });
    const result = await harness.run(breaksLate, {});
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
    expect(harness.recorder.state.scene).toBeNull();
  });

  it('rolls back and pauses resumably when a tool throws an unexpected error', async () => {
    const harness = toolHarness();
    const explodes = defineTool({
      name: 'explodes',
      description: 'test tool that emits then throws an error nobody expects',
      parameters: z.object({}),
      run(_args, { recorder }) {
        recorder.emit({ type: 'scene_change', location: 'Nowhere', artPrompt: 'x' });
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(harness.run(explodes, {})).rejects.toThrow(SessionPausedError);
    expect(harness.recorder.events).toHaveLength(0);
    expect(harness.recorder.state.scene).toBeNull();
  });

  it('lets a SessionPausedError propagate unchanged, without rolling back', async () => {
    const harness = toolHarness();
    const pauses = defineTool({
      name: 'pauses',
      description: 'test tool that throws SessionPausedError directly',
      parameters: z.object({}),
      run() {
        throw new SessionPausedError('lore', 'ECONNREFUSED');
      },
    });
    await expect(harness.run(pauses, {})).rejects.toMatchObject({
      seat: 'lore',
      reason: 'ECONNREFUSED',
    });
  });
});

describe('G3.4: roll event schema additions are backward compatible', () => {
  it('parses an old-format roll event with no mode or subject', () => {
    const event = SimEvent.parse({
      seq: 0,
      ts: '2026-09-13T00:00:00.000Z',
      turnId: 'turn',
      visibility: 'public',
      type: 'roll',
      actor: 'kira',
      kind: 'check',
      label: 'Kira Vale Investigation check',
      expr: '1d20+5',
      rolls: [15],
      modifier: 5,
      total: 20,
    });
    expect(event).toMatchObject({ actor: 'kira' });
    expect((event as { mode?: string }).mode).toBeUndefined();
    expect((event as { subject?: string }).subject).toBeUndefined();
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
