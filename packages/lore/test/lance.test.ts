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
    ]);
    const store = await LanceStore.open(dir);
    try {
      const hits = await store.search(new Float32Array([1, 0, 0]), 2);
      expect(hits.map((hit) => hit.chunkId)).toEqual(['a', 'c']);
      expect(hits[0]!.score).toBeCloseTo(1, 3);
      expect(hits[0]!.kankaId).toBe(1);
      expect(hits[1]!.kankaId).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
