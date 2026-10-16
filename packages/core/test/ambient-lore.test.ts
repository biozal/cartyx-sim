import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig, type DirectorDeps } from '../src/director';
import type { LoreIndex } from '../src/model';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import { respond, ScriptedModelClient, StaticLoreIndex, toolCall } from '../src/testing';
import { kira, now, tomas } from './helpers';
import { SELLA_CHUNK } from './tool-harness';

/** Prose that genuinely matches SELLA_CHUNK, so StaticLoreIndex scores it above the threshold. */
const KIRA_PERSONA = {
  backstory: 'Professor Sella Vaunt teaches Kira applied crystal engines at Avalon.',
  loreEntityIds: ['kanka-2418574'],
};

function setup(
  overrides: Partial<DirectorConfig> = {},
  lore?: LoreIndex
): { config: DirectorConfig; deps: DirectorDeps; sink: MemorySink; model: ScriptedModelClient } {
  const model = new ScriptedModelClient({
    dm: [
      respond(
        toolCall('scene_change', {
          location: 'Avalon Artificers Academy',
          artPrompt: 'A brass-and-crystal workshop',
        }),
        toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })
      ),
      respond(toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })),
    ],
    'player-tomas': [
      respond(toolCall('speak', { text: 'Then we start with engine three.', emotion: 'neutral' })),
      respond(toolCall('speak', { text: 'Still nothing here.', emotion: 'neutral' })),
    ],
  });
  const sink = new MemorySink();
  let turn = 0;
  return {
    config: {
      session: 1,
      targetMinutes: 60,
      loreCommit: 'abc123',
      party: [kira, tomas],
      seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
      retryDelaysMs: [],
      ...overrides,
    },
    deps: {
      model,
      lore: lore ?? new StaticLoreIndex([SELLA_CHUNK]),
      rng: scriptedRng([]),
      sink,
      prompts: basicPrompts,
      now,
      newTurnId: () => `turn-${++turn}`,
      sleep: async () => {},
    },
    sink,
    model,
  };
}

describe('ambient lore', () => {
  it('retrieves from the party’s personas at session start, logged as trigger "party"', async () => {
    const { config, deps, sink } = setup({ personas: { kira: KIRA_PERSONA } });
    const director = await Director.create(config, deps);
    await director.step();
    const lookup = sink.events.find((event) => event.type === 'lore_lookup');
    expect(lookup).toMatchObject({ trigger: 'party', used: ['avalon#sella-vaunt'] });
    // It is a normal lore_lookup, so the audit counts it with no changes.
    expect(lookup).toMatchObject({ visibility: 'dm' });
  });

  it('looks up each PC with prose on its own, promoting only that PC’s ties', async () => {
    const tomasBackstory = 'Tomas apprenticed to a clockmaker in a quiet river town.';
    const { config, deps, sink } = setup({
      personas: {
        // Far below the threshold on its own, kept only through Kira's tie to Sella.
        kira: {
          backstory: 'Grew up repairing pumps beside the river with Sella nearby.',
          loreEntityIds: ['kanka-2418574'],
        },
        tomas: { backstory: tomasBackstory },
      },
    });
    const director = await Director.create(config, deps);
    await director.step();
    const lookups = sink.events.filter(
      (event) => event.type === 'lore_lookup' && event.trigger === 'party'
    );
    expect(lookups).toMatchObject([
      {
        query: 'Grew up repairing pumps beside the river with Sella nearby.',
        used: ['avalon#sella-vaunt'],
      },
      // Kira's tie does not leak into Tomas's lookup.
      { query: tomasBackstory, used: [] },
    ]);
  });

  it('gives the DM the PCs’ combined lore once per chunk', async () => {
    const { config, deps, model } = setup({
      personas: {
        kira: KIRA_PERSONA,
        tomas: { motivation: 'Professor Sella Vaunt teaches crystal engines; Tomas wants in.' },
      },
    });
    const director = await Director.create(config, deps);
    await director.step(); // Session start: both PCs' lookups find Sella.
    await director.step(); // The DM's first beat.
    const dmRequest = model.requests.find((request) => request.seat === 'dm')!;
    const everything = dmRequest.messages.map((m) => m.content).join('\n');
    expect(everything.split('[avalon#sella-vaunt]')).toHaveLength(2);
    expect(everything.split('[lore] party ties: 1 relevant result(s)')).toHaveLength(3);
  });

  it('does not retrieve at session start when no persona has prose to retrieve on', async () => {
    const { config, deps, sink } = setup();
    const director = await Director.create(config, deps);
    await director.step();
    const partyLookups = sink.events.filter(
      (event) => event.type === 'lore_lookup' && event.trigger === 'party'
    );
    expect(partyLookups).toEqual([]);
  });

  it('retrieves for the new location after scene_change, logged as trigger "scene"', async () => {
    const { config, deps, sink } = setup();
    const director = await Director.create(config, deps);
    await director.step(); // Session start.
    await director.step(); // DM changes the scene.
    const lookup = sink.events.find(
      (event) => event.type === 'lore_lookup' && event.trigger === 'scene'
    );
    expect(lookup).toMatchObject({
      query: 'Avalon Artificers Academy',
      used: ['avalon#sella-vaunt'],
    });
  });

  it('puts the retrieved text in the next DM prompt', async () => {
    const { config, deps, model } = setup();
    const director = await Director.create(config, deps);
    await director.step(); // Session start.
    await director.step(); // DM changes the scene; ambient lore is retrieved for it.
    await director.step(); // Tomas answers.
    await director.step(); // The DM's next beat must carry the lore.
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    const latest = dmRequests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .at(-1)!.content;
    expect(latest).toContain('Lore for this scene:');
    expect(latest).toContain('teaches applied crystal engines');
  });

  it('degrades to no ambient lore when retrieval throws, instead of failing the turn', async () => {
    const failing: LoreIndex = {
      async search() {
        throw new Error('lore is down');
      },
    };
    const { config, deps, sink, model } = setup({ personas: { kira: KIRA_PERSONA } }, failing);
    const director = await Director.create(config, deps);
    await director.step(); // Session start: the party lookup fails.
    await director.step(); // DM changes the scene: the scene lookup fails.
    await director.step(); // Tomas answers.
    await director.step(); // The DM's next beat still runs, with no lore.
    // No lookup was recorded, and the session kept playing: a lore outage must not end a session.
    expect(sink.events.some((event) => event.type === 'lore_lookup')).toBe(false);
    // The skip is traced in the log, DM-only, so "the lore has nothing" and "the lookup never ran"
    // read differently; the note never carries the party's backstory.
    const notes = sink.events.filter(
      (event) => event.type === 'ooc_note' && /ambient lore/i.test(event.text)
    );
    expect(notes.map((note) => note.visibility)).toEqual(['dm', 'dm']);
    expect(notes[0]).toMatchObject({ text: expect.stringContaining('party') });
    expect(notes[0]).toMatchObject({ text: expect.stringContaining('lore is down') });
    expect(notes[1]).toMatchObject({ text: expect.stringContaining('scene') });
    expect(JSON.stringify(notes)).not.toContain(KIRA_PERSONA.backstory);
    expect(sink.events.some((event) => event.type === 'session_end')).toBe(false);
    // Spent retries on the lore seat would normally pause; ambient retrieval must not.
    expect(sink.events.some((event) => event.type === 'session_paused')).toBe(false);
    expect(model.requests.filter((request) => request.seat === 'dm')).toHaveLength(2);
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    const latest = dmRequests
      .at(-1)!
      .messages.filter((m) => m.role === 'user')
      .at(-1)!.content;
    expect(latest).not.toContain('Lore for this scene:');
  });

  it('retries a failing lore search through the lore seat before giving up', async () => {
    let calls = 0;
    const flaky: LoreIndex = {
      async search(query, limit) {
        calls += 1;
        if (calls === 1) throw new Error('lore blinked');
        return new StaticLoreIndex([SELLA_CHUNK]).search(query, limit);
      },
    };
    const { config, deps, sink } = setup(
      { personas: { kira: KIRA_PERSONA }, retryDelaysMs: [5] },
      flaky
    );
    const slept: number[] = [];
    deps.sleep = async (ms) => {
      slept.push(ms);
    };
    const director = await Director.create(config, deps);
    await director.step();
    expect(slept).toEqual([5]);
    const lookup = sink.events.find((event) => event.type === 'lore_lookup');
    expect(lookup).toMatchObject({ trigger: 'party', used: ['avalon#sella-vaunt'] });
  });

  it('keeps a below-threshold hit on an entity a persona is tied to', async () => {
    // Shares one word in seven with SELLA_CHUNK: far below the threshold, but Kira is tied to her.
    const { config, deps, sink } = setup({
      personas: {
        kira: {
          backstory: 'Grew up repairing pumps beside the river with Sella nearby.',
          loreEntityIds: ['kanka-2418574'],
        },
      },
    });
    const director = await Director.create(config, deps);
    await director.step();
    const lookup = sink.events.find(
      (event) => event.type === 'lore_lookup' && event.trigger === 'party'
    );
    expect(lookup).toMatchObject({ used: ['avalon#sella-vaunt'] });
  });

  it('gives each player its own persona and never another’s', async () => {
    const { config, deps, model } = setup({
      personas: {
        kira: { personality: 'Wry and impatient with authority.' },
        tomas: { personality: 'Patient, methodical, hums while working.' },
      },
    });
    const director = await Director.create(config, deps);
    await director.step(); // Session start.
    await director.step(); // DM hands off to Tomas.
    await director.step(); // Tomas answers.
    const tomasRequest = model.requests.find((request) => request.seat === 'player-tomas')!;
    const system = tomasRequest.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Patient, methodical, hums while working.');
    expect(system).not.toContain('Wry and impatient with authority.');
  });

  it('keeps the party’s backstory out of the DM’s next prompt', async () => {
    const tomasBackstory = 'Tomas lost his clockmaker mentor the year Sella came to Avalon.';
    const { config, deps, model } = setup({
      personas: { kira: KIRA_PERSONA, tomas: { backstory: tomasBackstory } },
    });
    const director = await Director.create(config, deps);
    await director.step(); // Session start: each party lookup is logged with its PC's prose.
    await director.step(); // The DM's first beat.
    const dmRequest = model.requests.find((request) => request.seat === 'dm')!;
    const everything = dmRequest.messages.map((m) => m.content).join('\n');
    expect(everything).toContain('[lore] party ties: 1 relevant result(s)');
    expect(everything).not.toContain(KIRA_PERSONA.backstory);
    expect(everything).not.toContain(tomasBackstory);
  });

  it('records the personas on session_start', async () => {
    const personas = { kira: KIRA_PERSONA };
    const { config, deps, sink } = setup({ personas });
    const director = await Director.create(config, deps);
    await director.step();
    const start = sink.events.find((event) => event.type === 'session_start');
    expect(start).toMatchObject({ personas });
  });
});
