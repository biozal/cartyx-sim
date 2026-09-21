import { scriptedRng } from '@cartyx-sim/rules';
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
import { startCombat } from '../src/tools/combat';
import type { LoreIndex } from '../src/model';
import { toToolSchema } from '../src/tools/types';
import { renderTranscript } from '../src/transcript';
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

  it('coerces an emotion outside the enum to neutral instead of failing', async () => {
    const harness = toolHarness();
    const result = await harness.run(narrate, { text: 'The engines hum.', emotion: 'furious' });
    expect(result).toMatchObject({ ok: true });
    expect(harness.recorder.events[0]).toMatchObject({ emotion: 'neutral' });
  });

  it('keeps the default emotion when none is given', async () => {
    const harness = toolHarness();
    await harness.run(narrate, { text: 'The engines hum.' });
    expect(harness.recorder.events[0]).toMatchObject({ emotion: 'neutral' });
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

  it('coerces an emotion outside the enum to neutral instead of failing', async () => {
    const harness = toolHarness();
    await harness.run(introduceNpc, {
      name: 'Professor Sella Vaunt',
      description: 'Crystal engine professor',
      invented: false,
    });
    const result = await harness.run(npcSay, {
      npcId: 'npc-professor-sella-vaunt',
      text: 'Find out who.',
      emotion: 'smug',
    });
    expect(result).toMatchObject({ ok: true });
    expect(harness.recorder.events[1]).toMatchObject({ type: 'dialogue', emotion: 'neutral' });
  });

  it('removes quote marks wrapped around a whole NPC line', async () => {
    const harness = toolHarness();
    await harness.run(introduceNpc, {
      name: 'Professor Sella Vaunt',
      description: 'Crystal engine professor',
      invented: false,
    });
    await harness.run(npcSay, { npcId: 'npc-professor-sella-vaunt', text: '"Find out who."' });
    expect(harness.recorder.events[1]).toMatchObject({ type: 'dialogue', text: 'Find out who.' });
  });

  it('G5.15: records a loreEntityId on the event and in state.npcs', async () => {
    const harness = toolHarness();
    await harness.run(introduceNpc, {
      name: 'Professor Sella Vaunt',
      description: 'Crystal engine professor',
      invented: false,
      loreEntityId: '2418574',
    });
    expect(harness.recorder.events[0]).toMatchObject({ loreEntityId: '2418574' });
    expect(harness.recorder.state.npcs['npc-professor-sella-vaunt']).toMatchObject({
      loreEntityId: '2418574',
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
    const transcript = renderTranscript(
      harness.recorder.events,
      harness.recorder.state,
      'player',
      10
    );
    expect(transcript).toContain('Kira: "Impostor among us."');
    expect(transcript).not.toContain('Kira Vale');
  });

  it.each(['Kira Vale', '  kira vale  ', 'TOMAS REED'])(
    'F7: rejects an NPC named like a party member: "%s"',
    async (name) => {
      const harness = toolHarness();
      const result = await harness.run(introduceNpc, {
        name,
        description: 'A lookalike',
        invented: true,
      });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/player character.*distinct name/i);
      expect(harness.recorder.events).toHaveLength(0);
    }
  );

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

  it('throws while combat is still running', async () => {
    const harness = toolHarness({ rng: scriptedRng([10, 5, 17]) });
    await harness.run(startCombat, {
      monsters: [
        {
          name: 'Clockwork Sentry',
          ac: 13,
          maxHp: 11,
          attacks: [{ name: 'Slam', bonus: 4, damage: '1d6+2', damageType: 'bludgeoning' }],
        },
      ],
    });
    expect(
      await harness.run(sceneChange, { location: "Dean's Office", artPrompt: 'A polished office' })
    ).toEqual({
      ok: false,
      error: 'Combat is still running. Call end_combat first, then scene_change.',
    });
    expect(harness.recorder.state.scene).toBeNull();
  });

  it('G5.15: records a loreEntityId on the event and in state.scene', async () => {
    const harness = toolHarness();
    await harness.run(sceneChange, {
      location: "Dean's Office",
      artPrompt: 'A polished office',
      loreEntityId: 'place-42',
    });
    expect(harness.recorder.events[0]).toMatchObject({ loreEntityId: 'place-42' });
    expect(harness.recorder.state.scene).toMatchObject({ loreEntityId: 'place-42' });
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

  it('G5.14: a hit exactly at the relevance threshold counts as used', async () => {
    const lore: LoreIndex = {
      async search() {
        return [
          {
            chunkId: 'avalon#threshold',
            source: 'test',
            title: 'Threshold Hit',
            text: 'Right at the line.',
            score: 0.35,
          },
        ];
      },
    };
    const harness = toolHarness({ lore });
    await harness.run(lookupLore, { query: 'threshold' });
    expect(harness.recorder.events[0]).toMatchObject({
      type: 'lore_lookup',
      used: ['avalon#threshold'],
    });
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

  it('attaches the query of a lore lookup earlier this turn', async () => {
    const harness = toolHarness();
    await harness.run(lookupLore, { query: 'Echor airship defenses' });
    await harness.run(recordInvention, {
      fact: 'Echor airships carry no weapons.',
      reason: 'not in lore',
    });
    expect(harness.recorder.events[1]).toMatchObject({
      type: 'lore_invention',
      query: 'Echor airship defenses',
    });
  });

  it('leaves the query out when nothing was looked up this turn', async () => {
    // A fresh recorder (a new turn/beat) holds none of a prior turn's events, so a lookup from
    // before this beat never lingers here.
    const harness = toolHarness();
    await harness.run(recordInvention, {
      fact: 'Engine three is named Marigold.',
      reason: 'not in lore',
    });
    expect(harness.recorder.events[0]).not.toHaveProperty('query');
  });

  it('ignores a query the model supplies, deriving it from the turn instead', async () => {
    const harness = toolHarness();
    await harness.run(recordInvention, {
      fact: 'Engine three is named Marigold.',
      reason: 'not in lore',
      query: 'a stale query from a different turn',
    });
    expect(harness.recorder.events[0]).not.toHaveProperty('query');
  });

  it('no longer publishes a query parameter to the model', () => {
    expect(toToolSchema(recordInvention).parameters).toMatchObject({
      required: ['fact', 'reason'],
    });
    const properties = (toToolSchema(recordInvention).parameters as { properties: object })
      .properties;
    expect(properties).not.toHaveProperty('query');
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

  it('takes a hand-off naming only combatants in combat as one to the party (session 011)', async () => {
    const harness = toolHarness();
    harness.recorder.emit({
      type: 'combatant_added',
      combatant: makeCombatant({ id: 'giant-rat-2', name: 'Giant Rat 2', kind: 'monster' }),
    });
    harness.recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 15, dexMod: 2, total: 17 },
        { combatantId: 'giant-rat-2', roll: 8, dexMod: 2, total: 10 },
      ],
    });
    const result = await harness.run(handOff, { target: { kind: 'pcs', ids: ['giant-rat-2'] } });
    expect(result.ok).toBe(true);
    expect((result as { outcome: { result: string } }).outcome.result).toContain(
      'giant-rat-2 is not a player character, so initiative decides who acts next.'
    );
    expect(harness.recorder.events.at(-1)).toMatchObject({
      type: 'hand_off',
      target: { kind: 'party' },
    });
  });

  it('tells the DM a monster cannot take the spotlight (session 009)', async () => {
    const harness = toolHarness();
    harness.recorder.emit({
      type: 'combatant_added',
      combatant: makeCombatant({
        id: 'hooded-merchant-1',
        name: 'Hooded Merchant',
        kind: 'monster',
      }),
    });
    const result = await harness.run(handOff, {
      target: { kind: 'pcs', ids: ['hooded-merchant-1', 'zzz'] },
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('Unknown ids: hooded-merchant-1, zzz');
    expect((result as { error: string }).error).toContain(
      'Only player characters take the spotlight, and hooded-merchant-1 is not one'
    );
  });

  it('rejects unknown PC ids', async () => {
    const harness = toolHarness();
    expect(await harness.run(handOff, { target: { kind: 'pcs', ids: ['oona'] } })).toEqual({
      ok: false,
      error: 'Unknown player character ids: oona. Party ids: kira, tomas',
    });
  });

  describe('a bare string target', () => {
    it('coerces "party" to { kind: "party" }', async () => {
      const harness = toolHarness();
      const result = await harness.run(handOff, { target: 'party' });
      expect(result).toEqual({
        ok: true,
        outcome: { result: 'Handed off to kira, tomas.', endsBeat: true },
      });
      expect(harness.recorder.events[0]).toMatchObject({
        type: 'hand_off',
        target: { kind: 'party' },
      });
    });

    it('coerces "open" to { kind: "open" }', async () => {
      const harness = toolHarness();
      const result = await harness.run(handOff, { target: 'open' });
      expect(result).toMatchObject({ ok: true });
      expect(harness.recorder.events[0]).toMatchObject({
        type: 'hand_off',
        target: { kind: 'open' },
      });
    });

    it('coerces any other string to { kind: "pcs", ids: [string] }', async () => {
      const harness = toolHarness();
      const result = await harness.run(handOff, { target: 'kira' });
      expect(result).toEqual({
        ok: true,
        outcome: { result: 'Handed off to kira.', endsBeat: true },
      });
      expect(harness.recorder.events[0]).toMatchObject({
        type: 'hand_off',
        target: { kind: 'pcs', ids: ['kira'] },
      });
    });

    it("still errors on an unknown player character id, with today's message", async () => {
      const harness = toolHarness();
      expect(await harness.run(handOff, { target: 'oona' })).toEqual({
        ok: false,
        error: 'Unknown player character ids: oona. Party ids: kira, tomas',
      });
      expect(harness.recorder.events).toHaveLength(0);
    });

    const SHAPE_ERROR =
      'hand_off target must be an object like {"kind": "party"}, {"kind": "open"}, or ' +
      '{"kind": "pcs", "ids": ["kira"]}.';

    it.each([
      ['garbled tool-call syntax', '<parameter=kind>\npcs'],
      ['a comma-separated list', 'party, open'],
      ['an empty string', ''],
    ])('rejects %s as a shape error, not a list of ids', async (_label, target) => {
      const harness = toolHarness();
      expect(await harness.run(handOff, { target })).toEqual({ ok: false, error: SHAPE_ERROR });
      expect(harness.recorder.events).toHaveLength(0);
    });

    it('documents the string branch in the published schema instead of a bare string', () => {
      const parameters = toToolSchema(handOff).parameters as {
        properties: { target: { anyOf: Array<{ type?: string; description?: string }> } };
      };
      const stringBranch = parameters.properties.target.anyOf.find(
        (branch) => branch.type === 'string'
      );
      expect(stringBranch?.description).toEqual(expect.stringContaining('party'));
      expect(stringBranch?.description).toEqual(expect.stringContaining('open'));
    });
  });
});
