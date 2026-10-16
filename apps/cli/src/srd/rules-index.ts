import { join } from 'node:path';
import {
  buildIndex,
  CHUNKER_VERSION,
  contentDigest,
  DOCUMENT_PREFIX,
  isStale,
  loreVersion,
  QUERY_PREFIX,
  readLoreFiles,
  readMeta,
  type Embedder,
  type IndexIdentity,
} from '@cartyx-sim/lore';
import { loadCampaign } from '../campaign';
import { embedderFor, type IndexResult } from '../index-lore';
import { SRD_DIR } from './build';

/** The SRD's area files: Markdown outside the vendored `source/`, except the folder's README. */
export function isRulesFile(relativePath: string): boolean {
  const path = relativePath.replaceAll('\\', '/');
  return path.endsWith('.md') && path !== 'README.md' && !path.startsWith('source/');
}

/** `data/.cache/srd-index`: beside the rules, git-ignored, shared by every campaign. */
export function rulesIndexDir(): string {
  return join(SRD_DIR, '..', '.cache', 'srd-index');
}

export interface RulesIndexOptions {
  campaignsDir: string;
  campaign: string;
  force?: boolean;
  check?: boolean;
  log?: (line: string) => void;
  embedder?: Embedder;
  /** Overridden by tests. */
  srdDir?: string;
  /** Overridden by tests. */
  indexDir?: string;
}

/**
 * Builds the rules index when it is missing or stale (or `force`), and reports it otherwise. The
 * campaign supplies only the embed seat; the index is kept apart from every campaign's lore index
 * so a lore lookup never returns rules text.
 */
export async function ensureRulesIndex(options: RulesIndexOptions): Promise<IndexResult> {
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  const embedder = options.embedder ?? embedderFor(campaign);
  const srdDir = options.srdDir ?? SRD_DIR;
  const indexDir = options.indexDir ?? rulesIndexDir();
  const existing = await readMeta(indexDir);
  const digest = contentDigest(await readLoreFiles(srdDir, isRulesFile));
  const identity: IndexIdentity = {
    lorePath: srdDir,
    contentDigest: digest,
    embedModel: embedder.model,
    documentPrefix: DOCUMENT_PREFIX,
    queryPrefix: QUERY_PREFIX,
    chunkerVersion: CHUNKER_VERSION,
  };
  const loreCommit = await loreVersion(srdDir, digest);
  const stale = isStale(existing, identity);
  if (options.check || (existing && !stale && options.force !== true)) {
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
  const started = Date.now();
  const built = await buildIndex({
    lorePath: srdDir,
    indexDir,
    embedder,
    include: isRulesFile,
    log: options.log,
  });
  return {
    indexDir,
    rebuilt: true,
    stale: false,
    meta: built.meta,
    ambiguous: built.ambiguous,
    loreCommit: built.meta.loreCommit,
    buildMs: Date.now() - started,
  };
}
