import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelTarget } from '@cartyx-sim/models';
import { embed, embedMany } from 'ai';
import { createHash } from 'node:crypto';

/**
 * nomic-embed-text was trained with task prefixes, and retrieval quality drops sharply without
 * them. They are recorded in the index metadata, so changing one marks the index stale.
 */
export const DOCUMENT_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';

/** Chunks per embeddings request while indexing. */
export const EMBED_BATCH = 32;

export interface Embedder {
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  readonly model: string;
}

const PROVIDER_NAME = 'cartyx-sim-lore';

export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly target: ModelTarget;

  constructor(target: ModelTarget, options: { timeoutMs?: number } = {}) {
    this.target = target;
    this.model = target.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private embeddingModel() {
    const provider = createOpenAICompatible({
      name: PROVIDER_NAME,
      baseURL: this.target.endpoint.baseURL,
      apiKey: this.target.endpoint.apiKey,
    });
    return provider.textEmbeddingModel(this.target.model);
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    const { embeddings } = await embedMany({
      model: this.embeddingModel(),
      values: texts.map((text) => `${DOCUMENT_PREFIX}${text}`),
      // The caller owns retries and pausing, as it does for chat seats: `buildIndex` retries a
      // failed batch (build.ts), and the director's seat-failure path covers a query at run time.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    });
    return embeddings.map((vector) => Float32Array.from(vector));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const { embedding } = await embed({
      model: this.embeddingModel(),
      value: `${QUERY_PREFIX}${text}`,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    });
    return Float32Array.from(embedding);
  }
}

/**
 * A deterministic hash-based embedder for tests. It has no semantic meaning — identical text gives
 * an identical vector and different text a different one, which is all the wiring tests need.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedder';

  constructor(private readonly dims = 768) {}

  private vector(text: string): Float32Array {
    const out = new Float32Array(this.dims);
    for (let index = 0; index < this.dims; index++) {
      const digest = createHash('sha256').update(`${index}:${text}`).digest();
      // Map the first two bytes to [-1, 1] so vectors spread across the space.
      out[index] = (digest.readUInt16BE(0) / 0xffff) * 2 - 1;
    }
    return out;
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }
}
