import type { Embedder } from '@cartyx-sim/lore';
import { describe, expect, it } from 'vitest';
import { benchEmbedSeat, formatEmbedBench } from '../src/bench';

class FailingEmbedder implements Embedder {
  readonly model = 'broken';
  async embedDocuments(): Promise<Float32Array[]> {
    throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
  }
  async embedQuery(): Promise<Float32Array> {
    throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
  }
}

class WorkingEmbedder implements Embedder {
  readonly model = 'nomic';
  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(768));
  }
  async embedQuery(): Promise<Float32Array> {
    return new Float32Array(768);
  }
}

describe('benchEmbedSeat', () => {
  it('reports the dimension count on success', async () => {
    const result = await benchEmbedSeat(new WorkingEmbedder());
    expect(result).toMatchObject({ reachable: true, dims: 768, model: 'nomic', errors: [] });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the error and stays unreachable on failure', async () => {
    const result = await benchEmbedSeat(new FailingEmbedder());
    expect(result.reachable).toBe(false);
    expect(result.dims).toBeNull();
    expect(result.errors[0]).toContain('ECONNREFUSED');
  });

  it('prints a line naming the seat, model, and dimensions', async () => {
    const lines = formatEmbedBench(await benchEmbedSeat(new WorkingEmbedder()));
    expect(lines.join('\n')).toContain('nomic');
    expect(lines.join('\n')).toContain('768');
  });
});
