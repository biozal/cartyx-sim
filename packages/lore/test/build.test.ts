import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, isStale, readMeta, CHUNKER_VERSION } from '../src/build';
import { FakeEmbedder, DOCUMENT_PREFIX, QUERY_PREFIX, type Embedder } from '../src/embed';
import { LanceStore } from '../src/lance';
import type { ScoredChunk } from '../src/store';

/**
 * Every row `buildIndex` wrote, read back out of the real table. The build is only finished if
 * the table it produced can actually be opened and queried, so these tests read the store rather
 * than any side artifact of the build.
 */
async function indexedRows(indexDir: string, embedder: FakeEmbedder): Promise<ScoredChunk[]> {
  const store = await LanceStore.open(indexDir);
  try {
    return await store.search(await embedder.embedQuery('Sella Vaunt'), 100);
  } finally {
    await store.close();
  }
}

async function loreRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lore-build-'));
  await mkdir(join(dir, 'kanka-export', 'markdown', 'characters'), { recursive: true });
  await mkdir(join(dir, 'dm'), { recursive: true });
  await writeFile(
    join(dir, 'kanka-export', 'markdown', 'characters', '2418574-2418574.md'),
    '# Professor Sella Vaunt\n\nTeaches applied crystal engines at Avalon Artificers Academy, where she is feared for her feedback and trusted for her arithmetic.\n'
  );
  await writeFile(
    join(dir, 'dm', 'avalon.md'),
    '# Avalon Artificers Academy\n\n## Prof. Sella Vaunt\n\nProf. Sella Vaunt, 38, human, teaches applied crystal engines and grades every prototype that reaches the orchard strip.\n'
  );
  return dir;
}

describe('buildIndex', () => {
  it('writes meta describing what it indexed', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    const result = await buildIndex({ lorePath, indexDir, embedder: new FakeEmbedder(16) });
    expect(result.meta.files).toBe(2);
    expect(result.meta.chunks).toBe(2);
    expect(result.meta.dims).toBe(16);
    expect(result.meta.embedModel).toBe('fake-embedder');
    expect(result.meta.chunkerVersion).toBe(CHUNKER_VERSION);
    expect(result.meta.documentPrefix).toBe(DOCUMENT_PREFIX);
    expect(result.meta.queryPrefix).toBe(QUERY_PREFIX);
    expect(result.meta.contentDigest).toMatch(/^sha256:/);
    expect(result.meta.ambiguous).toEqual(result.ambiguous);
    expect(await readMeta(indexDir)).toEqual(result.meta);
  });

  it('folds the dm writeup and the Kanka stub onto one entity', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    const embedder = new FakeEmbedder(16);
    await buildIndex({ lorePath, indexDir, embedder });
    const rows = await indexedRows(indexDir, embedder);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.entityId))).toEqual(new Set(['kanka-2418574']));
  });

  it('retries a failed embedding batch rather than losing the whole build', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    const real = new FakeEmbedder(16);
    let calls = 0;
    const flaky: Embedder = {
      model: real.model,
      embedQuery: (text) => real.embedQuery(text),
      async embedDocuments(texts) {
        calls++;
        if (calls === 1) throw new Error('503 Service Unavailable');
        return real.embedDocuments(texts);
      },
    };
    const lines: string[] = [];
    const slept: number[] = [];

    const result = await buildIndex({
      lorePath,
      indexDir,
      embedder: flaky,
      log: (line) => lines.push(line),
      retryDelaysMs: [5, 10],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(calls).toBe(2);
    expect(slept).toEqual([5]);
    expect(result.meta.chunks).toBe(2);
    expect(await indexedRows(indexDir, real)).toHaveLength(2);
    // A slow build has to be explicable from its own output.
    expect(lines.join('\n')).toContain('503 Service Unavailable');
    expect(lines.join('\n')).toContain('retrying in 5ms');
  });

  it('gives up after the last retry, surfacing the endpoint error', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    let calls = 0;
    const dead: Embedder = {
      model: 'dead',
      async embedQuery() {
        throw new Error('connect ECONNREFUSED');
      },
      async embedDocuments() {
        calls++;
        throw new Error('connect ECONNREFUSED');
      },
    };
    await expect(
      buildIndex({
        lorePath,
        indexDir,
        embedder: dead,
        retryDelaysMs: [1, 1],
        sleep: async () => {},
      })
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(3);
  });

  it('names the lorePath when the directory holds no indexable markdown', async () => {
    // What a first-time operator with a typo'd lorePath hits. Without this guard the build dies
    // inside LanceDB with a raw Rust error naming a cargo registry path.
    const empty = await mkdtemp(join(tmpdir(), 'lore-empty-'));
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    await expect(
      buildIndex({ lorePath: empty, indexDir, embedder: new FakeEmbedder(16) })
    ).rejects.toThrow(`No lore chunks found under ${empty}. Check lorePath in campaign.json`);
  });

  it('reports nothing ambiguous for a clean corpus', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    const result = await buildIndex({ lorePath, indexDir, embedder: new FakeEmbedder(16) });
    expect(result.ambiguous).toEqual([]);
  });

  it('builds an index when no chunk resolves to a Kanka entity', async () => {
    // No kanka-export/ directory at all, so every chunk falls through to `pathEntity` and carries
    // no kankaId. LanceDB's schema inference used to throw on an all-null column (see lance.ts).
    const dir = await mkdtemp(join(tmpdir(), 'lore-build-'));
    await mkdir(join(dir, 'dm'), { recursive: true });
    await writeFile(
      join(dir, 'dm', 'avalon.md'),
      '# Avalon Artificers Academy\n\nA polished rival school north of the river, famous for its duels, its bake-offs and its extremely well-funded workshops.\n'
    );
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    const embedder = new FakeEmbedder(16);
    const result = await buildIndex({ lorePath: dir, indexDir, embedder });
    expect(result.meta.chunks).toBe(1);
    const rows = await indexedRows(indexDir, embedder);
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.kankaId === undefined)).toBe(true);
  });
});

describe('isStale', () => {
  const meta = {
    lorePath: '/lore',
    loreCommit: 'abc',
    contentDigest: 'sha256:aa',
    embedModel: 'nomic',
    dims: 768,
    documentPrefix: DOCUMENT_PREFIX,
    queryPrefix: QUERY_PREFIX,
    chunkerVersion: 1,
    files: 2,
    chunks: 3,
    builtAt: '2026-09-20T00:00:00.000Z',
    ambiguous: [],
  };
  const current = {
    lorePath: '/lore',
    contentDigest: 'sha256:aa',
    embedModel: 'nomic',
    dims: 768,
    documentPrefix: DOCUMENT_PREFIX,
    queryPrefix: QUERY_PREFIX,
    chunkerVersion: 1,
  };

  it('is stale when there is no index', () => {
    expect(isStale(undefined, current)).toBe(true);
  });

  it('is fresh when everything that matters matches', () => {
    expect(isStale(meta, current)).toBe(false);
  });

  it('is stale when the content, model, dims, prefixes, chunker, or path change', () => {
    expect(isStale(meta, { ...current, contentDigest: 'sha256:bb' })).toBe(true);
    expect(isStale(meta, { ...current, embedModel: 'other' })).toBe(true);
    expect(isStale(meta, { ...current, dims: 512 })).toBe(true);
    expect(isStale(meta, { ...current, queryPrefix: 'q: ' })).toBe(true);
    expect(isStale(meta, { ...current, chunkerVersion: 2 })).toBe(true);
    expect(isStale(meta, { ...current, lorePath: '/elsewhere' })).toBe(true);
  });

  it('is NOT stale when only the commit moved and no lore file changed', () => {
    expect(isStale({ ...meta, loreCommit: 'different' }, current)).toBe(false);
  });

  it('does not compare dims the caller has not measured', () => {
    // `sim index` and `sim run` decide staleness without an embedding call, so they pass no
    // `dims` at all rather than handing the index's own recorded value back for comparison
    // against itself. An unmeasured width is simply not one of the staleness questions.
    const { dims: _dims, ...unmeasured } = current;
    expect(isStale(meta, unmeasured)).toBe(false);
    expect(isStale({ ...meta, dims: 512 }, unmeasured)).toBe(false);
    expect(isStale({ ...meta, dims: 512 }, { ...unmeasured, contentDigest: 'sha256:bb' })).toBe(
      true
    );
  });
});
