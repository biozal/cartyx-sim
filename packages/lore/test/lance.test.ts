import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LanceStore } from '../src/lance';
import type { StoredChunk } from '../src/store';

function chunk(id: string, entityId: string, kankaId?: number): StoredChunk {
  return {
    chunkId: id,
    source: `dm/${id}.md`,
    title: id,
    text: `text of ${id}`,
    entityId,
    entityName: entityId,
    entityType: 'character',
    ...(kankaId === undefined ? {} : { kankaId }),
  };
}

describe('LanceStore', () => {
  it('round-trips rows and ranks them by cosine similarity', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'lance-')), 'index');
    await LanceStore.write(dir, [
      { chunk: chunk('a', 'kanka-1', 1), vector: new Float32Array([1, 0, 0]) },
      { chunk: chunk('b', 'kanka-2'), vector: new Float32Array([0, 1, 0]) },
      { chunk: chunk('c', 'kanka-3'), vector: new Float32Array([0.7, 0.7, 0]) },
      // A single quote in the id exercises the escaping in byChunkId's `where` predicate: an
      // unescaped one would break out of the SQL string literal.
      { chunk: chunk("d'e", 'kanka-4'), vector: new Float32Array([0, 0, 1]) },
    ]);
    const store = await LanceStore.open(dir);
    try {
      const hits = await store.search(new Float32Array([1, 0, 0]), 2);
      expect(hits.map((hit) => hit.chunkId)).toEqual(['a', 'c']);
      expect(hits[0]!.score).toBeCloseTo(1, 3);
      expect(hits[0]!.kankaId).toBe(1);
      expect(hits[1]!.kankaId).toBeUndefined();

      expect((await store.byChunkId('b'))?.entityId).toBe('kanka-2');
      expect((await store.byChunkId('b'))?.text).toBe('text of b');
      expect(await store.byChunkId('missing')).toBeUndefined();
      expect((await store.byChunkId("d'e"))?.entityId).toBe('kanka-4');
    } finally {
      await store.close();
    }
  });
});
