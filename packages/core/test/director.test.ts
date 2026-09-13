import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
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
            npcId: 'npc-professor-sella-vaunt',
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

  describe('F5: malformed model responses', () => {
    const malformed = (value: unknown) => value as ScriptedResponse;

    it('normalizes a response with no text through the schema defaults', async () => {
      const {
        deps: built,
        model,
        sink,
      } = deps({
        dm: [
          malformed({ toolCalls: [] }),
          malformed({ toolCalls: [toolCall('hand_off', { target: { kind: 'party' } })] }),
        ],
      });
      const director = await Director.create(config(), built);

      await director.run(2);

      expect(sink.events.map((e) => e.type)).toEqual(['session_start', 'hand_off', 'turn_end']);
      const secondRequest = model.requests.filter((r) => r.seat === 'dm')[1]!;
      expect(secondRequest.messages).toContainEqual({
        role: 'assistant',
        content: '',
        toolCalls: [],
      });
    });

    it('retries a response whose toolCalls is null, then continues when a valid one arrives', async () => {
      const sleeps: number[] = [];
      const { deps: built, sink } = deps(
        {
          dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
          'player-kira': [
            malformed({ text: 'x', toolCalls: null }),
            respond(toolCall('speak', { text: 'Ready.' })),
          ],
        },
        { sleep: async (ms) => void sleeps.push(ms) }
      );
      const director = await Director.create(config({ retryDelaysMs: [5] }), built);

      await director.run(3);

      expect(sleeps).toEqual([5]);
      expect(sink.events.filter((e) => e.type === 'dialogue')).toMatchObject([
        { speaker: 'kira', text: 'Ready.' },
      ]);
    });

    it('pauses on the seat that keeps returning a malformed response, leaving no partial turn', async () => {
      const sleeps: number[] = [];
      const bad = malformed({ text: 'x', toolCalls: null });
      const { deps: built, sink } = deps(
        {
          dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
          'player-kira': [bad, bad],
        },
        { sleep: async (ms) => void sleeps.push(ms) }
      );
      const director = await Director.create(config({ retryDelaysMs: [5] }), built);

      const result = await director.run(3);

      expect(result).toMatchObject({
        status: 'paused',
        seat: 'player-kira',
        error: expect.stringContaining('toolCalls'),
      });
      expect(sleeps).toEqual([5]);
      expect(sink.events.map((e) => e.type)).toEqual([
        'session_start',
        'hand_off',
        'turn_end',
        'ooc_note',
      ]);
      expect(foldEvents(sink.events)).toEqual(director.currentState);
    });
  });

  it.each(['dm', 'npc-ghost'])(
    'F7: refuses a party member whose id "%s" is reserved for the DM or NPCs',
    async (id) => {
      const reserved = makeCombatant({ id, name: 'Reserved Name' });
      const { deps: built, sink } = deps({});
      await expect(
        Director.create(
          config({
            party: [reserved, kira],
            seats: { dm: 'dm', players: { [id]: 'player-reserved', kira: 'player-kira' } },
          }),
          built
        )
      ).rejects.toThrow(`Party member id "${id}" is reserved`);
      expect(sink.events).toHaveLength(0);
    }
  );

  describe('F4: resuming with a changed party', () => {
    async function startedSink(): Promise<MemorySink> {
      const sink = new MemorySink();
      const { deps: built } = deps({}, { sink });
      await (await Director.create(config(), built)).step();
      expect(sink.events.map((e) => e.type)).toEqual(['session_start']);
      return sink;
    }

    it('refuses to resume when a logged PC has no configured seat, naming the PC', async () => {
      const sink = await startedSink();
      const { deps: built } = deps({}, { sink, turnPrefix: 'resumed' });
      await expect(
        Director.create(
          config({ party: [kira], seats: { dm: 'dm', players: { kira: 'player-kira' } } }),
          built
        )
      ).rejects.toThrow('No player seat configured for "tomas"');
      expect(sink.events).toHaveLength(1);
    });

    it('refuses to resume when the configured party differs from the logged party', async () => {
      const sink = await startedSink();
      const { deps: built } = deps({}, { sink, turnPrefix: 'resumed' });
      await expect(Director.create(config({ party: [kira] }), built)).rejects.toThrow(
        /started with party "kira, tomas", but the configured party is "kira"/
      );
      expect(sink.events).toHaveLength(1);
    });

    it('still resumes when the configured party lists the logged PCs in a different order', async () => {
      const sink = await startedSink();
      const { deps: built } = deps({}, { sink, turnPrefix: 'resumed' });
      await expect(
        Director.create(config({ party: [tomas, kira] }), built)
      ).resolves.toBeInstanceOf(Director);
    });
  });

  it('G4.4: re-prompts a player after a tool execution error instead of forcing a pass', async () => {
    const {
      deps: built,
      model,
      sink,
    } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
      'player-kira': [
        respond(toolCall('declare_spell', { spell: 'Fireball', slotLevel: 2 })),
        respond(toolCall('speak', { text: 'Never mind.' })),
      ],
    });
    const director = await Director.create(config(), built);

    await director.run(3);

    expect(sink.events.filter((e) => e.type === 'dialogue')).toHaveLength(1);
    expect(sink.events.filter((e) => e.type === 'validator_flag')).toHaveLength(0);
    expect(sink.events.some((e) => e.type === 'action')).toBe(false);
    const kiraRequests = model.requests.filter((r) => r.seat === 'player-kira');
    expect(kiraRequests).toHaveLength(2);
    expect(kiraRequests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('no level 2 spell slots'),
    });
  });

  it('G4.4: rolls back an attempt entirely when one of its calls fails, leaving no partial events, and forces a pass once retries are exhausted', async () => {
    const retryAttempt = respond(
      toolCall('speak', { text: 'I try again.' }),
      toolCall('declare_spell', { spell: 'Fireball', slotLevel: 2 })
    );
    const finalAttempt = respond(toolCall('declare_spell', { spell: 'Fireball', slotLevel: 2 }));
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
      'player-kira': [retryAttempt, retryAttempt, finalAttempt],
    });
    const director = await Director.create(config(), built);

    await director.run(3);

    expect(sink.events.filter((e) => e.type === 'dialogue')).toHaveLength(0);
    expect(sink.events.slice(-3)).toMatchObject([
      { type: 'validator_flag', rule: 'tool_error', retries: 2, resolution: 'forced_pass' },
      { type: 'pass', actor: 'kira' },
      { type: 'turn_end', actor: 'kira' },
    ]);
  });

  it('G5.6: emits an accepted-with-flag validator flag before the narration once DM rejections are exhausted', async () => {
    const violatingText = 'Kira decides to open the door.';
    const { deps: built, sink } = deps({
      dm: [
        respond(toolCall('narrate', { text: violatingText })),
        respond(toolCall('narrate', { text: violatingText })),
        respond(toolCall('narrate', { text: violatingText })),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
      ],
    });
    const director = await Director.create(config(), built);

    await director.run(2);

    expect(sink.events.slice(1).map((e) => e.type)).toEqual([
      'validator_flag',
      'narration',
      'hand_off',
      'turn_end',
    ]);
    expect(sink.events[1]).toMatchObject({
      type: 'validator_flag',
      visibility: 'dm',
      rule: 'dm_controls_pc',
      retries: 2,
      resolution: 'accepted_with_flag',
    });
    expect(sink.events[2]).toMatchObject({ type: 'narration', text: violatingText });
  });

  it('G5.8: skips remaining calls in a response after a rejection, without ending the beat', async () => {
    const {
      deps: built,
      sink,
      model,
    } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'Kira decides to open the door.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
      ],
    });
    const director = await Director.create(config(), built);

    await director.run(2);

    expect(sink.events.filter((e) => e.type === 'hand_off')).toHaveLength(1);
    expect(model.requests.filter((r) => r.seat === 'dm')).toHaveLength(2);
  });

  it('G5.11: the watchdog nudges the DM with a Watchdog: note when players keep passing', async () => {
    const { deps: built, sink } = deps({
      dm: [
        respond(
          toolCall('narrate', { text: 'A hush falls.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
        // Silent (no narration): a re-hand-off with no narration, once both players have
        // already passed, is what pushes silentTurns past the limit.
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
        respond(
          toolCall('narrate', { text: 'The room stirs.' }),
          toolCall('hand_off', { target: { kind: 'party' } })
        ),
      ],
      'player-kira': [respond(toolCall('pass'))],
      'player-tomas': [respond(toolCall('pass'))],
    });
    const director = await Director.create(config({ silentTurnLimit: 2 }), built);

    await director.run(6);

    const watchdogIndex = sink.events.findIndex(
      (e) => e.type === 'ooc_note' && e.text.startsWith('Watchdog:')
    );
    expect(watchdogIndex).toBeGreaterThan(-1);
    expect(sink.events[watchdogIndex]).toMatchObject({ visibility: 'dm' });
    expect(sink.events[watchdogIndex + 1]).toMatchObject({
      type: 'narration',
      text: 'The room stirs.',
    });
  });

  it('G5.11: the watchdog never fires during combat even once the silent-turn threshold is met', async () => {
    const soloConfig = config({
      party: [kira],
      seats: { dm: 'dm', players: { kira: 'player-kira' } },
      silentTurnLimit: 1,
    });
    const { deps: built, sink } = deps(
      {
        dm: [
          // Narrated, so this beat does not itself count as a silent turn.
          respond(
            toolCall('narrate', { text: 'The corridor is still.' }),
            toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
          ),
          // Silent: starting combat with no narration pushes silentTurns to (and past) the
          // limit, but this is a DM beat, not a PC turn, so it cannot itself be preempted.
          respond(
            toolCall('start_combat', { monsters: [monsterSpec('Goblin')] }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
        'player-kira': [respond(toolCall('pass')), respond(toolCall('pass'))],
      },
      // initiative: kira 20+2=22, goblin 1+0=1 -> kira acts first in combat.
      { rolls: [20, 1] }
    );
    const director = await Director.create(soloConfig, built);

    await director.run(5);

    expect(sink.events.some((e) => e.type === 'ooc_note' && e.text.startsWith('Watchdog:'))).toBe(
      false
    );
  });

  it('G5.12: the DM prompt transcript includes lore lines from earlier in the session', async () => {
    const { deps: built, model } = deps({
      dm: [
        respond(
          toolCall('lookup_lore', { query: 'Sella Vaunt' }),
          toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
        ),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
      ],
      'player-kira': [respond(toolCall('pass'))],
    });
    const director = await Director.create(config(), built);

    await director.run(4);

    const dmRequests = model.requests.filter((r) => r.seat === 'dm');
    expect(lastUserMessage(dmRequests[1]!)).toContain('[lore]');
  });

  it('G5.12: combat_turn events are public', async () => {
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('start_combat', { monsters: [monsterSpec('Goblin')] }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
          respond(
            toolCall('narrate', { text: 'Kira swings.' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
        'player-kira': [respond(toolCall('act', { intent: 'swing wildly' }))],
      },
      // initiative: kira 20+2=22, tomas 15+1=16, goblin 1+0=1 -> kira, tomas, goblin.
      { rolls: [20, 15, 1] }
    );
    const director = await Director.create(config(), built);

    await director.run(4);

    const combatTurn = sink.events.find((e) => e.type === 'combat_turn');
    expect(combatTurn).toMatchObject({ visibility: 'public' });
  });

  it('G5.12: a player validator_flag event is DM-only', async () => {
    const outcome = respond(toolCall('speak', { text: 'I successfully pick the lock.' }));
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } }))],
      'player-tomas': [outcome, outcome, outcome],
    });
    const director = await Director.create(config(), built);

    await director.run(3);

    const flag = sink.events.find((e) => e.type === 'validator_flag' && e.seat === 'player-tomas');
    expect(flag).toMatchObject({ visibility: 'dm' });
  });

  it('G5.10: emits combat_end when a monster beat leaves nobody able to act', async () => {
    const soloConfig = config({
      party: [kira],
      seats: { dm: 'dm', players: { kira: 'player-kira' } },
    });
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('start_combat', {
              monsters: [
                {
                  name: 'Goblin',
                  ac: 10,
                  maxHp: 5,
                  attacks: [
                    { name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' },
                  ],
                },
              ],
            }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
          respond(
            toolCall('apply_damage', {
              targetId: 'kira',
              amount: 10,
              damageType: 'fire',
              reason: 'a shared blast',
            }),
            toolCall('apply_damage', {
              targetId: 'goblin-1',
              amount: 10,
              damageType: 'fire',
              reason: 'a shared blast',
            }),
            toolCall('narrate', { text: 'A shared blast levels everyone.' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      // initiative: kira 1+2=3, goblin 20+0=20 -> goblin acts first (a monster beat).
      { rolls: [1, 20] }
    );
    const director = await Director.create(soloConfig, built);

    await director.run(3);

    expect(sink.events.some((e) => e.type === 'combat_end')).toBe(true);
    expect(director.currentState.combat).toBeNull();
  });

  it('G5.9: does not reject mechanics narration after a mechanics tool ran earlier in the same beat', async () => {
    const { deps: built, sink } = deps(
      {
        dm: [
          respond(
            toolCall('request_check', {
              combatantId: 'kira',
              checkType: 'ability',
              ability: 'str',
              dc: 10,
              reason: 'shove',
            }),
            toolCall('narrate', { text: 'The blow lands for 7 damage.' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      { rolls: [10] }
    );
    const director = await Director.create(config(), built);

    await director.run(2);

    expect(sink.events.some((e) => e.type === 'validator_flag')).toBe(false);
    expect(sink.events.some((e) => e.type === 'narration' && e.text.includes('7 damage'))).toBe(
      true
    );
  });

  it('G5.6: the DM rejection counter tracks a configured maxValidatorRetries', async () => {
    const violatingText = 'Kira decides to open the door.';
    const { deps: built, sink } = deps({
      dm: [
        respond(toolCall('narrate', { text: violatingText })),
        respond(toolCall('narrate', { text: violatingText })),
        respond(toolCall('hand_off', { target: { kind: 'party' } })),
      ],
    });
    const director = await Director.create(config({ maxValidatorRetries: 1 }), built);

    await director.run(2);

    expect(sink.events[1]).toMatchObject({
      type: 'validator_flag',
      rule: 'dm_controls_pc',
      retries: 1,
      resolution: 'accepted_with_flag',
    });
  });

  it('G5.7: keeps a dialogue and flags accepted-with-flag when a valid call and an invalid call share the final attempt', async () => {
    const attempt = respond(
      toolCall('speak', { text: 'I hold the line.' }),
      toolCall('unknown_tool', {})
    );
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } }))],
      'player-tomas': [attempt, attempt, attempt],
    });
    const director = await Director.create(config(), built);

    await director.run(3);

    expect(sink.events.slice(-3)).toMatchObject([
      { type: 'dialogue', text: 'I hold the line.' },
      {
        type: 'validator_flag',
        rule: 'invalid_tool_call',
        retries: 2,
        resolution: 'accepted_with_flag',
      },
      { type: 'turn_end', actor: 'tomas' },
    ]);
  });

  it('G5.7: a text-only player reply becomes a dialogue event', async () => {
    const { deps: built, sink } = deps({
      dm: [respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } }))],
      'player-kira': [{ text: 'Steady, everyone.', toolCalls: [] }],
    });
    const director = await Director.create(config(), built);

    await director.run(3);

    expect(sink.events.filter((e) => e.type === 'dialogue')).toMatchObject([
      { speaker: 'kira', text: 'Steady, everyone.' },
    ]);
    expect(sink.events.some((e) => e.type === 'validator_flag')).toBe(false);
  });

  it('G5.2: commit waits for the sink and never advances state after a failed append', async () => {
    const sink = new MemorySink();
    const realAppend = sink.append.bind(sink);
    let calls = 0;
    sink.append = async (events) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return realAppend(events);
    };
    const { deps: built } = deps(
      {
        dm: [
          respond(
            toolCall('narrate', { text: 'The engines hum.' }),
            toolCall('hand_off', { target: { kind: 'party' } })
          ),
        ],
      },
      { sink }
    );
    const director = await Director.create(config(), built);

    await expect(director.run(2)).rejects.toThrow('disk full');

    expect(director.currentState.session).toBe(1);
    expect(director.events).toHaveLength(1);
    expect(director.events[0]).toMatchObject({ type: 'session_start' });
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
