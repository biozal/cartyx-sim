import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import {
  handOff,
  introduceNpc,
  lookupLore,
  narrate,
  npcSay,
  recordInvention,
  sceneChange,
} from '../src/tools/narrative';
import { toToolSchema } from '../src/tools/types';
import { startedState } from './helpers';
import { toolHarness } from './tool-harness';

describe('narrate', () => {
  it('emits DM narration with a default emotion', async () => {
    const harness = toolHarness();
    expect(await harness.run(narrate, { text: 'The engines hum.' })).toEqual({
      ok: true,
      outcome: { result: 'Narrated.' },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'narration',
      speaker: 'dm',
      text: 'The engines hum.',
      emotion: 'neutral',
    });
  });

  it('rejects empty text before running', async () => {
    const harness = toolHarness();
    const result = await harness.run(narrate, { text: '' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects whitespace-only text before running', async () => {
    const harness = toolHarness();
    const result = await harness.run(narrate, { text: '   ' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects text over 4000 characters, emitting nothing', async () => {
    const harness = toolHarness();
    expect(await harness.run(narrate, { text: 'a'.repeat(4000) })).toMatchObject({ ok: true });
    const result = await harness.run(narrate, { text: 'a'.repeat(4001) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(1);
  });

  it('publishes a JSON schema where defaulted fields are optional', () => {
    expect(toToolSchema(narrate).parameters).toMatchObject({ required: ['text'] });
  });
});

describe('introduce_npc and npc_say', () => {
  it('introduces an NPC once and lets them speak', async () => {
    const harness = toolHarness();
    const intro = {
      name: 'Professor Sella Vaunt',
      description: 'Crystal engine professor',
      invented: false,
    };
    expect(await harness.run(introduceNpc, intro)).toMatchObject({
      ok: true,
      outcome: {
        result: 'Introduced Professor Sella Vaunt with npcId "npc-professor-sella-vaunt".',
      },
    });
    expect(await harness.run(introduceNpc, intro)).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('already introduced') },
    });
    await harness.run(npcSay, { npcId: 'npc-professor-sella-vaunt', text: 'Find out who.' });
    expect(harness.recorder.events.map((e) => e.type)).toEqual(['npc_introduced', 'dialogue']);
    expect(harness.recorder.events[1]).toMatchObject({
      speaker: 'npc-professor-sella-vaunt',
      speakerKind: 'npc',
    });
  });

  it('refuses dialogue from an NPC who was never introduced', async () => {
    const harness = toolHarness();
    expect(await harness.run(npcSay, { npcId: 'ghost', text: 'Boo.' })).toEqual({
      ok: false,
      error: 'Unknown npcId "ghost". Call introduce_npc first. Known NPCs: none',
    });
  });

  it('namespaces the npcId so it cannot collide with a PC id', async () => {
    const harness = toolHarness();
    const intro = await harness.run(introduceNpc, {
      name: 'Kira',
      description: 'A doppelganger wearing a familiar face',
      invented: true,
    });
    expect(intro).toMatchObject({
      ok: true,
      outcome: { result: 'Introduced Kira with npcId "npc-kira".' },
    });
    await harness.run(npcSay, { npcId: 'npc-kira', text: 'Impostor among us.' });
    expect(harness.recorder.events[1]).toMatchObject({
      speaker: 'npc-kira',
      speakerKind: 'npc',
    });
    expect(harness.recorder.state.wordsBySpeaker['npc-kira']).toBe(3);
    expect(harness.recorder.state.wordsBySpeaker['kira']).toBeUndefined();
  });

  it('namespaces an NPC literally named "DM"', async () => {
    const harness = toolHarness();
    const intro = await harness.run(introduceNpc, {
      name: 'DM',
      description: 'A meta joke NPC',
      invented: true,
    });
    expect(intro).toMatchObject({
      ok: true,
      outcome: { result: 'Introduced DM with npcId "npc-dm".' },
    });
  });

  it('rejects an id that already names a combatant', async () => {
    const started = startedState();
    const ghost = makeCombatant({ id: 'npc-ghost', name: 'Ghost', kind: 'monster' });
    const harness = toolHarness({
      state: { ...started.state, combatants: { ...started.state.combatants, 'npc-ghost': ghost } },
      history: started.history,
    });
    const result = await harness.run(introduceNpc, {
      name: 'Ghost',
      description: 'A restless spirit',
      invented: true,
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('scene_change', () => {
  it('moves the scene', async () => {
    const harness = toolHarness();
    await harness.run(sceneChange, { location: "Dean's Office", artPrompt: 'A polished office' });
    expect(harness.recorder.state.scene?.location).toBe("Dean's Office");
  });
});

describe('lookup_lore', () => {
  it('returns relevant chunks and logs the lookup for the DM only', async () => {
    const harness = toolHarness();
    const result = await harness.run(lookupLore, { query: 'Sella Vaunt' });
    expect(result).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('[avalon#sella-vaunt]') },
    });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'lore_lookup',
      visibility: 'dm',
      query: 'Sella Vaunt',
      hits: [{ chunkId: 'avalon#sella-vaunt', score: 1 }],
      used: ['avalon#sella-vaunt'],
    });
  });

  it('logs a gap when nothing is relevant', async () => {
    const harness = toolHarness();
    const result = await harness.run(lookupLore, { query: 'Echor airship defenses' });
    expect(result).toMatchObject({
      ok: true,
      outcome: { result: expect.stringContaining('record_invention') },
    });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'lore_lookup', used: [] });
  });
});

describe('record_invention', () => {
  it('records an invented fact for the audit', async () => {
    const harness = toolHarness();
    await harness.run(recordInvention, {
      fact: 'Engine three is named Marigold.',
      reason: 'not in lore',
    });
    expect(harness.recorder.events[0]).toMatchObject({ type: 'lore_invention', visibility: 'dm' });
  });
});

describe('id lookups reject built-in property names', () => {
  const POISON_IDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

  it.each(POISON_IDS)('npc_say rejects npcId "%s"', async (id) => {
    const harness = toolHarness();
    expect(await harness.run(npcSay, { npcId: id, text: 'Boo.' })).toEqual({
      ok: false,
      error: `Unknown npcId "${id}". Call introduce_npc first. Known NPCs: none`,
    });
  });

  it.each(POISON_IDS)('hand_off rejects pc id "%s"', async (id) => {
    const harness = toolHarness();
    const result = await harness.run(handOff, { target: { kind: 'pcs', ids: [id] } });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('introduces an NPC named after a built-in property normally', async () => {
    const harness = toolHarness();
    const result = await harness.run(introduceNpc, {
      name: 'Constructor',
      description: 'A strange golem',
      invented: true,
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: { result: 'Introduced Constructor with npcId "npc-constructor".' },
    });
  });
});

describe('argument length limits', () => {
  it('rejects an npc name over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(introduceNpc, {
      name: 'a'.repeat(201),
      description: 'x',
      invented: true,
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an npc description over 2000 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(introduceNpc, {
      name: 'Golem',
      description: 'a'.repeat(2001),
      invented: true,
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects npc_say text over 4000 characters', async () => {
    const harness = toolHarness();
    await harness.run(introduceNpc, { name: 'Golem', description: 'x', invented: true });
    const result = await harness.run(npcSay, { npcId: 'golem', text: 'a'.repeat(4001) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(1);
  });

  it('rejects a scene location over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(sceneChange, { location: 'a'.repeat(201), artPrompt: 'x' });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an art prompt over 2000 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(sceneChange, {
      location: 'Lab',
      artPrompt: 'a'.repeat(2001),
    });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects a lore query over 200 characters', async () => {
    const harness = toolHarness();
    const result = await harness.run(lookupLore, { query: 'a'.repeat(201) });
    expect(result.ok).toBe(false);
    expect(harness.recorder.events).toHaveLength(0);
  });

  it('rejects an invented fact or reason over 2000 characters', async () => {
    const harness = toolHarness();
    expect(
      await harness.run(recordInvention, { fact: 'a'.repeat(2001), reason: 'x' })
    ).toMatchObject({ ok: false });
    expect(
      await harness.run(recordInvention, { fact: 'x', reason: 'a'.repeat(2001) })
    ).toMatchObject({ ok: false });
    expect(harness.recorder.events).toHaveLength(0);
  });
});

describe('hand_off', () => {
  it('ends the beat and queues the party quietest first', async () => {
    const harness = toolHarness();
    const result = await harness.run(handOff, { target: { kind: 'party' } });
    expect(result).toEqual({
      ok: true,
      outcome: { result: 'Handed off to kira, tomas.', endsBeat: true },
    });
    expect(harness.recorder.state.pendingResponders).toEqual(['kira', 'tomas']);
  });

  it('rejects unknown PC ids', async () => {
    const harness = toolHarness();
    expect(await harness.run(handOff, { target: { kind: 'pcs', ids: ['oona'] } })).toEqual({
      ok: false,
      error: 'Unknown player character ids: oona. Party ids: kira, tomas',
    });
  });
});
