import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director';
import { EVENT_SCHEMA_VERSION, SimEvent } from '../src/events';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { respond, ScriptedModelClient, StaticLoreIndex, toolCall } from '../src/testing';
import { kira, now, startedState, tomas } from './helpers';

describe('event log contract', () => {
  it('stamps the schema version on session_start', async () => {
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'abc',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model: new ScriptedModelClient({}),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
        now,
      }
    );
    await director.step();
    expect(sink.events[0]).toMatchObject({ type: 'session_start', schemaVersion: 1 });
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('reads a session_start written before the schema version existed as version 1', () => {
    const { history } = startedState();
    const legacy = { ...history[0]! } as Record<string, unknown>;
    delete legacy.schemaVersion;
    expect(SimEvent.parse(legacy)).toMatchObject({ type: 'session_start', schemaVersion: 1 });
  });

  it('accepts re_prompted as a validator_flag resolution', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    const event = recorder.emit({
      type: 'validator_flag',
      visibility: 'dm',
      seat: 'dm',
      rule: 'invalid_tool_call',
      retries: 0,
      resolution: 're_prompted',
    });
    expect(event).toMatchObject({ resolution: 're_prompted' });
  });
});

describe('model requests', () => {
  it('carry the turn id and require a tool call', async () => {
    const model = new ScriptedModelClient({
      dm: [
        respond(
          toolCall('narrate', { text: 'The lab hums.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    let turn = 0;
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'abc',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model,
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink: new MemorySink(),
        prompts: basicPrompts,
        now,
        newTurnId: () => `turn-${++turn}`,
      }
    );
    await director.step();
    await director.step();
    expect(model.requests[0]).toMatchObject({
      seat: 'dm',
      turnId: 'turn-2',
      toolChoice: 'required',
    });
  });
});

describe('idle hand-offs', () => {
  it('counts consecutive out-of-combat hand-offs nobody could answer and resets on an answer', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: [] });
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: [] });
    expect(recorder.state.idleHandOffs).toBe(2);
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira'] });
    expect(recorder.state.idleHandOffs).toBe(0);
  });
});
