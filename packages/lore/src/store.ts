import type { ChunkEntity } from './entities';

/** A chunk as it sits in the index: its text, where it came from, and the entity it describes. */
export interface StoredChunk extends ChunkEntity {
  chunkId: string;
  source: string;
  title: string;
  text: string;
}

export interface ScoredChunk extends StoredChunk {
  /** Cosine similarity in [0, 1], matching the sense of the engine's `loreThreshold`. */
  score: number;
}

export interface VectorStore {
  search(vector: Float32Array, limit: number): Promise<ScoredChunk[]>;
  /**
   * Reads one chunk by id. `sim audit` needs it because the event log records chunk ids and
   * scores but never the chunk text, so a contradiction check has to fetch the text back.
   */
  byChunkId(chunkId: string): Promise<StoredChunk | undefined>;
  close(): Promise<void>;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The store the tests use: no LanceDB, no native addon, no I/O. */
export class MemoryStore implements VectorStore {
  constructor(private readonly rows: readonly { chunk: StoredChunk; vector: Float32Array }[]) {}

  async search(vector: Float32Array, limit: number): Promise<ScoredChunk[]> {
    return this.rows
      .map((row) => ({ ...row.chunk, score: cosineSimilarity(vector, row.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async byChunkId(chunkId: string): Promise<StoredChunk | undefined> {
    return this.rows.find((row) => row.chunk.chunkId === chunkId)?.chunk;
  }

  async close(): Promise<void> {}
}
