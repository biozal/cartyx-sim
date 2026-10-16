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

  it('accepts trimmed as a validator_flag resolution', () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    const event = recorder.emit({
      type: 'validator_flag',
      visibility: 'dm',
      seat: 'dm',
      rule: 'dm_controls_pc',
      retries: 0,
      resolution: 'trimmed',
    });
    expect(event).toMatchObject({ resolution: 'trimmed' });
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

const base = { seq: 1, ts: '2026-10-07T00:00:00.000Z', turnId: 't1' };
// The real party helper, not a literal: Combatant has required fields a literal would miss.
const party = [kira];

describe('session_start.personas', () => {
  it('is optional, so a log written before personas existed still parses', () => {
    const parsed = SimEvent.safeParse({
      ...base,
      visibility: 'public',
      type: 'session_start',
      session: 1,
      loreCommit: 'abc',
      targetMinutes: 60,
      party,
    });
    expect(parsed.success).toBe(true);
  });

  it('round-trips a persona map keyed by pc id', () => {
    const parsed = SimEvent.parse({
      ...base,
      visibility: 'public',
      type: 'session_start',
      session: 1,
      loreCommit: 'abc',
      targetMinutes: 60,
      party,
      personas: { kira: { motivation: 'Clear her name.', loreEntityIds: ['kanka-1'] } },
    });
    expect(parsed).toMatchObject({ personas: { kira: { motivation: 'Clear her name.' } } });
  });
});

describe('lore_lookup.trigger', () => {
  it('is optional, so sessions 001-014 still parse', () => {
    const parsed = SimEvent.safeParse({
      ...base,
      visibility: 'dm',
      type: 'lore_lookup',
      query: 'q',
      hits: [{ chunkId: 'c1', source: 'dm/a.md', score: 0.8 }],
      used: ['c1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the three triggers and rejects anything else', () => {
    for (const trigger of ['scene', 'party', 'tool']) {
      const parsed = SimEvent.safeParse({
        ...base,
        visibility: 'dm',
        type: 'lore_lookup',
        query: 'q',
        hits: [],
        used: [],
        trigger,
      });
      expect(parsed.success).toBe(true);
    }
    const bad = SimEvent.safeParse({
      ...base,
      visibility: 'dm',
      type: 'lore_lookup',
      query: 'q',
      hits: [],
      used: [],
      trigger: 'guess',
    });
    expect(bad.success).toBe(false);
  });
});

describe('the schema version', () => {
  it('stays 1: both additions are optional, so no log format broke', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
