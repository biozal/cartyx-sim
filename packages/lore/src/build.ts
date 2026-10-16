import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
  /** Display names that resolved to more than one Kanka entity, so `--check` can report them
   * without rebuilding. A `meta.json` written before this field existed simply lacks it; readers
   * must treat a missing value as `[]`, not as an absent-but-required field. */
  ambiguous: readonly string[];
}

/** The fields that decide staleness; `loreCommit` deliberately is not one of them. Nor is
 * `ambiguous`: an unresolved-name report changing never means the indexed content did. */
export type IndexIdentity = Omit<
  IndexMeta,
  'loreCommit' | 'files' | 'chunks' | 'builtAt' | 'ambiguous' | 'dims'
> & {
  /**
   * The embedding model's live dimension count, when the caller has measured it. `undefined`
   * means unmeasured, and an unmeasured dimension is not compared: the width of a vector is only
   * observable from an embedding response, and neither `sim index` nor a fresh `sim run` makes a
   * call before deciding whether to rebuild. Passing the index's own recorded `dims` back in here
   * would compare a value against itself and could never fire, so callers pass nothing instead.
   * A model swap is caught by `embedModel`; a same-model width change is caught by `sim bench`'s
   * embed trial (apps/cli/src/bench.ts).
   */
  dims?: number;
};

/**
 * Delays before each retry of a failed embedding batch, in milliseconds — three attempts in all.
 * A build sends ~200 requests for the real corpus over several minutes, and a single transient
 * HTTP hiccup at chunk 5,000 of 6,145 used to abort the whole run with no partial progress.
 * Shorter than the director's own `[1000, 4000, 15000]`: a session pauses for a human to fix the
 * seat, while a build is a batch job that should either get through or fail quickly.
 */
export const EMBED_RETRY_DELAYS_MS = [1000, 4000] as const;

export interface BuildOptions {
  lorePath: string;
  indexDir: string;
  embedder: Embedder;
  /** Which files under `lorePath` to index; defaults to every lore Markdown file. */
  include?: (relativePath: string) => boolean;
  log?: (line: string) => void;
  /** Overridden by tests; production uses `EMBED_RETRY_DELAYS_MS`. */
  retryDelaysMs?: readonly number[];
  /** Overridden by tests, so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
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
    (current.dims !== undefined && meta.dims !== current.dims) ||
    meta.documentPrefix !== current.documentPrefix ||
    meta.queryPrefix !== current.queryPrefix ||
    meta.chunkerVersion !== current.chunkerVersion
  );
}

/**
 * Staging and backup directories are keyed by pid, so a run that crashes leaves one behind that
 * a later run with a different pid would otherwise never remove, leaking a full copy of the
 * embeddings to disk indefinitely. This removes any such sibling of `indexDir` before a build
 * starts. It doesn't try to tell whether the owning pid is still alive: a concurrent second build
 * of the same index isn't a scenario this tool supports, and pid-liveness checks are their own
 * source of bugs.
 */
async function removeStaleSiblings(indexDir: string): Promise<void> {
  const parent = dirname(indexDir);
  const name = basename(indexDir);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    // Nothing to clean up when the parent doesn't exist yet, as on a first build.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(`${name}.tmp-`) || entry.name.startsWith(`${name}.backup-`)) {
      await rm(join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
  await removeStaleSiblings(options.indexDir);

  const log = options.log ?? (() => {});
  const files = await readLoreFiles(options.lorePath, options.include);
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

  if (chunks.length === 0) {
    throw new Error(
      `No lore chunks found under ${options.lorePath}. Check lorePath in campaign.json: it must ` +
        'point at a directory of markdown files (a typo in the path, or a checkout that has not ' +
        'been cloned yet, both look like this).'
    );
  }

  const delays = options.retryDelaysMs ?? EMBED_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const rows: { chunk: StoredChunk; vector: Float32Array }[] = [];
  for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
    const batch = chunks.slice(start, start + EMBED_BATCH);
    // The heading path travels with the body so a short section keeps its context.
    const texts = batch.map((chunk) => `${chunk.title}\n\n${chunk.text}`);
    // A bounded retry around each batch: the embedder itself sets `maxRetries: 0`, and losing a
    // multi-minute build to one transient 503 is the failure this exists to prevent. Every retry
    // is logged, so a build that takes unusually long says why.
    let vectors: Float32Array[] | undefined;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        vectors = await options.embedder.embedDocuments(texts);
        break;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log(
          `Embedding chunks ${start + 1}-${start + batch.length} failed (${message}); ` +
            `retrying in ${delay}ms (attempt ${attempt + 2} of ${delays.length + 1})`
        );
        await sleep(delay);
      }
    }
    batch.forEach((chunk, index) => rows.push({ chunk, vector: vectors![index]! }));
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
    ambiguous: entities.ambiguous,
  };

  // Build beside the target and rename, so an interrupted index leaves the previous one intact.
  const staging = `${options.indexDir}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await LanceStore.write(staging, rows);
  // meta.json last: a half-written index must never look valid.
  await writeFile(join(staging, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  await mkdir(dirname(options.indexDir), { recursive: true });

  // Swap so the target is never absent for longer than a single rename: move the old index
  // aside, put the new one in place, and only then delete. Deleting the old index first (as this
  // used to) means a crash during the recursive delete destroys the previous index AND orphans
  // the newly built one, which is the opposite of what staging exists to prevent.
  const backup = `${options.indexDir}.backup-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  let hadPrevious = false;
  try {
    await rename(options.indexDir, backup);
    hadPrevious = true;
  } catch (error) {
    // Nothing to move aside on a first build; any other failure is real.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(staging, options.indexDir);
  if (hadPrevious) await rm(backup, { recursive: true, force: true });

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
