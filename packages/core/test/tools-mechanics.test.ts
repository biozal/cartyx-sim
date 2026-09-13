import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { endCombat, startCombat } from '../src/tools/combat';
import { attack, castSpell, requestCheck } from '../src/tools/mechanics';
import {
  addConditionTool,
  applyDamageTool,
  giveItem,
  healTool,
  removeConditionTool,
  removeItemTool,
} from '../src/tools/state-tools';
import { kira, startedState, tomas } from './helpers';
import { toolHarness } from './tool-harness';

const goblin = makeCombatant({
  id: 'goblin-1',
  name: 'Goblin',
  kind: 'monster',
  ac: 13,
  hp: 7,
  maxHp: 7,
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  attacks: [{ name: 'Scimitar', bonus: 4, damage: '1d6+2', damageType: 'slashing' }],
});

function withGoblin(rolls: number[]) {
  const { state, history } = startedState([kira, tomas]);
  return toolHarness({
    state: { ...state, combatants: { ...state.combatants, [goblin.id]: goblin } },
    history,
    rng: scriptedRng(rolls),
  });
}

const POISON_IDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

describe('id lookups reject built-in property names', () => {
  it.each(POISON_IDS)('request_check rejects combatantId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(requestCheck, {
      combatantId: id,
      checkType: 'ability',
      ability: 'str',
      dc: 10,
      reason: 'x',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(`Unknown combatant id "${id}"`);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('attack rejects attackerId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(attack, {
      attackerId: id,
      targetId: 'tomas',
      attackName: 'Longsword',
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('cast_spell rejects casterId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(castSpell, { casterId: id, spell: 'Shield', slotLevel: 0 });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('apply_damage rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(applyDamageTool, {
      targetId: id,
      amount: 1,
      damageType: 'fire',
      reason: 'x',
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('heal rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(healTool, { targetId: id, amount: 1, reason: 'x' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('add_condition rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(addConditionTool, {
      targetId: id,
      condition: 'poisoned',
      reason: 'x',
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('remove_condition rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(removeConditionTool, {
      targetId: id,
      condition: 'poisoned',
      reason: 'x',
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('give_item rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(giveItem, { targetId: id, item: 'Key' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it.each(POISON_IDS)('remove_item rejects targetId "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(removeItemTool, { targetId: id, item: 'Key' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('request_check', () => {
  it('rolls a skill check and logs the roll', async () => {
    const harness = toolHarness({ rng: scriptedRng([8]) });
    const result = await harness.run(requestCheck, {
      combatantId: 'kira',
      checkType: 'skill',
      skill: 'investigation',
      dc: 13,
      reason: 'tool marks',
    });
    expect(result).toEqual({
      ok: true,
      outcome: { result: 'Kira Vale rolled 13 (natural 8+5) against DC 13: SUCCESS.' },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'roll',
      kind: 'check',
      label: 'Kira Vale Investigation check (tool marks)',
      expr: '1d20+5',
      total: 13,
      target: 13,
      outcome: 'success',
    });
  });

  it('logs saves as saves', async () => {
    const harness = toolHarness({ rng: scriptedRng([3]) });
    await harness.run(requestCheck, {
      combatantId: 'tomas',
      checkType: 'save',
      ability: 'con',
      dc: 12,
      reason: 'poison',
    });
    expect(harness.recorder.events[0]).toMatchObject({
      kind: 'save',
      total: 7,
      outcome: 'failure',
    });
  });

  it('requires the matching skill or ability', async () => {
    const harness = toolHarness();
    expect(
      await harness.run(requestCheck, {
        combatantId: 'kira',
        checkType: 'skill',
        dc: 10,
        reason: 'x',
      })
    ).toEqual({ ok: false, error: 'checkType "skill" requires skill.' });
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('attack', () => {
  it('rolls, applies damage, and reports HP', async () => {
    const harness = withGoblin([12, 3]);
    const result = await harness.run(attack, {
      attackerId: 'tomas',
      targetId: 'goblin-1',
      attackName: 'Longsword',
    });
    expect(result).toEqual({
      ok: true,
      outcome: {
        result:
          "Tomas Reed's Longsword hits Goblin (17 vs AC 13) for 6 slashing damage. Goblin: 1/7 HP.",
      },
    });
    expect(harness.recorder.events.map((e) => e.type)).toEqual(['roll', 'roll', 'state_change']);
    expect(harness.recorder.events[2]).toMatchObject({
      entity: 'goblin-1',
      field: 'hp',
      before: 7,
      after: 1,
      cause: 'attack:tomas',
    });
  });

  it('marks a monster dead at 0 HP', async () => {
    const harness = withGoblin([15, 8]);
    await harness.run(attack, {
      attackerId: 'tomas',
      targetId: 'goblin-1',
      attackName: 'Longsword',
    });
    expect(harness.recorder.events.slice(-2)).toMatchObject([
      { field: 'hp', after: 0 },
      { field: 'dead', before: false, after: true },
    ]);
  });

  it('refuses attacks from a downed attacker', async () => {
    const { state, history } = startedState([
      { ...kira, hp: 0, conditions: ['unconscious'] },
      tomas,
    ]);
    const harness = toolHarness({ state, history });
    expect(
      await harness.run(attack, {
        attackerId: 'kira',
        targetId: 'tomas',
        attackName: 'Light Hammer',
      })
    ).toEqual({
      ok: false,
      error: 'Kira Vale cannot attack at 0 HP or while dead.',
    });
  });
});

describe('cast_spell', () => {
  it('spends a slot and resolves a spell attack', async () => {
    const ready = withGoblin([14, 6, 1, 1]);
    const cast = await ready.run(castSpell, {
      casterId: 'kira',
      spell: 'Chromatic Orb',
      slotLevel: 1,
      targetIds: ['goblin-1'],
      attack: { bonus: 5, damage: '3d8', damageType: 'fire' },
    });
    expect(cast).toEqual({
      ok: true,
      outcome: {
        result: 'Kira Vale casts Chromatic Orb using a level 1 slot: hits Goblin for 8 fire.',
      },
    });
    expect(ready.recorder.events.map((e) => [e.type, 'field' in e ? e.field : undefined])).toEqual([
      ['state_change', 'spellSlots'],
      ['roll', undefined],
      ['roll', undefined],
      ['state_change', 'hp'],
      ['state_change', 'dead'],
    ]);
  });

  it('halves damage on a successful save when asked', async () => {
    const harness = withGoblin([6, 6, 18]);
    await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Thunderwave',
      slotLevel: 1,
      targetIds: ['goblin-1'],
      save: { ability: 'con', dc: 13, damage: '2d8', damageType: 'thunder', halfOnSuccess: true },
    });
    expect(harness.recorder.state.combatants['goblin-1']?.hp).toBe(1);
  });

  it('heals targets', async () => {
    const { state, history } = startedState([kira, { ...tomas, hp: 2 }]);
    const harness = toolHarness({ state, history, rng: scriptedRng([5]) });
    await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Cure Wounds',
      slotLevel: 1,
      targetIds: ['tomas'],
      healing: '1d8+3',
    });
    expect(harness.recorder.state.combatants.tomas?.hp).toBe(10);
  });

  it('keeps the spent slot when the caster targets herself', async () => {
    const { state, history } = startedState([{ ...kira, hp: 5 }, tomas]);
    const harness = toolHarness({ state, history, rng: scriptedRng([5]) });
    await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Cure Wounds',
      slotLevel: 1,
      targetIds: ['kira'],
      healing: '1d8+3',
    });
    expect(harness.recorder.state.combatants.kira?.hp).toBe(10);
    expect(harness.recorder.state.combatants.kira?.spellSlots).toEqual([
      { level: 1, max: 2, used: 1 },
    ]);
    const slotEvents = harness.recorder.events.filter(
      (e) => e.type === 'state_change' && e.field === 'spellSlots'
    );
    expect(slotEvents).toHaveLength(1);
    expect(slotEvents[0]).toMatchObject({ before: [{ used: 0 }], after: [{ used: 1 }] });
  });

  it('refuses a cast with no slot left, emitting nothing', async () => {
    const { state, history } = startedState([
      { ...kira, spellSlots: [{ level: 1, max: 2, used: 2 }] },
      tomas,
    ]);
    const harness = toolHarness({ state, history });
    const result = await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Shield',
      slotLevel: 1,
    });
    expect(result).toEqual({
      ok: false,
      error: 'Kira Vale has no level 1 spell slots left (slots: L1 0/2)',
    });
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('allows only one effect per cast', async () => {
    const harness = withGoblin([]);
    const result = await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'Confused Spell',
      slotLevel: 0,
      targetIds: ['goblin-1'],
      healing: '1d4',
      attack: { bonus: 5, damage: '1d4', damageType: 'fire' },
    });
    expect(result).toEqual({
      ok: false,
      error: 'Use only one of attack, save, or healing in a single cast_spell call.',
    });
  });
});

describe('damage, healing, conditions, and items', () => {
  it('applies flat or rolled damage, but not both', async () => {
    const harness = toolHarness({ rng: scriptedRng([4]) });
    await harness.run(applyDamageTool, {
      targetId: 'tomas',
      dice: '1d6',
      damageType: 'fire',
      reason: 'trap',
    });
    await harness.run(applyDamageTool, {
      targetId: 'tomas',
      amount: 2,
      damageType: 'fire',
      reason: 'trap',
    });
    expect(harness.recorder.state.combatants.tomas?.hp).toBe(6);
    expect(
      await harness.run(applyDamageTool, {
        targetId: 'tomas',
        amount: 1,
        dice: '1d4',
        damageType: 'fire',
        reason: 'x',
      })
    ).toEqual({ ok: false, error: 'Provide exactly one of amount or dice for damage.' });
  });

  it('heals up to max HP', async () => {
    const { state, history } = startedState([kira, { ...tomas, hp: 9 }]);
    const harness = toolHarness({ state, history });
    expect(
      await harness.run(healTool, { targetId: 'tomas', amount: 10, reason: 'potion' })
    ).toEqual({
      ok: true,
      outcome: { result: 'Tomas Reed regains 3 HP. Tomas Reed: 12/12 HP.' },
    });
  });

  it('adds and removes conditions', async () => {
    const harness = toolHarness();
    await harness.run(addConditionTool, {
      targetId: 'kira',
      condition: 'poisoned',
      reason: 'bad stew',
    });
    expect(harness.recorder.state.combatants.kira?.conditions).toEqual(['poisoned']);
    await harness.run(removeConditionTool, {
      targetId: 'kira',
      condition: 'poisoned',
      reason: 'antidote',
    });
    expect(harness.recorder.state.combatants.kira?.conditions).toEqual([]);
    expect(
      await harness.run(removeConditionTool, { targetId: 'kira', condition: 'prone', reason: 'x' })
    ).toEqual({
      ok: false,
      error: 'Kira Vale is not prone.',
    });
  });

  it('gives and removes items', async () => {
    const harness = toolHarness();
    await harness.run(giveItem, { targetId: 'tomas', item: 'Brass Key' });
    await harness.run(removeItemTool, { targetId: 'kira', item: 'Healing Potion' });
    expect(harness.recorder.state.combatants.tomas?.inventory).toEqual([
      { name: 'Brass Key', quantity: 1 },
    ]);
    expect(harness.recorder.state.combatants.kira?.inventory).toEqual([]);
  });

  it('rejects a blank item name before running, emitting nothing', async () => {
    const harness = toolHarness();
    const result = await harness.run(giveItem, { targetId: 'tomas', item: '   ' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
    expect(harness.recorder.state.combatants.tomas?.inventory).toEqual([]);
  });
});

describe('argument length limits', () => {
  it('rejects an attacker or target id over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(attack, {
      attackerId: 'a'.repeat(201),
      targetId: 'tomas',
      attackName: 'Longsword',
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an attack name over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(attack, {
      attackerId: 'tomas',
      targetId: 'kira',
      attackName: 'a'.repeat(201),
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects a spell name over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(castSpell, {
      casterId: 'kira',
      spell: 'a'.repeat(201),
      slotLevel: 0,
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects a reason over 2000 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(requestCheck, {
      combatantId: 'kira',
      checkType: 'ability',
      ability: 'str',
      dc: 10,
      reason: 'a'.repeat(2001),
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an item name over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(giveItem, { targetId: 'tomas', item: 'a'.repeat(201) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('start_combat and end_combat', () => {
  const sentries = {
    monsters: [
      {
        name: 'Clockwork Sentry',
        count: 2,
        ac: 13,
        maxHp: 11,
        abilities: { dex: 12 },
        attacks: [{ name: 'Slam', bonus: 4, damage: '1d6+2', damageType: 'bludgeoning' }],
      },
    ],
  };

  it('adds monsters, rolls initiative, and fixes the order', async () => {
    const harness = toolHarness({ rng: scriptedRng([10, 5, 17, 3]) });
    const result = await harness.run(startCombat, sentries);
    expect(result).toEqual({
      ok: true,
      outcome: {
        result:
          'Combat begins. Initiative order: Clockwork Sentry 1 (clockwork-sentry-1) 18, Kira Vale (kira) 12, Tomas Reed (tomas) 6, Clockwork Sentry 2 (clockwork-sentry-2) 4.',
      },
    });
    expect(harness.recorder.events.map((e) => e.type)).toEqual([
      'combatant_added',
      'combatant_added',
      'roll',
      'roll',
      'roll',
      'roll',
      'combat_start',
    ]);
    expect(harness.recorder.state.combatants['clockwork-sentry-2']).toMatchObject({
      kind: 'monster',
      hp: 11,
    });
    expect(harness.recorder.state.combat?.order[0]?.combatantId).toBe('clockwork-sentry-1');
  });

  it('refuses to start a second combat and ends the current one', async () => {
    const harness = toolHarness({ rng: scriptedRng([10, 5, 17, 3]) });
    await harness.run(startCombat, sentries);
    expect(await harness.run(startCombat, sentries)).toEqual({
      ok: false,
      error: 'Combat is already running. Call end_combat first.',
    });
    expect(await harness.run(endCombat)).toEqual({
      ok: true,
      outcome: { result: 'Combat ended.' },
    });
    expect(await harness.run(endCombat)).toEqual({
      ok: false,
      error: 'There is no combat to end.',
    });
  });
});
