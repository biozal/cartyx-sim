import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LoreHit, LoreIndex } from '@cartyx-sim/core';
import { chunkMarkdown } from './chunk';
import { buildEntityIndex, resolveEntity } from './entities';
import { DOCUMENT_PREFIX, EMBED_BATCH, QUERY_PREFIX, type Embedder } from './embed';
import { contentDigest, readLoreFiles } from './ingest';
import { LanceStore } from './lance';
import type { ScoredChunk, StoredChunk, VectorStore } from './store';
import { loreVersion } from './version';

/** Bump when chunking or entity-resolution rules change, so old chunks are never reused. */
export const CHUNKER_VERSION = 1;

export interface IndexMeta {
  lorePath: string;
  loreCommit: string;
  contentDigest: string;
  embedModel: string;
  dims: number;
  documentPrefix: string;
  queryPrefix: string;
  chunkerVersion: number;
  files: number;
  chunks: number;
  builtAt: string;
}

/** The fields that decide staleness; `loreCommit` deliberately is not one of them. */
export type IndexIdentity = Omit<IndexMeta, 'loreCommit' | 'files' | 'chunks' | 'builtAt'>;

export interface BuildOptions {
  lorePath: string;
  indexDir: string;
  embedder: Embedder;
  log?: (line: string) => void;
}

export interface BuildResult {
  meta: IndexMeta;
  ambiguous: readonly string[];
}

const META_FILE = 'meta.json';

export async function readMeta(indexDir: string): Promise<IndexMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(indexDir, META_FILE), 'utf8')) as IndexMeta;
  } catch {
    return undefined;
  }
}

export function isStale(meta: IndexMeta | undefined, current: IndexIdentity): boolean {
  if (!meta) return true;
  return (
    meta.lorePath !== current.lorePath ||
    meta.contentDigest !== current.contentDigest ||
    meta.embedModel !== current.embedModel ||
    meta.dims !== current.dims ||
    meta.documentPrefix !== current.documentPrefix ||
    meta.queryPrefix !== current.queryPrefix ||
    meta.chunkerVersion !== current.chunkerVersion
  );
}

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => {});
  const files = await readLoreFiles(options.lorePath);
  log(`Read ${files.length} markdown files from ${options.lorePath}`);

  const entities = buildEntityIndex(files);
  const chunks: StoredChunk[] = [];
  for (const file of files) {
    for (const chunk of chunkMarkdown(file.path, file.text)) {
      chunks.push({
        chunkId: chunk.chunkId,
        source: chunk.source,
        title: chunk.title,
        text: chunk.text,
        ...resolveEntity(chunk, entities),
      });
    }
  }
  log(`Chunked into ${chunks.length} chunks across ${entities.byName.size} known entities`);

  const rows: { chunk: StoredChunk; vector: Float32Array }[] = [];
  for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
    const batch = chunks.slice(start, start + EMBED_BATCH);
    // The heading path travels with the body so a short section keeps its context.
    const vectors = await options.embedder.embedDocuments(
      batch.map((chunk) => `${chunk.title}\n\n${chunk.text}`)
    );
    batch.forEach((chunk, index) => rows.push({ chunk, vector: vectors[index]! }));
    log(`Embedded ${Math.min(start + EMBED_BATCH, chunks.length)}/${chunks.length}`);
  }

  const digest = contentDigest(files);
  const meta: IndexMeta = {
    lorePath: options.lorePath,
    loreCommit: await loreVersion(options.lorePath, digest),
    contentDigest: digest,
    embedModel: options.embedder.model,
    dims: rows[0]?.vector.length ?? 0,
    documentPrefix: DOCUMENT_PREFIX,
    queryPrefix: QUERY_PREFIX,
    chunkerVersion: CHUNKER_VERSION,
    files: files.length,
    chunks: chunks.length,
    builtAt: new Date().toISOString(),
  };

  // Build beside the target and rename, so an interrupted index leaves the previous one intact.
  const staging = `${options.indexDir}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await LanceStore.write(staging, rows);
  // meta.json last: a half-written index must never look valid.
  await writeFile(join(staging, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  await mkdir(dirname(options.indexDir), { recursive: true });
  await rm(options.indexDir, { recursive: true, force: true });
  await rename(staging, options.indexDir);

  return { meta, ambiguous: entities.ambiguous };
}

/** Wraps a store and an embedder as the engine's `LoreIndex`. */
export class LoreIndexImpl implements LoreIndex {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder
  ) {}

  async search(query: string, limit: number): Promise<LoreHit[]> {
    const vector = await this.embedder.embedQuery(query);
    // Exactly `limit`, as the interface promises. The over-fetching that feeds the entity
    // collapse happens in `lookup_lore`, which asks for a larger limit; doing it here too would
    // multiply the two factors together.
    const hits = await this.store.search(vector, limit);
    return hits.map(toLoreHit);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

function toLoreHit(hit: ScoredChunk): LoreHit {
  return {
    chunkId: hit.chunkId,
    source: hit.source,
    title: hit.title,
    text: hit.text,
    score: hit.score,
    entityId: hit.entityId,
    entityName: hit.entityName,
    entityType: hit.entityType,
    ...(hit.kankaId === undefined ? {} : { kankaId: hit.kankaId }),
  };
}

export async function openIndex(indexDir: string, embedder: Embedder): Promise<LoreIndexImpl> {
  return new LoreIndexImpl(await LanceStore.open(indexDir), embedder);
}
