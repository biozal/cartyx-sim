import { join } from 'node:path';
import { applyEvent, initialState, spokenMinutes, type SimEvent } from '@cartyx-sim/core';
import { writeFilesAtomic } from './atomic-write';
import { JsonlFileSink } from './jsonl-sink';
import { sessionDir } from './paths';

/** Bumped when the audit's shape changes, so stored reports stay comparable across sessions. */
export const AUDIT_VERSION = 1;

export interface GapCluster {
  topic: string;
  count: number;
  queries: { query: string; seq: number }[];
}

export interface InventionEntry {
  seq: number;
  fact: string;
  reason: string;
  query?: string;
  narrationSeq?: number;
  narration?: string;
  /** Where in the spoken session the supported narration falls. */
  spokenMinutes?: number;
}

export interface CoverageEntry {
  entityId: string;
  entityName: string;
  entityType: string;
  lookups: number;
}

export interface NpcEntry {
  npcId: string;
  name: string;
  loreEntityId?: string;
  invented: boolean;
}

export interface SceneEntry {
  seq: number;
  location: string;
  loreEntityId?: string;
}

export interface Contradiction {
  seq: number;
  narration: string;
  chunkIds: string[];
  note: string;
}

export interface Audit {
  auditVersion: number;
  campaign: string;
  session: number;
  loreCommit: string;
  gaps: GapCluster[];
  inventions: InventionEntry[];
  coverage: CoverageEntry[];
  npcs: NpcEntry[];
  scenes: SceneEntry[];
  /** null when the checker pass did not run; the report says why. */
  contradictions: Contradiction[] | null;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'is',
  'are',
  'was',
  'were',
  'who',
  'what',
  'where',
  'when',
  'why',
  'how',
  'does',
  'do',
  'did',
  'to',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'with',
  'about',
]);

export function normalizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const shared = new Set(b.filter((word) => left.has(word))).size;
  const smaller = Math.min(left.size, new Set(b).size);
  return smaller === 0 ? 0 : shared / smaller;
}

/**
 * Greedy clustering: a query joins the first cluster whose seed query it shares half or more of
 * the smaller token set with. Good enough to group "the Old Stone Bridge" with "Old Stone Bridge
 * history" without pretending to be topic modelling.
 */
export function clusterGaps(gaps: readonly { query: string; seq: number }[]): GapCluster[] {
  const clusters: { tokens: string[]; entries: { query: string; seq: number }[] }[] = [];
  for (const gap of gaps) {
    const tokens = normalizeQuery(gap.query);
    const existing = clusters.find((cluster) => overlap(cluster.tokens, tokens) >= 0.5);
    if (existing) existing.entries.push(gap);
    else clusters.push({ tokens, entries: [gap] });
  }
  return clusters
    .map((cluster) => ({
      topic: cluster.tokens.join(' '),
      count: cluster.entries.length,
      queries: cluster.entries,
    }))
    .sort((a, b) => b.count - a.count || a.queries[0]!.seq - b.queries[0]!.seq);
}

export function buildAudit(input: {
  campaign: string;
  session: number;
  events: readonly SimEvent[];
}): Omit<Audit, 'contradictions'> {
  const { events } = input;
  const start = events.find(
    (event): event is Extract<SimEvent, { type: 'session_start' }> => event.type === 'session_start'
  );

  // Fold the log the way the engine does, so the spoken-minute mark on an invention comes from
  // the same `spokenWords` the session clock steered by — not a second word count that could
  // drift from it.
  const narrations = new Map<number, string>();
  const spokenAt = new Map<number, number>();
  let state = initialState();
  for (const event of events) {
    state = applyEvent(state, event);
    if (event.type === 'narration') {
      narrations.set(event.seq, event.text);
      spokenAt.set(event.seq, spokenMinutes(state));
    }
  }

  const gapEntries: { query: string; seq: number }[] = [];
  const coverage = new Map<string, CoverageEntry>();
  for (const event of events) {
    if (event.type !== 'lore_lookup') continue;
    if (event.used.length === 0) {
      gapEntries.push({ query: event.query, seq: event.seq });
      continue;
    }
    // One count per lookup per entity: two chunks of the same NPC are one use of that NPC.
    const seen = new Set<string>();
    for (const hit of event.hits) {
      if (!event.used.includes(hit.chunkId)) continue;
      // A log written before Plan 2B has no entity id; the chunk id is the best key it offers.
      const entityId = hit.entityId ?? hit.chunkId;
      if (seen.has(entityId)) continue;
      seen.add(entityId);
      const existing = coverage.get(entityId);
      if (existing) existing.lookups++;
      else
        coverage.set(entityId, {
          entityId,
          entityName: hit.entityName ?? hit.chunkId,
          // The event records an entity's id and name but not its type, so the audit does not
          // claim one. `sim index`'s meta has types if a richer report ever needs them.
          entityType: 'unknown',
          lookups: 1,
        });
    }
  }

  const inventions: InventionEntry[] = events
    .filter((event) => event.type === 'lore_invention')
    .map((event) => ({
      seq: event.seq,
      fact: event.fact,
      reason: event.reason,
      ...(event.query === undefined ? {} : { query: event.query }),
      ...(event.narrationSeq === undefined ? {} : { narrationSeq: event.narrationSeq }),
      ...(event.narrationSeq !== undefined && narrations.has(event.narrationSeq)
        ? {
            narration: narrations.get(event.narrationSeq)!,
            spokenMinutes: spokenAt.get(event.narrationSeq)!,
          }
        : {}),
    }));

  const npcs: NpcEntry[] = events
    .filter((event) => event.type === 'npc_introduced')
    .map((event) => ({
      npcId: event.npcId,
      name: event.name,
      ...(event.loreEntityId === undefined ? {} : { loreEntityId: event.loreEntityId }),
      // The DM's own declaration, not a guess from whether a lore entity got attached: the two
      // are independent questions (an NPC can be linked to lore yet still be marked invented).
      invented: event.invented,
    }));

  const scenes: SceneEntry[] = events
    .filter((event) => event.type === 'scene_change')
    .map((event) => ({
      seq: event.seq,
      location: event.location,
      ...(event.loreEntityId === undefined ? {} : { loreEntityId: event.loreEntityId }),
    }));

  return {
    auditVersion: AUDIT_VERSION,
    campaign: input.campaign,
    session: input.session,
    loreCommit: start?.loreCommit ?? 'unknown',
    gaps: clusterGaps(gapEntries),
    inventions,
    coverage: [...coverage.values()].sort((a, b) => b.lookups - a.lookups),
    npcs,
    scenes,
  };
}

export function renderAuditMarkdown(audit: Audit): string {
  const lines: string[] = [
    `# Lore audit — ${audit.campaign} session ${audit.session}`,
    '',
    `**Lore commit:** ${audit.loreCommit}`,
    '',
    '## Gaps',
    '',
  ];
  if (audit.gaps.length === 0) lines.push('No lookup came back empty.', '');
  for (const cluster of audit.gaps) {
    lines.push(`### ${cluster.topic || '(no keywords)'} — ${cluster.count}`, '');
    for (const entry of cluster.queries) lines.push(`- \`${entry.query}\` (seq ${entry.seq})`);
    lines.push('');
  }

  lines.push('## Inventions', '');
  if (audit.inventions.length === 0) lines.push('Nothing was invented.', '');
  for (const invention of audit.inventions) {
    lines.push(`### seq ${invention.seq}`, '');
    lines.push(`**Fact:** ${invention.fact}`, '');
    lines.push(`**Why:** ${invention.reason}`, '');
    if (invention.query) lines.push(`**After looking up:** \`${invention.query}\``, '');
    if (invention.narration) {
      const at =
        invention.spokenMinutes === undefined
          ? ''
          : ` at ${invention.spokenMinutes.toFixed(1)} spoken min`;
      lines.push(`**Supports (seq ${invention.narrationSeq}${at}):** ${invention.narration}`, '');
    } else {
      lines.push('**Supports:** no narration in that turn.', '');
    }
  }

  lines.push('## Coverage', '');
  if (audit.coverage.length === 0) lines.push('No lore was used.', '');
  else {
    lines.push('| entity | id | lookups |', '| --- | --- | --- |');
    for (const entry of audit.coverage) {
      lines.push(`| ${entry.entityName} | \`${entry.entityId}\` | ${entry.lookups} |`);
    }
    lines.push('');
  }
  lines.push(
    `NPCs introduced: ${audit.npcs.length} (${audit.npcs.filter((npc) => npc.invented).length} invented).`,
    '',
    `Scenes: ${audit.scenes.length} (${audit.scenes.filter((scene) => scene.loreEntityId).length} tied to lore).`,
    ''
  );

  lines.push('## Possible contradictions', '');
  if (audit.contradictions === null) {
    lines.push('Skipped: no checker seat, no lore index, or `--no-model` was passed.', '');
  } else if (audit.contradictions.length === 0) {
    lines.push('The checker found none.', '');
  } else {
    for (const finding of audit.contradictions) {
      lines.push(`- **seq ${finding.seq}** — ${finding.note}`);
      lines.push(`  > ${finding.narration}`);
      lines.push(`  Chunks: ${finding.chunkIds.map((id) => `\`${id}\``).join(', ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export interface AuditOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  /**
   * Whether a model-driven contradiction check should run. Reserved for the checker pass that a
   * later task adds to `buildAudit`'s output; until then `contradictions` is always `null`
   * regardless of this flag, and the report says why.
   */
  useModel: boolean;
  log?: (line: string) => void;
}

export interface AuditResult {
  auditPath: string;
  markdownPath: string;
  audit: Audit;
}

/**
 * Builds `audit.md` and `audit.json` for one session from its event log, which it never modifies
 * and which is the *only* thing it reads: no lore index, no network, so an audit still runs long
 * after the lore has moved on, against a log played months ago.
 */
export async function runAudit(options: AuditOptions): Promise<AuditResult> {
  const log = options.log ?? (() => {});
  const dir = sessionDir(options.campaignsDir, options.campaign, options.session);
  const eventsPath = join(dir, 'events.jsonl');
  const sink = new JsonlFileSink(eventsPath);
  if (!(await sink.exists())) throw new Error(`No event log at ${eventsPath}.`);
  const stalePid = await sink.acquireLock();
  if (stalePid !== undefined) {
    log(
      `Replaced a stale lock from process ${stalePid}, which is no longer running: ${eventsPath}.lock`
    );
  }
  let events: SimEvent[];
  try {
    events = await sink.readAll();
    if (sink.tornTail) {
      log(
        `Ignoring an incomplete final line (line ${sink.tornTail.line}) left by an interrupted ` +
          `write: ${eventsPath}`
      );
    }
  } finally {
    await sink.releaseLock();
  }

  const built = buildAudit({ campaign: options.campaign, session: options.session, events });
  // No checker pass exists yet (a later task adds it), so a report from this build never claims
  // to have checked for contradictions.
  const audit: Audit = { ...built, contradictions: null };

  const auditPath = join(dir, 'audit.json');
  const markdownPath = join(dir, 'audit.md');
  // audit.json last, so its rename is the durable signal that both outputs are complete.
  await writeFilesAtomic([
    { path: markdownPath, content: renderAuditMarkdown(audit) },
    { path: auditPath, content: `${JSON.stringify(audit, null, 2)}\n` },
  ]);
  return { auditPath, markdownPath, audit };
}

/** The lines to print after `runAudit` finishes: counts for each section and both output paths. */
export function formatAuditSummary(result: AuditResult): string[] {
  const { audit } = result;
  const gapQueries = audit.gaps.reduce((sum, cluster) => sum + cluster.count, 0);
  const contradictions =
    audit.contradictions === null
      ? 'skipped'
      : `${audit.contradictions.length} contradiction${audit.contradictions.length === 1 ? '' : 's'}`;
  return [
    `Gaps: ${gapQueries} empty lookup${gapQueries === 1 ? '' : 's'} in ${audit.gaps.length} topic${audit.gaps.length === 1 ? '' : 's'}`,
    `Inventions: ${audit.inventions.length}`,
    `Entities covered: ${audit.coverage.length}`,
    `Contradictions: ${contradictions}`,
    `Report: ${result.markdownPath}`,
    `Data: ${result.auditPath}`,
  ];
}
