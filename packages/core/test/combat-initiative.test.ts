import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { TurnRecorder } from '../src/recorder';
import { advanceCombat, nextActor } from '../src/state';
import { startCombat } from '../src/tools/combat';
import { handOff } from '../src/tools/narrative';
import { kira, now, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

const goblins = {
  monsters: [
    {
      name: 'Goblin',
      ac: 13,
      maxHp: 7,
      attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
    },
  ],
};

describe('start_combat initiative', () => {
  it('adds a living party member at 0 HP to the order and gives them a death-save turn', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history, rng: scriptedRng([15, 10, 5]) });
    const result = await harness.run(startCombat, goblins);
    expect(result.ok).toBe(true);
    const order = harness.recorder.state.combat!.order.map((entry) => entry.combatantId);
    expect(order).toContain('kira');
    expect(order).toEqual(['kira', 'tomas', 'goblin-1']);

    // A dying PC keeps their place in the order: their turn is a death saving throw.
    expect(advanceCombat(harness.recorder.state, { inclusive: true })).toMatchObject({
      combatantId: 'kira',
    });
    expect(nextActor(harness.recorder.state)).toEqual({
      kind: 'death_save',
      combatantId: 'kira',
    });
  });

  it('skips a stabilized party member at 0 HP', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'], stable: true },
      tomas,
    ]);
    const harness = toolHarness({ state, history, rng: scriptedRng([15, 10, 5]) });
    await harness.run(startCombat, goblins);
    expect(advanceCombat(harness.recorder.state, { inclusive: true })).toMatchObject({
      combatantId: 'tomas',
    });
  });

  it('lets a PC healed mid-fight act on their next turn', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history, rng: scriptedRng([15, 10, 5]) });
    await harness.run(startCombat, goblins);
    const recorder = new TurnRecorder(harness.recorder.state, 'heal', now);
    recorder.emit({ type: 'combat_turn', round: 1, turnIndex: 2, combatantId: 'goblin-1' });
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'hp',
      before: 0,
      after: 4,
      cause: 'healing:potion',
    });
    recorder.emit({
      type: 'state_change',
      entity: 'kira',
      field: 'conditions',
      before: ['unconscious'],
      after: [],
      cause: 'healing:potion',
    });
    const advance = advanceCombat(recorder.state)!;
    expect(advance).toEqual({ round: 2, turnIndex: 0, combatantId: 'kira' });
    recorder.emit({ type: 'combat_turn', ...advance });
    expect(nextActor(recorder.state)).toEqual({ kind: 'pc', pcId: 'kira', reason: 'combat_turn' });
  });

  it('still leaves the dead out of initiative', async () => {
    const { state, history } = startedState([{ ...kira, hp: 0, dead: true }, tomas]);
    const harness = toolHarness({ state, history, rng: scriptedRng([10, 5]) });
    await harness.run(startCombat, goblins);
    const order = harness.recorder.state.combat!.order.map((entry) => entry.combatantId);
    expect(order).not.toContain('kira');
  });
});

describe('start_combat and the session clock', () => {
  it.each(['end_at_scene_break', 'hard_stop'] as const)(
    'refuses a new fight once the clock has hit %s',
    async (clockPhase) => {
      const { state, history } = startedState();
      const harness = toolHarness({ state, history, clockPhase });
      const result = await harness.run(startCombat, goblins);
      expect(result).toMatchObject({
        ok: false,
        error: 'Time is up: no new fight can start. Close the scene and call scene_change.',
      });
    }
  );

  it.each(['running', 'wrap_up'] as const)(
    'still starts a fight at clock phase %s',
    async (clockPhase) => {
      const { state, history } = startedState();
      const harness = toolHarness({ state, history, clockPhase, rng: scriptedRng([15, 10, 5]) });
      const result = await harness.run(startCombat, goblins);
      expect(result).toMatchObject({ ok: true });
    }
  );
});

describe('hand_off when nobody can respond', () => {
  it('tells the DM to resolve the situation instead of silently handing off', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      { ...tomas, hp: 0, conditions: ['unconscious'] },
    ]);
    const harness = toolHarness({ state, history });
    const result = await harness.run(handOff, { target: { kind: 'party' } });
    expect(result).toMatchObject({
      ok: true,
      outcome: { endsBeat: true, result: expect.stringContaining('Nobody can respond') },
    });
  });
});
