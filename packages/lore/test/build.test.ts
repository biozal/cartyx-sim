import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, isStale, readMeta, CHUNKER_VERSION } from '../src/build';
import { FakeEmbedder, DOCUMENT_PREFIX, QUERY_PREFIX } from '../src/embed';

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
    expect(await readMeta(indexDir)).toEqual(result.meta);
  });

  it('folds the dm writeup and the Kanka stub onto one entity', async () => {
    const lorePath = await loreRepo();
    const indexDir = join(await mkdtemp(join(tmpdir(), 'lore-index-')), 'lore-index');
    await buildIndex({ lorePath, indexDir, embedder: new FakeEmbedder(16) });
    const rows = JSON.parse(await readFile(join(indexDir, 'chunks.json'), 'utf8')) as {
      chunk: { entityId: string };
    }[];
    expect(new Set(rows.map((row) => row.chunk.entityId))).toEqual(new Set(['kanka-2418574']));
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
    const result = await buildIndex({ lorePath: dir, indexDir, embedder: new FakeEmbedder(16) });
    expect(result.meta.chunks).toBe(1);
    const rows = JSON.parse(await readFile(join(indexDir, 'chunks.json'), 'utf8')) as {
      chunk: { kankaId?: number };
    }[];
    expect(rows.length).toBe(1);
    expect(rows.every((row) => row.chunk.kankaId === undefined)).toBe(true);
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
});
