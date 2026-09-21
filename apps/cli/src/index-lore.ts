import { join } from 'node:path';
import {
  buildIndex,
  CHUNKER_VERSION,
  contentDigest,
  DOCUMENT_PREFIX,
  isStale,
  loreVersion,
  OpenAICompatibleEmbedder,
  QUERY_PREFIX,
  readLoreFiles,
  readMeta,
  type Embedder,
  type IndexIdentity,
  type IndexMeta,
} from '@cartyx-sim/lore';
import { EMBED_SEAT, loadCampaign, type Campaign } from './campaign';

export interface IndexOptions {
  campaignsDir: string;
  campaign: string;
  force?: boolean;
  check?: boolean;
  log?: (line: string) => void;
  /** Injected by tests; production builds one from the campaign's embed seat. */
  embedder?: Embedder;
}

export interface IndexResult {
  indexDir: string;
  rebuilt: boolean;
  /**
   * Whether the index (`meta`) is out of date with the lore repo right now. Always `false` after
   * a rebuild. On `--check`, this is the answer the flag exists to give — `rebuilt` alone cannot
   * distinguish "confirmed fresh" from "stale, but you asked not to build".
   */
  stale: boolean;
  meta: IndexMeta | undefined;
  ambiguous: readonly string[];
  /** The lore version the repo is at right now, whether or not the index was rebuilt. */
  loreCommit: string;
  /**
   * Wall time spent inside `buildIndex`, in milliseconds. Set only when `rebuilt` is true — a
   * no-op run (`--check`, or an index already fresh) spent no build time to report.
   */
  buildMs: number | undefined;
}

/** The index is per lore checkout, not per session; `.cache` is git-ignored (v1 design §6.1). */
export function loreIndexDir(campaign: Campaign): string {
  return join(campaign.dir, '.cache', 'lore-index');
}

export function embedderFor(campaign: Campaign): Embedder {
  if (!campaign.embedSeat) {
    throw new Error(
      `Campaign "${campaign.id}" has no embed seat. Add lorePath and seats.embed to campaign.json.`
    );
  }
  const seat = campaign.models[EMBED_SEAT];
  if (!seat) throw new Error(`Campaign "${campaign.id}" has no model for seat "${EMBED_SEAT}".`);
  return new OpenAICompatibleEmbedder(
    { endpoint: seat.endpoint, model: seat.model },
    { timeoutMs: seat.timeoutMs }
  );
}

function requireLorePath(campaign: Campaign): string {
  if (!campaign.lorePath) {
    throw new Error(
      `Campaign "${campaign.id}" has no lorePath. Point it at a cartyx-lore checkout in ` +
        `campaign.json to index lore.`
    );
  }
  return campaign.lorePath;
}

export async function currentIdentity(
  campaign: Campaign,
  embedder: Embedder,
  dims: number | undefined
): Promise<{ identity: IndexIdentity; loreCommit: string }> {
  const lorePath = requireLorePath(campaign);
  const files = await readLoreFiles(lorePath);
  const digest = contentDigest(files);
  return {
    identity: {
      lorePath,
      contentDigest: digest,
      embedModel: embedder.model,
      // The dimension count is only known after an embedding call, so compare against whatever the
      // existing index recorded: a model swap is already caught by `embedModel`.
      dims: dims ?? 0,
      documentPrefix: DOCUMENT_PREFIX,
      queryPrefix: QUERY_PREFIX,
      chunkerVersion: CHUNKER_VERSION,
    },
    loreCommit: await loreVersion(lorePath, digest),
  };
}

/** Builds the index if it is missing or stale; returns the existing one otherwise. */
export async function ensureIndex(options: IndexOptions): Promise<IndexResult> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const lorePath = requireLorePath(campaign);
  const embedder = options.embedder ?? embedderFor(campaign);
  const indexDir = loreIndexDir(campaign);
  const existing = await readMeta(indexDir);
  const { identity, loreCommit } = await currentIdentity(campaign, embedder, existing?.dims);
  // Whether the index is actually out of date with the lore repo, independent of `--force`: this
  // is what `--check` reports, and `--force` must not make an honestly-fresh index look stale.
  const stale = isStale(existing, identity);
  if (options.check) {
    return {
      indexDir,
      rebuilt: false,
      stale,
      meta: existing,
      ambiguous: existing?.ambiguous ?? [],
      loreCommit,
      buildMs: undefined,
    };
  }
  const shouldRebuild = options.force === true || stale;
  if (!shouldRebuild && existing) {
    return {
      indexDir,
      rebuilt: false,
      stale: false,
      meta: existing,
      ambiguous: existing.ambiguous ?? [],
      loreCommit,
      buildMs: undefined,
    };
  }
  const buildStarted = Date.now();
  const built = await buildIndex({ lorePath, indexDir, embedder, log: options.log });
  return {
    indexDir,
    rebuilt: true,
    stale: false,
    meta: built.meta,
    ambiguous: built.ambiguous,
    loreCommit: built.meta.loreCommit,
    buildMs: Date.now() - buildStarted,
  };
}

export async function runIndex(options: IndexOptions): Promise<IndexResult> {
  return ensureIndex(options);
}

export function formatIndexSummary(result: IndexResult): string[] {
  const lines: string[] = [];
  if (!result.meta) {
    lines.push(`No lore index at ${result.indexDir}. Run \`sim index\` to build one.`);
    lines.push(`Lore is at ${result.loreCommit}.`);
    return lines;
  }
  const meta = result.meta;
  if (!result.rebuilt && result.stale) {
    lines.push(
      `Index is stale (indexed ${meta.loreCommit}, lore is now ${result.loreCommit}). ` +
        'Run `sim index` to rebuild.'
    );
  } else {
    // Only a rebuild spent real build time; a fresh/--check result must never report one it
    // didn't spend, so `duration` stays empty outside `result.rebuilt`.
    const duration =
      result.rebuilt && result.buildMs !== undefined
        ? ` in ${(result.buildMs / 1000).toFixed(1)}s`
        : '';
    lines.push(
      `${result.rebuilt ? 'Built' : 'Index is fresh:'} ${meta.chunks} chunk${
        meta.chunks === 1 ? '' : 's'
      } from ${meta.files} file${meta.files === 1 ? '' : 's'}${duration} (${meta.embedModel}, ${meta.dims} dims)`
    );
    lines.push(`Lore commit: ${meta.loreCommit}`);
  }
  lines.push(`Index: ${result.indexDir}`);
  if (result.ambiguous.length > 0) {
    lines.push('');
    lines.push(
      `${result.ambiguous.length} ambiguous entity name${
        result.ambiguous.length === 1 ? '' : 's'
      } fell back to a path id (two Kanka entities share each name):`
    );
    for (const name of result.ambiguous) lines.push(`  ${name}`);
  }
  return lines;
}
