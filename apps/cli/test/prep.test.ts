import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeEmbedder, openIndex, type Embedder } from '@cartyx-sim/lore';
import type { LoreHit, ModelClient, ModelRequest } from '@cartyx-sim/core';
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign';
import { loreIndexDir, runIndex } from '../src/index-lore';
import { chooseLocation, formatPrepSummary, parsePrepHeader, prepPath, runPrep } from '../src/prep';

/**
 * `FakeEmbedder`'s hash spread, moved into the positive orthant so every cosine is at least 0.
 * `FakeEmbedder` alone scores an unrelated query anywhere in [-1, 1], so threshold 0 would not
 * mean "everything clears"; with this, the tests' thresholds mean what they say (0 admits every
 * hit, 0.99 none), and the scores are still distinct enough to rank.
 */
class PositiveEmbedder implements Embedder {
  readonly model = 'positive-fake-embedder';
  private readonly inner = new FakeEmbedder(16);

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return (await this.inner.embedDocuments(texts)).map(positive);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return positive(await this.inner.embedQuery(text));
  }
}

function positive(vector: Float32Array): Float32Array {
  return vector.map((value) => (value + 1) / 2);
}

const OUTLINE = '## Hook\n\nSomething is wrong at the workshop.\n';

/** A model that answers every request with the same body; no test may reach a network. */
function stubModel(reply = OUTLINE): ModelClient {
  return {
    async complete() {
      return { text: reply, toolCalls: [] };
    },
  };
}

/**
 * A model that answers the choose-a-location call with `choice` and every other call with the
 * outline, recording each request so a test can see what prep asked.
 */
function choosingModel(choice: string): { model: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      async complete(request) {
        requests.push(request);
        const prompt = request.messages.map((message) => message.content).join('\n');
        return { text: /choose/i.test(prompt) ? choice : OUTLINE, toolCalls: [] };
      },
    },
  };
}

const ALPHARETTA =
  '# Alpharetta\n\nA prosperous city north of Atlanta, home to the Avalon Artificers Academy, ' +
  'a dozen rival workshops and the best bake-off in the metro area.\n';
const ROSWELL =
  '# Roswell\n\nAn old mill town on the Chattahoochee, where the river workshops still run on ' +
  'water power and the antique dealers know more than they say.\n';

async function fixture(
  loreThreshold: number,
  lore: Record<string, string> = { 'alpharetta.md': ALPHARETTA },
  { indexed = true }: { indexed?: boolean } = {}
): Promise<{ campaignsDir: string; loreDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sim-prep-'));
  const loreDir = join(root, 'lore');
  await mkdir(join(loreDir, 'dm'), { recursive: true });
  // A bare file name is a DM write-up under dm/; a path is relative to the lore root, so a test
  // can place Kanka entities (kanka-export/markdown/<type>/...) whose type the index records.
  for (const [file, text] of Object.entries(lore)) {
    const path = file.includes('/') ? join(loreDir, file) : join(loreDir, 'dm', file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const campaignsDir = join(root, 'campaigns');
  const dir = join(campaignsDir, 'test');
  await mkdir(join(dir, 'characters'), { recursive: true });
  await writeFile(
    join(dir, 'campaign.json'),
    JSON.stringify({
      name: 'Test',
      targetMinutes: 5,
      lorePath: loreDir,
      loreThreshold,
      premise: { world: 'Cartyx', region: 'The Atlanta metro area, Georgia.' },
      endpoints: { local: { baseURL: 'http://127.0.0.1:1234/v1' } },
      seats: {
        dm: { endpoint: 'local', model: 'dm-model' },
        embed: { endpoint: 'local', model: 'embed-model' },
        players: { kira: { endpoint: 'local', model: 'pc-model' } },
      },
    })
  );
  await writeFile(
    join(dir, 'characters', 'kira.json'),
    JSON.stringify({
      id: 'kira',
      name: 'Kira Vale',
      kind: 'pc',
      level: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      proficiencyBonus: 2,
      saveProficiencies: [],
      skillProficiencies: [],
      ac: 12,
      maxHp: 8,
      hp: 8,
      persona: { motivation: 'Clear the workshop’s name.' },
    })
  );
  // Built here unless a test is about prep building it, so most tests are about prep, not indexing.
  if (indexed) await runIndex({ campaignsDir, campaign: 'test', embedder: new PositiveEmbedder() });
  return { campaignsDir, loreDir };
}

/** Every entity id in the fixture's index, read straight from the index rather than from prep. */
async function indexedEntityIds(campaignsDir: string): Promise<Set<string>> {
  const index = await openIndex(
    loreIndexDir(await loadCampaign(campaignsDir, 'test')),
    new PositiveEmbedder()
  );
  try {
    return new Set((await index.search('anything', 50)).map((hit) => hit.entityId));
  } finally {
    await index.close();
  }
}

// Kanka entities, so the index types them: a `location` and a `character` (chunks under 80
// characters are dropped, hence the length).
const ROSWELL_PLACE =
  '# Roswell\n\nAn old mill town north of Atlanta, Georgia, where the river workshops still run ' +
  'on water power.\n';
const SELLA_PERSON =
  '# Sella Vaunt\n\nA professor in the Atlanta metro area, Georgia, who teaches applied crystal ' +
  'engines to the academy’s first-years.\n';

/** A lore hit for `chooseLocation` tests, where the search is stubbed and scores are exact. */
function hit(entityId: string, entityName: string, entityType: string, score: number): LoreHit {
  return {
    chunkId: `${entityId}#0`,
    source: `${entityId}.md`,
    title: entityName,
    text: `${entityName} lore.`,
    score,
    entityId,
    entityName,
    entityType,
  };
}

/** `chooseLocation` with the given hits (sorted best first, as the index returns them). */
async function choose(
  hits: LoreHit[],
  options: { location?: string; reply?: string; threshold?: number } = {}
) {
  const { campaignsDir } = await fixture(0, undefined, { indexed: false });
  const { model, requests } = choosingModel(options.reply ?? 'none of them');
  const lines: string[] = [];
  const result = await chooseLocation({
    campaign: await loadCampaign(campaignsDir, 'test'),
    search: async () => [...hits].sort((a, b) => b.score - a.score),
    threshold: options.threshold ?? 0.5,
    location: options.location,
    model,
    log: (line) => lines.push(line),
  });
  const offered = requests[0]?.messages.map((message) => message.content).join('\n');
  return { ...result, lines, offered };
}

describe('chooseLocation', () => {
  it('offers the DM seat only places when any clear the threshold', async () => {
    const { hit: chosen, offered } = await choose([
      hit('kanka-1', 'Sella Vaunt', 'character', 0.9),
      hit('file:dm/notes.md#notes', 'Notes', 'document', 0.8),
      hit('kanka-2', 'Roswell', 'location', 0.7),
      hit('kanka-3', 'Alpharetta', 'location', 0.6),
      // Below the threshold: not a candidate whatever its type.
      hit('kanka-4', 'Marietta', 'location', 0.1),
    ]);
    expect(offered).toContain('- Roswell');
    expect(offered).toContain('- Alpharetta');
    expect(offered).not.toContain('Sella Vaunt');
    expect(offered).not.toContain('Notes');
    expect(offered).not.toContain('Marietta');
    // The DM named none, so the fallback is the best place, not the best hit.
    expect(chosen.entityId).toBe('kanka-2');
  });

  it('falls back to every type when no place clears the threshold', async () => {
    const { hit: chosen, offered } = await choose(
      [
        hit('file:dm/alpharetta.md#alpharetta', 'Alpharetta', 'document', 0.8),
        hit('kanka-1', 'Sella Vaunt', 'character', 0.7),
        hit('kanka-2', 'Roswell', 'location', 0.1),
      ],
      { reply: 'Alpharetta' }
    );
    expect(offered).toContain('- Alpharetta');
    expect(offered).toContain('- Sella Vaunt');
    expect(chosen.entityId).toBe('file:dm/alpharetta.md#alpharetta');
  });

  it('keeps same-named entities apart and resolves the name to the best-scoring one', async () => {
    const { hit: chosen, offered } = await choose(
      [
        hit('kanka-1', 'Brookhaven', 'location', 0.7),
        hit('kanka-2', 'Brookhaven', 'location', 0.9),
        hit('kanka-3', 'Roswell', 'location', 0.8),
      ],
      { reply: 'Brookhaven' }
    );
    // One name offered once, and the reply resolves to the better of the two entities.
    expect(offered!.split('- Brookhaven')).toHaveLength(2);
    expect(chosen.entityId).toBe('kanka-2');
  });

  it('prefers a place when a pinned name matches several types', async () => {
    const { hit: chosen } = await choose(
      [hit('kanka-9', 'Brookhaven', 'map', 0.9), hit('kanka-2', 'Brookhaven', 'location', 0.8)],
      { location: 'Brookhaven' }
    );
    expect(chosen.entityId).toBe('kanka-2');
  });

  it('opens a pinned name that matches no entity at the best place, not the best hit', async () => {
    const { hit: chosen, lines } = await choose(
      [hit('kanka-1', 'Sella Vaunt', 'character', 0.9), hit('kanka-2', 'Roswell', 'location', 0.7)],
      { location: 'Roswell Township' }
    );
    expect(chosen.entityId).toBe('kanka-2');
    expect(lines).toContain(
      'No lore entity is named "Roswell Township"; opening at the best match, Roswell.'
    );
  });

  it('honours a pinned name that only a non-place has, and says what type it is', async () => {
    const { hit: chosen, lines } = await choose(
      [hit('kanka-1', 'Sella Vaunt', 'character', 0.9), hit('kanka-2', 'Roswell', 'location', 0.7)],
      { location: 'Sella Vaunt' }
    );
    expect(chosen.entityId).toBe('kanka-1');
    expect(lines).toContain('"Sella Vaunt" is a character, not a location; opening there anyway.');
  });
});

describe('parsePrepHeader', () => {
  it('reads the fields the engine depends on', () => {
    const md = [
      '---',
      'session: 14',
      'location: Alpharetta',
      'locationEntityId: kanka-1465238',
      '---',
      '',
      '## Hook',
      'Something is wrong.',
    ].join('\n');
    expect(parsePrepHeader(md)).toEqual({
      location: 'Alpharetta',
      locationEntityId: 'kanka-1465238',
    });
  });

  it('returns undefined for a file with no header, rather than guessing from the prose', () => {
    expect(parsePrepHeader('## Hook\n\nSomething happened in Alpharetta.')).toBeUndefined();
  });

  it('returns undefined when the header is missing a field the engine needs', () => {
    expect(parsePrepHeader('---\nsession: 14\n---\n\n## Hook\n')).toBeUndefined();
  });
});

describe('runPrep', () => {
  it('pins the location given on the command line and records its real entity id', async () => {
    const { campaignsDir } = await fixture(0);
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new PositiveEmbedder(),
      model: stubModel(),
    });
    expect(result.location).toBe('Alpharetta');
    // A real indexed entity, never invented. This repo has no kanka-export, so it is a file id.
    expect(result.locationEntityId).toMatch(/^(kanka-\d+|file:)/);
    expect(result.chunkIds.length).toBeGreaterThan(0);
    // The header the engine will read back must round-trip.
    const written = await readFile(result.path, 'utf8');
    expect(parsePrepHeader(written)).toEqual({
      location: 'Alpharetta',
      locationEntityId: result.locationEntityId,
    });
    expect(written).toContain(`loreChunkIds: [${result.chunkIds.join(', ')}]`);
    expect(written).toContain('## Hook');
    expect(formatPrepSummary(result).join('\n')).toContain(result.locationEntityId);
  });

  it('lets the DM seat choose among real entities near the premise region', async () => {
    const { campaignsDir } = await fixture(0, {
      'alpharetta.md': ALPHARETTA,
      'roswell.md': ROSWELL,
    });
    const { model, requests } = choosingModel('Roswell');
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      embedder: new PositiveEmbedder(),
      model,
    });
    expect(result.location).toBe('Roswell');
    expect(await indexedEntityIds(campaignsDir)).toContain(result.locationEntityId);
    // Both candidates were offered, and the choice came before the outline.
    expect(requests).toHaveLength(2);
    const offered = requests[0]!.messages.map((message) => message.content).join('\n');
    expect(offered).toContain('Alpharetta');
    expect(offered).toContain('Roswell');
    const written = await readFile(result.path, 'utf8');
    expect(parsePrepHeader(written)).toEqual({
      location: 'Roswell',
      locationEntityId: result.locationEntityId,
    });
  });

  it('falls back to the best-scoring candidate when the DM names none of them', async () => {
    const { campaignsDir } = await fixture(0, {
      'alpharetta.md': ALPHARETTA,
      'roswell.md': ROSWELL,
    });
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      embedder: new PositiveEmbedder(),
      model: choosingModel('Somewhere I just made up').model,
    });
    // The best-scoring hit for the region query, read from the index independently of prep.
    const index = await openIndex(
      loreIndexDir(await loadCampaign(campaignsDir, 'test')),
      new PositiveEmbedder()
    );
    let best;
    try {
      [best] = await index.search('The Atlanta metro area, Georgia.', 1);
    } finally {
      await index.close();
    }
    expect(result.location).toBe(best!.entityName);
    expect(result.locationEntityId).toBe(best!.entityId);
  });

  it('opens at an indexed Kanka location, never a character, when the DM names neither', async () => {
    const { campaignsDir } = await fixture(0, {
      'alpharetta.md': ALPHARETTA,
      'kanka-export/markdown/locations/101-101.md': ROSWELL_PLACE,
      'kanka-export/markdown/characters/202-202.md': SELLA_PERSON,
    });
    const { model, requests } = choosingModel('Somewhere I just made up');
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      embedder: new PositiveEmbedder(),
      model,
    });
    expect(result).toMatchObject({ location: 'Roswell', locationEntityId: 'kanka-101' });
    const offered = requests[0]!.messages.map((message) => message.content).join('\n');
    expect(offered).not.toContain('Sella Vaunt');
  });

  it('builds the index when the campaign was never indexed', async () => {
    const { campaignsDir } = await fixture(0, undefined, { indexed: false });
    const lines: string[] = [];
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new PositiveEmbedder(),
      model: stubModel(),
      log: (line) => lines.push(line),
    });
    expect(result.location).toBe('Alpharetta');
    expect(lines.some((line) => line.startsWith('Rebuilt the lore index'))).toBe(true);
  });

  it('refreshes a stale index before choosing, so the place exists in the lore as it is now', async () => {
    const { campaignsDir, loreDir } = await fixture(0);
    // Lore added after indexing: a stale index has no Roswell and would fall back to Alpharetta.
    await writeFile(join(loreDir, 'dm', 'roswell.md'), ROSWELL);
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Roswell',
      embedder: new PositiveEmbedder(),
      model: stubModel(),
    });
    expect(result.location).toBe('Roswell');
    expect(await indexedEntityIds(campaignsDir)).toContain(result.locationEntityId);
  });

  it('says which entity it used when no entity has the pinned name', async () => {
    const { campaignsDir } = await fixture(0);
    const lines: string[] = [];
    const result = await runPrep({
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta Township',
      embedder: new PositiveEmbedder(),
      model: stubModel(),
      log: (line) => lines.push(line),
    });
    expect(result.location).toBe('Alpharetta');
    expect(lines).toContain(
      'No lore entity is named "Alpharetta Township"; opening at the best match, Alpharetta.'
    );
  });

  it('refuses rather than inventing when nothing clears the threshold', async () => {
    const { campaignsDir } = await fixture(0.99);
    await expect(
      runPrep({
        campaignsDir,
        campaign: 'test',
        session: 1,
        location: 'Nowhere At All',
        embedder: new PositiveEmbedder(),
        model: stubModel(),
      })
      // The message names what it tried, so an operator can see why and pick a real place.
    ).rejects.toThrow(/Nowhere At All/);
    // And nothing was written: a prep file naming a made-up place is the failure this prevents.
    await expect(readFile(prepPath(campaignsDir, 'test', 1), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite an existing outline without --force', async () => {
    const { campaignsDir } = await fixture(0);
    const options = {
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new PositiveEmbedder(),
    };
    const first = await runPrep({
      ...options,
      model: stubModel('## Hook\n\nThe first outline.\n'),
    });
    await expect(
      runPrep({ ...options, model: stubModel('## Hook\n\nA second outline.\n') })
    ).rejects.toThrow(/--force/);
    expect(await readFile(first.path, 'utf8')).toContain('The first outline.');
  });

  it('overwrites with --force', async () => {
    const { campaignsDir } = await fixture(0);
    const options = {
      campaignsDir,
      campaign: 'test',
      session: 1,
      location: 'Alpharetta',
      embedder: new PositiveEmbedder(),
    };
    await runPrep({ ...options, model: stubModel('## Hook\n\nThe first outline.\n') });
    const second = await runPrep({
      ...options,
      force: true,
      model: stubModel('## Hook\n\nA second outline.\n'),
    });
    const written = await readFile(second.path, 'utf8');
    expect(written).toContain('A second outline.');
    expect(written).not.toContain('The first outline.');
  });
});
