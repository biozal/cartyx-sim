import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig, type DirectorDeps } from '../src/director';
import type { SimEvent } from '../src/events';
import type { LoreHit, LoreIndex } from '../src/model';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { foldEvents, initialState, nextActor } from '../src/state';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, tomas } from './helpers';
import { SELLA_CHUNK } from './tool-harness';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'abc123',
    party: [kira, tomas],
    seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    retryDelaysMs: [],
    ...overrides,
  };
}

function deps(
  script: Record<string, ScriptedResponse[]>,
  options: {
    sink?: MemorySink;
    rolls?: number[];
    turnPrefix?: string;
    sleep?: DirectorDeps['sleep'];
  } = {}
) {
  let turn = 0;
  const model = new ScriptedModelClient(script);
  const sink = options.sink ?? new MemorySink();
  const built: DirectorDeps = {
    model,
    lore: new StaticLoreIndex([SELLA_CHUNK]),
    rng: scriptedRng(options.rolls ?? []),
    sink,
    prompts: basicPrompts,
    now,
    newTurnId: () => `${options.turnPrefix ?? 'turn'}-${++turn}`,
    sleep: options.sleep ?? (async () => {}),
  };
  return { deps: built, model, sink };
}

function lastUserMessage(request: { messages: { role: string; content: string }[] }): string {
  return request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

/** A clock that throws on its Nth call (e.g. simulating a clock/emit failure mid-turn) and works otherwise. */
function flakyNow(failOnCall: number): () => Date {
  let calls = 0;
  return () => {
    calls++;
    if (calls === failOnCall) throw new Error('clock unavailable');
    return now();
  };
}

/** Every turn's events must be contiguous and seqs must count up from 0 without gaps. */
function expectWellFormedLog(events: readonly SimEvent[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index));
  const finished = new Set<string>();
  let current: string | undefined;
  for (const event of events) {
    if (event.turnId !== current) {
      expect(finished.has(event.turnId)).toBe(false);
      if (current) finished.add(current);
      current = event.turnId;
    }
  }
}

describe('Director', () => {
  it('plays a scripted session from start to cliffhanger', async () => {
    const script = {
      dm: [
        respond(
          toolCall('scene_change', {
            location: 'Avalon Artificers Academy — Crystal Engine Lab',
            artPrompt: 'A brass-and-crystal workshop lit by humming engines',
          }),
          toolCall('lookup_lore', { query: 'Sella Vaunt' })
        ),
        respond(
          toolCall('introduce_npc', {
            name: 'Professor Sella Vaunt',
            description: 'Avalon instructor of applied crystal engines',
            invented: false,
            loreEntityId: '2418574',
          }),
          toolCall('npc_say', {
            npcId: 'professor-sella-vaunt',
            text: 'Someone has tampered with engine three. Find out who.',
            emotion: 'angry',
          }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        respond(
          toolCall('request_check', {
            combatantId: 'kira',
            checkType: 'skill',
            skill: 'investigation',
            dc: 13,
            reason: 'spot tool marks',
          })
        ),
        respond(
          toolCall('narrate', { text: 'You find fresh scratches from an Avalon-issue spanner.' }),
          toolCall('start_combat', {
            monsters: [
              {
                name: 'Clockwork Sentry',
                ac: 13,
                maxHp: 11,
                attacks: [{ name: 'Slam', bonus: 4, damage: '1d6+2', damageType: 'bludgeoning' }],
              },
            ],
          })
        ),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
        respond(
          toolCall('attack', {
            attackerId: 'clockwork-sentry-1',
            targetId: 'tomas',
            attackName: 'Slam',
          })
        ),
        respond(
          toolCall('narrate', { text: 'The sentry slams Tomas into the workbench.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        respond(
          toolCall('attack', {
            attackerId: 'kira',
            targetId: 'clockwork-sentry-1',
            attackName: 'Light Hammer',
          })
        ),
        respond(
          toolCall('narrate', { text: 'The sentry collapses in a shower of sparks.' }),
          toolCall('end_combat'),
          toolCall('scene_change', {
            location: "Avalon Artificers Academy — Dean's Office",
            artPrompt: 'A polished office overlooking the artificer barns',
          }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
      'player-kira': [
        respond(
          toolCall('speak', {
            text: 'Engine three? I calibrated it this morning.',
            emotion: 'surprised',
          }),
          toolCall('act', { intent: 'inspect the engine housing for tool marks' })
        ),
        respond(
          toolCall('act', {
            intent: 'strike the sentry with my light hammer',
            targetId: 'clockwork-sentry-1',
          })
        ),
      ],
      'player-tomas': [
        respond(toolCall('speak', { text: 'Kira attacks the engine with her wrench.' })),
        respond(toolCall('speak', { text: 'Careful, Kira.' }), toolCall('pass')),
      ],
    };
    // d20 check 15; initiative kira 12, tomas 5, sentry 18; sentry hits (16) for 4+2; kira crits (20) for 4+4+3.
    const { deps: built, model, sink } = deps(script, { rolls: [15, 12, 5, 18, 16, 4, 20, 4, 4] });
    const director = await Director.create(config({ targetMinutes: 0.25 }), built);

    const result = await director.run();

    expect(result.status).toBe('ended');
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'scene_change',
      'lore_lookup',
      'npc_introduced',
      'dialogue',
      'hand_off',
      'turn_end',
      'dialogue',
      'action',
      'turn_end',
      'dialogue',
      'pass',
      'turn_end',
      'roll',
      'narration',
      'combatant_added',
      'roll',
      'roll',
      'roll',
      'combat_start',
      'hand_off',
      'turn_end',
      'roll',
      'roll',
      'state_change',
      'narration',
      'hand_off',
      'combat_turn',
      'turn_end',
      'action',
      'turn_end',
      'roll',
      'roll',
      'state_change',
      'state_change',
      'narration',
      'combat_end',
      'scene_change',
      'hand_off',
      'turn_end',
      'session_end',
    ]);
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_end', reason: 'target_reached' });
    expectWellFormedLog(sink.events);

    const state = director.currentState;
    expect(state.combatants.tomas?.hp).toBe(6);
    expect(state.combatants['clockwork-sentry-1']).toMatchObject({ hp: 0, dead: true });
    expect(state.combat).toBeNull();
    expect(state.scene?.location).toBe("Avalon Artificers Academy — Dean's Office");
    expect(foldEvents(sink.events)).toEqual(state);
    for (const seat of ['dm', 'player-kira', 'player-tomas']) expect(model.remaining(seat)).toBe(0);

    const kiraFirst = model.requests.find((r) => r.seat === 'player-kira')!;
    expect(lastUserMessage(kiraFirst)).toContain(
      'Professor Sella Vaunt: "Someone has tampered with engine three. Find out who."'
    );
    expect(lastUserMessage(kiraFirst)).not.toContain('[lore]');

    const tomasRetry = model.requests.filter((r) => r.seat === 'player-tomas')[1]!;
    expect(tomasRetry.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Not executed. player_controls_other'),
    });

    const dmRequests = model.requests.filter((r) => r.seat === 'dm');
    expect(lastUserMessage(dmRequests[5]!)).not.toContain('nearing its time limit');
    expect(lastUserMessage(dmRequests[7]!)).toContain('nearing its time limit');
  });

  it('re-prompts the DM after a rejection and forces hand_off at the step limit', async () => {
    const {
      deps: built,
      model,
      sink,
    } = deps({
      dm: [
        respond(toolCall('narrate', { text: 'Kira decides to open the door.' })),
        respond(toolCall('narrate', { text: 'The door creaks.' })),
      ],
    });
    const director = await Director.create(config({ maxDmStepsPerBeat: 2 }), built);
    await director.step();
    await director.step();

    expect(sink.events.slice(1).map((e) => e.type)).toEqual([
      'narration',
      'validator_flag',
      'hand_off',
      'turn_end',
    ]);
    expect(sink.events[1]).toMatchObject({ text: 'The door creaks.' });
    expect(sink.events[2]).toMatchObject({ rule: 'dm_step_limit', resolution: 'forced_hand_off' });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Rejected (dm_controls_pc)'),
    });
  });

  it('treats a text-only DM reply as narration', async () => {
    const { deps: built, sink } = deps({
      dm: [
        { text: 'The engines roar to life.', toolCalls: [] },
        respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })),
      ],
    });
    const director = await Director.create(config(), built);
    await director.step();
    await director.step();
    expect(sink.events.slice(1, 3)).toMatchObject([
      { type: 'narration', text: 'The engines roar to life.' },
      { type: 'hand_off', responders: ['tomas'] },
    ]);
  });

  it('forces a pass after a player keeps breaking the rules', async () => {
    const outcome = respond(toolCall('speak', { text: 'I successfully pick the lock.' }));
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } }))],
      'player-tomas': [outcome, outcome, outcome],
    });
    const director = await Director.create(config(), built);
    await director.run(3);
    expect(sink.events.slice(-3)).toMatchObject([
      {
        type: 'validator_flag',
        rule: 'player_narrates_outcome',
        retries: 2,
        resolution: 'forced_pass',
      },
      { type: 'pass', actor: 'tomas' },
      { type: 'turn_end', actor: 'tomas' },
    ]);
  });

  it('ends at the hard stop even without a scene break', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    const director = await Director.create(config({ targetMinutes: 0.02 }), built);
    expect((await director.run()).status).toBe('ended');
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_end', reason: 'hard_stop' });
  });

  it('pauses when a seat keeps failing and resumes from the log', async () => {
    const sink = new MemorySink();
    const sleeps: number[] = [];
    const first = deps(
      {
        dm: [
          respond(
            toolCall('narrate', { text: 'The lab hums.' }),
            toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
          ),
        ],
        'player-kira': [{ throw: 'connection refused' }, { throw: 'connection refused' }],
      },
      { sink, sleep: async (ms) => void sleeps.push(ms) }
    );
    const paused = await (await Director.create(config({ retryDelaysMs: [5] }), first.deps)).run();

    expect(paused).toMatchObject({
      status: 'paused',
      seat: 'player-kira',
      error: 'connection refused',
    });
    expect(sleeps).toEqual([5]);
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'narration',
      'hand_off',
      'turn_end',
      'ooc_note',
    ]);

    const second = deps(
      {
        'player-kira': [respond(toolCall('speak', { text: 'Sorry, I was daydreaming.' }))],
        dm: [
          respond(
            toolCall('narrate', { text: 'Sella clears her throat.' }),
            toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
          ),
        ],
      },
      { sink, turnPrefix: 'resumed' }
    );
    const resumed = await Director.create(config(), second.deps);
    expect((await resumed.run(2)).status).toBe('turn_limit');

    expect(sink.events.slice(5).map((e) => e.type)).toEqual([
      'ooc_note',
      'dialogue',
      'turn_end',
      'narration',
      'hand_off',
      'turn_end',
    ]);
    expectWellFormedLog(sink.events);
    expect(foldEvents(sink.events)).toEqual(resumed.currentState);
  });

  it('does not crash when the DM targets a built-in property name as an id', async () => {
    const {
      deps: built,
      model,
      sink,
    } = deps({
      dm: [
        respond(
          toolCall('add_condition', {
            targetId: 'constructor',
            condition: 'poisoned',
            reason: 'test',
          })
        ),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
      ],
    });
    const director = await Director.create(config(), built);
    await director.step();
    await expect(director.step()).resolves.toBe('continue');
    expect(sink.events.some((e) => e.type === 'state_change')).toBe(false);
    expect(model.remaining('dm')).toBe(0);
  });

  it('refuses to start without a DM seat or a seat for every party member', async () => {
    const { deps: built } = deps({});
    await expect(
      Director.create(
        config({ seats: { dm: '', players: { kira: 'player-kira', tomas: 'player-tomas' } } }),
        built
      )
    ).rejects.toThrow('No DM seat configured');
    await expect(
      Director.create(config({ seats: { dm: 'dm', players: { kira: 'player-kira' } } }), built)
    ).rejects.toThrow('No player seat configured for "tomas"');
  });

  it('pauses on seat "lore" when the lore index keeps failing, leaving no partial lookup', async () => {
    const sink = new MemorySink();
    const sleeps: number[] = [];
    const lore: LoreIndex = {
      search: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const { deps: built } = deps(
      { dm: [respond(toolCall('lookup_lore', { query: 'Sella Vaunt' }))] },
      { sink, sleep: async (ms) => void sleeps.push(ms) }
    );
    const director = await Director.create(config({ retryDelaysMs: [5] }), { ...built, lore });

    const result = await director.run();

    expect(result).toMatchObject({ status: 'paused', seat: 'lore', error: 'ECONNREFUSED' });
    expect(sleeps).toEqual([5]);
    expect(sink.events.map((e) => e.type)).toEqual(['session_start', 'ooc_note']);
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      visibility: 'dm',
      text: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('retries a failing lore search on the model retry schedule before succeeding', async () => {
    const sink = new MemorySink();
    const sleeps: number[] = [];
    let calls = 0;
    const lore: LoreIndex = {
      async search(): Promise<LoreHit[]> {
        calls++;
        if (calls === 1) throw new Error('ECONNREFUSED');
        return [];
      },
    };
    const { deps: built } = deps(
      {
        dm: [
          respond(
            toolCall('lookup_lore', { query: 'Sella Vaunt' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      { sink, sleep: async (ms) => void sleeps.push(ms) }
    );
    const director = await Director.create(config({ retryDelaysMs: [5] }), { ...built, lore });

    await director.step();
    await director.step();

    expect(sleeps).toEqual([5]);
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'lore_lookup',
      'hand_off',
      'turn_end',
    ]);
  });

  it('pauses with the configured DM seat, not the literal "dm" actor id, on an unexpected tool error', async () => {
    const gmConfig = config({
      seats: { dm: 'game-master', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    });
    const { deps: built, sink } = deps({
      'game-master': [respond(toolCall('narrate', { text: 'The engines hum quietly.' }))],
    });
    const director = await Director.create(gmConfig, { ...built, now: flakyNow(2) });

    const result = await director.run();

    expect(result).toMatchObject({
      status: 'paused',
      seat: 'game-master',
      error: 'clock unavailable',
    });
    expect(sink.events.map((e) => e.type)).toEqual(['session_start', 'ooc_note']);
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      visibility: 'dm',
      text: expect.stringContaining('game-master'),
    });
  });

  it('pauses with the configured player seat, not the bare PC id, on an unexpected tool error', async () => {
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
      'player-kira': [respond(toolCall('speak', { text: 'Hello?' }))],
    });
    const director = await Director.create(config(), { ...built, now: flakyNow(4) });

    const result = await director.run();

    expect(result).toMatchObject({
      status: 'paused',
      seat: 'player-kira',
      error: 'clock unavailable',
    });
    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'hand_off',
      'turn_end',
      'ooc_note',
    ]);
    expect(sink.events.at(-1)).toMatchObject({
      type: 'ooc_note',
      visibility: 'dm',
      text: expect.stringContaining('player-kira'),
    });
  });

  it('refuses to resume a finished session or a different session number', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    await (await Director.create(config({ targetMinutes: 0.02 }), built)).run();
    await expect(Director.create(config(), { ...built, sink })).rejects.toThrow(
      'Session 1 has already ended'
    );

    const other = new MemorySink();
    await other.append(sink.events.slice(0, 1));
    await expect(
      Director.create(config({ session: 2 }), { ...built, sink: other })
    ).rejects.toThrow('Event log belongs to session 1, not session 2');
  });

  const monsterSpec = (name: string) => ({
    name,
    ac: 10,
    maxHp: 5,
    attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
  });

  it("G2.1: keeps the new fight's own initiative when combat ends and restarts in one beat", async () => {
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('start_combat', { monsters: [monsterSpec('Goblin')] }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
          respond(
            toolCall('end_combat'),
            toolCall('start_combat', { monsters: [monsterSpec('Orc')] }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
        'player-kira': [respond(toolCall('act', { intent: 'size up the goblin' }))],
      },
      // initiative 1: kira 22, tomas 16, goblin 2 (kira acts, hands to DM to resolve)
      // initiative 2: kira 4, tomas 4, orc 20 -> orc, kira, tomas
      { rolls: [20, 15, 2, 2, 3, 20] }
    );
    const director = await Director.create(config(), built);

    await director.run(4);

    const state = director.currentState;
    expect(state.combat).not.toBeNull();
    expect(state.combat!.turnIndex).toBe(0);
    expect(state.combat!.order[0]).toMatchObject({ combatantId: 'orc-1' });
    expect(nextActor(state)).toMatchObject({
      kind: 'dm',
      reason: 'monster',
      combatantId: 'orc-1',
    });
    expect(foldEvents(sink.events)).toEqual(state);
  });

  it('G2.2: skips a PC downed in the same beat that started combat', async () => {
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('start_combat', { monsters: [monsterSpec('Goblin')] }),
            toolCall('apply_damage', {
              targetId: 'kira',
              amount: 10,
              damageType: 'fire',
              reason: 'a collapsing rafter',
            }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      // initiative: kira 22, tomas 2, goblin 1 -> kira first, then dropped to 0 hp in the same beat
      { rolls: [20, 1, 1] }
    );
    const director = await Director.create(config(), built);

    await director.run(2);

    const state = director.currentState;
    expect(state.combatants.kira).toMatchObject({ hp: 0 });
    expect(state.combat!.order[0]).toMatchObject({ combatantId: 'kira' });
    expect(state.combat!.turnIndex).toBe(1);
    expect(nextActor(state)).toMatchObject({
      kind: 'pc',
      pcId: 'tomas',
      reason: 'combat_turn',
    });
    expect(foldEvents(sink.events)).toEqual(state);
  });

  it('G2.2: skips the first monster when it is killed in the same beat that started combat', async () => {
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('start_combat', { monsters: [monsterSpec('Goblin')] }),
            toolCall('apply_damage', {
              targetId: 'goblin-1',
              amount: 5,
              damageType: 'fire',
              reason: 'a collapsing rafter',
            }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      // initiative: goblin 20, kira 3, tomas 2 -> goblin first, then killed in the same beat
      { rolls: [1, 1, 20] }
    );
    const director = await Director.create(config(), built);

    await director.run(2);

    const state = director.currentState;
    expect(state.combatants['goblin-1']).toMatchObject({ hp: 0, dead: true });
    expect(state.combat!.order[0]).toMatchObject({ combatantId: 'goblin-1' });
    expect(nextActor(state)).toMatchObject({ kind: 'pc', pcId: 'kira', reason: 'combat_turn' });
    expect(nextActor(state)).not.toMatchObject({ reason: 'monster', combatantId: 'goblin-1' });
    expect(foldEvents(sink.events)).toEqual(state);
  });

  it('G2.3: resume uses the logged targetMinutes and flags a configured override as ignored', async () => {
    const sink = new MemorySink();
    const first = deps(
      {
        dm: [
          respond(
            toolCall('narrate', { text: 'The engines roar to life all around you.' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      { sink }
    );
    await (await Director.create(config({ targetMinutes: 60 }), first.deps)).run(2);

    const second = deps(
      { 'player-kira': [respond(toolCall('speak', { text: 'Steady, everyone.' }))] },
      { sink, turnPrefix: 'resumed' }
    );
    const director = await Director.create(config({ targetMinutes: 0.01 }), second.deps);
    const result = await director.run(1);

    expect(result.status).not.toBe('ended');
    expect(director.currentState.targetMinutes).toBe(60);
    const override = sink.events.find(
      (e) => e.type === 'ooc_note' && e.text.includes('targetMinutes')
    );
    expect(override).toMatchObject({
      type: 'ooc_note',
      visibility: 'dm',
      text: expect.stringContaining('0.01'),
    });
    expect(override).toMatchObject({ text: expect.stringContaining('60') });
  });

  it('G2.3: does not flag anything when the configured targetMinutes matches the log', async () => {
    const sink = new MemorySink();
    const first = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    await (await Director.create(config(), { ...first.deps, sink })).run(2);
    const second = deps({}, { sink, turnPrefix: 'resumed' });
    await Director.create(config(), { ...second.deps, sink });
    expect(sink.events.filter((e) => e.type === 'ooc_note')).toEqual([
      {
        seq: 4,
        ts: expect.any(String),
        turnId: 'resumed-1',
        visibility: 'dm',
        type: 'ooc_note',
        text: 'Session resumed.',
      },
    ]);
  });

  it('G2.3: rejects resuming with a different lore commit', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'The engines roar to life all around you.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
    });
    await (await Director.create(config(), built)).run(1);
    await expect(
      Director.create(config({ loreCommit: 'a-different-commit' }), { ...built, sink })
    ).rejects.toThrow(/lore commit/i);
  });

  it('G2.4: ends at the hard stop on resume before choosing an actor, granting no extra turn', async () => {
    const recorder = new TurnRecorder(initialState(), 'setup', now);
    recorder.emit({
      type: 'session_start',
      session: 1,
      loreCommit: 'abc123',
      targetMinutes: 0.02,
      party: [kira, tomas],
    });
    recorder.emit({
      type: 'narration',
      speaker: 'dm',
      text: 'The engines roar to life all around you now.',
      emotion: 'neutral',
    });
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira', 'tomas'] });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    const sink = new MemorySink();
    await sink.append(recorder.events);

    const { deps: built, model } = deps({}, { sink });
    const director = await Director.create(config({ targetMinutes: 0.02 }), built);

    const result = await director.run();

    expect(result.status).toBe('ended');
    expect(model.requests.length).toBe(0);
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_end', reason: 'hard_stop' });
    expect(foldEvents(sink.events)).toEqual(director.currentState);
  });
});
