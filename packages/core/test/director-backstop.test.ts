import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig } from '../src/director';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { MemorySink } from '../src/sink';
import { foldEvents } from '../src/state';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, startedState, tomas } from './helpers';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'test',
    party: [kira, tomas],
    seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    retryDelaysMs: [],
    ...overrides,
  };
}

async function director(
  script: Record<string, ScriptedResponse[]>,
  overrides: Partial<DirectorConfig> = {},
  sink = new MemorySink()
) {
  const model = new ScriptedModelClient(script);
  const created = await Director.create(config(overrides), {
    model,
    lore: new StaticLoreIndex([]),
    rng: scriptedRng([]),
    sink,
    prompts: basicPrompts,
    now,
  });
  return { director: created, model, sink };
}

const handOffParty = toolCall('hand_off', { target: { kind: 'party' } });

describe('runaway-loop backstop', () => {
  it('pauses when nobody speaks for too many turns', async () => {
    const pass = respond(toolCall('pass'));
    const { director: run, sink } = await director(
      {
        dm: [respond(handOffParty), respond(handOffParty)],
        'player-kira': [pass, pass],
        'player-tomas': [pass, pass],
      },
      { silentTurnLimit: 99, silentTurnPauseLimit: 5 }
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    expect(sink.events.at(-1)).toMatchObject({
      type: 'session_paused',
      seat: 'dm',
      kind: 'backstop',
      reason: expect.stringContaining('No one has spoken or changed the game state for 5 turns'),
    });
    expect(foldEvents(sink.events)).toEqual(run.currentState);
  });

  it('pauses during combat too', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const sink = new MemorySink();
    const { state, history } = startedState([kira, tomas]);
    const recorder = new TurnRecorder(state, 'setup-combat', now);
    recorder.emit({ type: 'combatant_added', combatant: goblin });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'goblin-1', roll: 20, dexMod: 0, total: 20 },
        { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    await sink.append([...history, ...recorder.events]);
    const { director: run } = await director(
      {
        dm: [respond(handOffParty), respond(handOffParty), respond(handOffParty)],
        'player-kira': [respond(toolCall('pass'))],
        'player-tomas': [respond(toolCall('pass'))],
      },
      { silentTurnLimit: 99, silentTurnPauseLimit: 3 },
      sink
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused' });
    expect(run.currentState.combat).not.toBeNull();
    expect(sink.events.at(-1)).toMatchObject({
      type: 'session_paused',
      kind: 'backstop',
      reason: expect.stringContaining('No one has spoken or changed the game state for 3 turns'),
    });
  });

  it('does not pause a mechanics-only combat that keeps making progress (final review Probe H)', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
      attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
    });
    const sink = new MemorySink();
    const { state, history } = startedState([kira]);
    const recorder = new TurnRecorder(state, 'setup-combat', now);
    recorder.emit({ type: 'combatant_added', combatant: goblin });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 20, dexMod: 2, total: 22 },
        { combatantId: 'goblin-1', roll: 10, dexMod: 0, total: 10 },
      ],
    });
    await sink.append([...history, ...recorder.events]);

    // 3 turns per round (the PC declares, the DM resolves it, the DM takes the goblin's turn) for
    // well past the pause limit below, with no narration at all: only attack and hand_off.
    const rounds = 6;
    const dmScript = Array.from({ length: rounds }, () => [
      respond(
        toolCall('attack', {
          attackerId: 'kira',
          targetId: 'goblin-1',
          attackName: 'Light Hammer',
        }),
        handOffParty
      ),
      respond(
        toolCall('attack', { attackerId: 'goblin-1', targetId: 'kira', attackName: 'Scimitar' }),
        handOffParty
      ),
    ]).flat();
    const playerScript = Array.from({ length: rounds }, () =>
      respond(toolCall('act', { intent: 'attacks the goblin', targetId: 'goblin-1' }))
    );
    const model = new ScriptedModelClient({ dm: dmScript, 'player-kira': playerScript });
    const run = await Director.create(
      config({
        party: [kira],
        seats: { dm: 'dm', players: { kira: 'player-kira' } },
        silentTurnLimit: 99,
        silentTurnPauseLimit: 5,
      }),
      {
        model,
        lore: new StaticLoreIndex([]),
        rng: { die: () => 1 }, // a natural 1 always misses, so the fight runs on with no damage
        sink,
        prompts: basicPrompts,
        now,
      }
    );

    const result = await run.run(rounds * 3);

    expect(result.status).toBe('turn_limit');
    expect(sink.events.some((event) => event.type === 'session_paused')).toBe(false);
    expect(foldEvents(sink.events)).toEqual(run.currentState);
  });

  it('pauses when the DM keeps handing off to a party that cannot act', async () => {
    const downed = [
      { ...kira, hp: 0, conditions: ['unconscious' as const] },
      { ...tomas, hp: 0, conditions: ['unconscious' as const] },
    ];
    const narrateAndHandOff = () =>
      respond(
        toolCall('narrate', { text: 'The party lies still on the cold floor.' }),
        handOffParty
      );
    const {
      director: run,
      sink,
      model,
    } = await director(
      { dm: [narrateAndHandOff(), narrateAndHandOff(), narrateAndHandOff()] },
      { party: downed, idleHandOffLimit: 2 }
    );
    const result = await run.run(50);
    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    expect(model.remaining('dm')).toBe(1);
    expect(sink.events.at(-1)).toMatchObject({
      type: 'session_paused',
      seat: 'dm',
      kind: 'backstop',
      reason: expect.stringContaining('handed off 2 times in a row'),
    });
  });

  it('resumes after a backstop pause with a fresh budget, and pauses again if still stuck', async () => {
    const downed = [
      { ...kira, hp: 0, conditions: ['unconscious' as const] },
      { ...tomas, hp: 0, conditions: ['unconscious' as const] },
    ];
    const narrateAndHandOff = () =>
      respond(
        toolCall('narrate', { text: 'The party lies still on the cold floor.' }),
        handOffParty
      );
    const sink = new MemorySink();
    const {
      director: firstRun,
      sink: firstSink,
      model: firstModel,
    } = await director(
      { dm: [narrateAndHandOff(), narrateAndHandOff(), narrateAndHandOff()] },
      { party: downed, idleHandOffLimit: 2 },
      sink
    );
    const paused = await firstRun.run(50);
    expect(paused.status).toBe('paused');
    expect(firstModel.remaining('dm')).toBe(1);
    expect(firstSink.events.at(-1)).toMatchObject({ type: 'session_paused', kind: 'backstop' });
    expect(firstRun.currentState.idleHandOffs).toBe(0);

    // Resuming loads a Director from the same log; the backstop's own reset (not a fresh process)
    // is what has to give the table a new budget, so the very next step must run a turn, not
    // immediately re-throw the same pause.
    const { director: resumed, model: resumedModel } = await director(
      { dm: [narrateAndHandOff(), narrateAndHandOff(), narrateAndHandOff()] },
      { party: downed, idleHandOffLimit: 2 },
      sink
    );
    const stepResult = await resumed.step();
    expect(stepResult).toBe('continue');
    expect(resumedModel.remaining('dm')).toBe(2);

    // Still stuck: the same cause trips the backstop again after another full idleHandOffLimit.
    const result = await resumed.run(50);
    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    expect(sink.events.at(-1)).toMatchObject({ type: 'session_paused', kind: 'backstop' });
    expect(foldEvents(sink.events)).toEqual(resumed.currentState);
  });

  it('caps DM tool calls per beat and forces the hand-off', async () => {
    const narrations = Array.from({ length: 5 }, (_, index) =>
      toolCall('narrate', { text: `Moment ${index + 1} passes.` })
    );
    const {
      director: run,
      sink,
      model,
    } = await director(
      { dm: [respond(...narrations, handOffParty)] },
      { maxDmToolCallsPerBeat: 3 }
    );
    await run.step();
    await run.step();
    const beat = sink.events.slice(1).map((event) => event.type);
    expect(beat.filter((type) => type === 'narration')).toHaveLength(3);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: 'validator_flag',
        rule: 'dm_tool_call_limit',
        resolution: 'forced_hand_off',
      })
    );
    expect(sink.events).toContainEqual(expect.objectContaining({ type: 'hand_off' }));
    expect(model.requests).toHaveLength(1);
  });
});

describe('DM validator flags', () => {
  it('flags an invalid tool call and a tool error as re-prompted', async () => {
    const { director: run, sink } = await director({
      dm: [
        respond(toolCall('narrate', {})),
        respond(toolCall('npc_say', { npcId: 'npc-nobody', text: 'Hello.' })),
        respond(toolCall('narrate', { text: 'The lab hums.' }), handOffParty),
      ],
    });
    await run.step();
    await run.step();
    const flags = sink.events.filter((event) => event.type === 'validator_flag');
    expect(flags).toEqual([
      expect.objectContaining({ rule: 'invalid_tool_call', resolution: 're_prompted' }),
      expect.objectContaining({ rule: 'tool_error', resolution: 're_prompted' }),
    ]);
  });

  it('flags accepted_with_flag only after the accepted tool actually succeeds', async () => {
    const controlling = toolCall('npc_say', {
      npcId: 'npc-nobody',
      text: 'Kira decides to open the door.',
    });
    const { director: run, sink } = await director(
      {
        dm: [
          respond(controlling),
          respond(toolCall('narrate', { text: 'The door stays shut.' }), handOffParty),
        ],
      },
      { maxValidatorRetries: 0 }
    );
    await run.step();
    await run.step();
    const flags = sink.events.filter((event) => event.type === 'validator_flag');
    expect(flags.map((flag) => flag.type === 'validator_flag' && flag.resolution)).toEqual([
      're_prompted',
    ]);
    expect(flags[0]).toMatchObject({ rule: 'tool_error' });
  });
});

describe('watchdog', () => {
  it('does not nudge the DM in combat even after the silent-turn limit', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const sink = new MemorySink();
    const { state, history } = startedState([kira, tomas]);
    const recorder = new TurnRecorder(state, 'setup-combat', now);
    recorder.emit({ type: 'combatant_added', combatant: goblin });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 20, dexMod: 2, total: 22 },
        { combatantId: 'goblin-1', roll: 10, dexMod: 0, total: 10 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    await sink.append([...history, ...recorder.events]);
    const { director: run, model } = await director(
      { 'player-kira': [respond(toolCall('pass'))] },
      { silentTurnLimit: 2, silentTurnPauseLimit: 99 },
      sink
    );
    await run.step();
    // With the combat guard, the silent table goes to Kira's combat turn, not a DM nudge beat.
    expect(model.requests.map((request) => request.seat)).toEqual(['player-kira']);
  });
});
