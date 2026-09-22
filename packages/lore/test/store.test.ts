import { describe, expect, it } from 'vitest';
import { cosineSimilarity, MemoryStore, type StoredChunk } from '../src/store';

function chunk(id: string, entityId: string): StoredChunk {
  return {
    chunkId: id,
    source: `dm/${id}.md`,
    title: id,
    text: `text of ${id}`,
    entityId,
    entityName: entityId,
    entityType: 'character',
  };
}

const rows = [
  { chunk: chunk('a', 'kanka-1'), vector: new Float32Array([1, 0, 0]) },
  { chunk: chunk('b', 'kanka-2'), vector: new Float32Array([0, 1, 0]) },
  { chunk: chunk('c', 'kanka-3'), vector: new Float32Array([0.7, 0.7, 0]) },
];

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 3]))).toBeCloseTo(0);
  });

  it('is 0 when either vector has no magnitude', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
  });
});

describe('MemoryStore', () => {
  it('returns chunks ranked by cosine similarity, limited', async () => {
    const store = new MemoryStore(rows);
    const hits = await store.search(new Float32Array([1, 0, 0]), 2);
    expect(hits.map((hit) => hit.chunkId)).toEqual(['a', 'c']);
    expect(hits[0]!.score).toBeCloseTo(1);
    expect(hits[0]!.entityId).toBe('kanka-1');
  });

  it('returns every row when the limit exceeds the row count', async () => {
    const store = new MemoryStore(rows);
    expect(await store.search(new Float32Array([1, 0, 0]), 99)).toHaveLength(3);
  });

  it('reads a chunk back by id, and nothing for an unknown id', async () => {
    const store = new MemoryStore(rows);
    expect((await store.byChunkId('b'))?.entityId).toBe('kanka-2');
    expect(await store.byChunkId('missing')).toBeUndefined();
  });
});
