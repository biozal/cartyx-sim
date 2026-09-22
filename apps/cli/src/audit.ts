import { join } from 'node:path';
import {
  applyEvent,
  findJsonReply,
  initialState,
  spokenMinutes,
  type ModelClient,
  type SimEvent,
} from '@cartyx-sim/core';
import { LanceStore, readMeta } from '@cartyx-sim/lore';
import { OpenAICompatibleModelClient } from '@cartyx-sim/models';
import { writeFilesAtomic } from './atomic-write';
import { loadCampaign } from './campaign';
import { loreIndexDir } from './index-lore';
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
  /** Present exactly when `contradictions` is null: which condition kept the pass from running. */
  contradictionsSkipped?: string;
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

/** Bump when the prompt changes, so a stored audit says which prompt produced it. */
export const CONTRADICTION_PROMPT_VERSION = 1;

// A thinking model sometimes spends its whole budget thinking; retry that once on the same target.
const INCOMPLETE_REPLY_ATTEMPTS = 2;

const CONTRADICTION_SYSTEM = [
  "You compare a game master's narration against the world lore they just looked up for it.",
  'Reply with only a JSON object: {"conflicts": boolean, "note": string}.',
  'Set "conflicts" to true only when the narration states something the lore directly',
  'contradicts: a different name, role, place, fact, or outcome than the lore gives.',
  'Detail the lore simply does not mention is NOT a conflict — the game master is always allowed',
  'to add new detail to the world. Only flag a genuine contradiction, never an addition.',
  'When conflicts is true, keep "note" to one sentence stating what the lore actually says.',
  'When conflicts is false, "note" should be an empty string.',
].join('\n');

/**
 * One pass over the narrations that followed a lore lookup with usable hits. A narration after a
 * gap has nothing to contradict, so it is not asked about — which also keeps the pass to a handful
 * of calls a session. Only the first narration after each lookup is checked: later ones have
 * drifted away from what was retrieved, and asking about each would multiply the calls for little
 * signal. Every finding is "possible": the prompt asks the checker to flag only a genuine
 * contradiction, never detail the lore simply omits.
 */
export async function findContradictions(input: {
  events: readonly SimEvent[];
  model: ModelClient;
  seat: string;
  /** Re-fetches a chunk's text by id: the event log records ids and scores, never the text. */
  chunkText: (chunkId: string) => Promise<string | undefined>;
}): Promise<Contradiction[]> {
  const found: Contradiction[] = [];
  let pending: { turnId: string; chunkIds: string[] } | undefined;
  for (const event of input.events) {
    // Spec §7.4 item 4: the narrations that followed a lore lookup with usable hits *in the same
    // turn*. A DM turn that looks lore up and then hands off without narrating must not have its
    // chunks paired with whatever the next turn happens to narrate — those chunk ids are
    // persisted into `audit.json` as the evidence behind a finding, and evidence from another
    // turn is evidence the narration was never written against.
    if (pending && event.turnId !== pending.turnId) pending = undefined;
    if (event.type === 'lore_lookup') {
      const used = event.hits.filter((hit) => event.used.includes(hit.chunkId));
      pending =
        used.length === 0
          ? undefined
          : { turnId: event.turnId, chunkIds: used.map((hit) => hit.chunkId) };
      continue;
    }
    if (event.type !== 'narration' || !pending) continue;
    const chunkIds = pending.chunkIds;
    pending = undefined;

    // The log records chunk ids and scores, never the text. Bare ids tell the checker nothing, so
    // the chunks are re-fetched from the index; a chunk the index no longer holds (the lore moved
    // on since the session) is simply left out. `resolvedIds` — not `chunkIds` — is what a finding
    // records, so it never claims a chunk as evidence that the checker was never actually shown.
    const resolvedIds: string[] = [];
    const texts: string[] = [];
    for (const chunkId of chunkIds) {
      const text = await input.chunkText(chunkId);
      if (text !== undefined) {
        resolvedIds.push(chunkId);
        texts.push(`[${chunkId}] ${text}`);
      }
    }
    if (texts.length === 0) continue;

    let reply;
    try {
      reply = await input.model.complete({
        seat: input.seat,
        turnId: `audit-${event.seq}`,
        messages: [
          { role: 'system', content: CONTRADICTION_SYSTEM },
          {
            role: 'user',
            content: `Lore the game master retrieved:\n${texts.join('\n\n')}\n\nNarration:\n${event.text}`,
          },
        ],
        tools: [],
        toolChoice: 'auto',
        incompleteReplyAttempts: INCOMPLETE_REPLY_ATTEMPTS,
      });
    } catch {
      // A seat failure degrades this section, not the whole audit: skip this narration and keep
      // going, the way `attribution.ts` degrades quote labeling to rules on a seat failure.
      continue;
    }

    const parsed = findJsonReply(reply.text, (value) => {
      if (typeof value !== 'object' || value === null) return null;
      const record = value as { conflicts?: unknown; note?: unknown };
      if (typeof record.conflicts !== 'boolean') return null;
      return {
        conflicts: record.conflicts,
        note: typeof record.note === 'string' ? record.note : '',
      };
    });
    // An unparseable reply skips the narration rather than failing the audit.
    if (!parsed || !parsed.conflicts) continue;

    found.push({ seq: event.seq, narration: event.text, chunkIds: resolvedIds, note: parsed.note });
  }
  return found;
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
    const reason =
      audit.contradictionsSkipped ?? 'no checker seat, no lore index, or `--no-model` was passed';
    lines.push(`Skipped: ${reason}.`, '');
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
   * Whether the model-driven contradiction check should run. Even when true, the pass only runs
   * if the campaign also has a `checker` seat and a lore index exists; `contradictions` stays
   * `null` otherwise, and the report says which condition was missing.
   */
  useModel: boolean;
  log?: (line: string) => void;
  /** Injected by tests; production builds one from the campaign's checker seat. */
  model?: ModelClient;
}

export interface AuditResult {
  auditPath: string;
  markdownPath: string;
  audit: Audit;
}

/** What `contradictionPass` decided, and why, so `runAudit` can both log and persist the reason. */
interface ContradictionPassResult {
  contradictions: Contradiction[] | null;
  /** Present exactly when `contradictions` is null. */
  skipped?: string;
}

/**
 * Runs the contradiction checker when `useModel` is true, the campaign has a `checker` seat, and
 * a lore index exists — otherwise returns `contradictions: null` with the reason, after logging
 * it. Anything this section does can fail instead: a malformed `campaign.json`, a checker seat
 * pointing at an endpoint the client refuses to construct, or an IO error, corruption, or lock
 * contention with a concurrent `sim index` while the store is open. Every one of those must
 * degrade this section exactly like a missing index does, not fail the whole audit: the other
 * three sections read only the event log and are meant to stay usable long after the lore has
 * moved on, so nothing here can take them down with it. Hence the whole body is inside the try.
 * The lore index, once opened, is always closed before returning, whichever outcome happens.
 */
async function contradictionPass(
  options: AuditOptions,
  events: readonly SimEvent[],
  log: (line: string) => void
): Promise<ContradictionPassResult> {
  const skip = (reason: string): ContradictionPassResult => {
    log(`Possible contradictions: skipped (${reason}).`);
    return { contradictions: null, skipped: reason };
  };
  if (!options.useModel) return skip('--no-model was passed');
  let store: LanceStore | undefined;
  try {
    // Everything this section needs is inside the try, including loading the campaign and
    // constructing the model client: a malformed `campaign.json` or a bad checker endpoint is a
    // reason to degrade this section, exactly like a missing index, never a reason to fail an
    // audit whose first three sections were already computed from the event log alone.
    const campaign = await loadCampaign(options.campaignsDir, options.campaign);
    const seat = campaign.seats.checker;
    if (!seat) return skip('campaign.json has no checker seat');
    const indexDir = loreIndexDir(campaign);
    const meta = await readMeta(indexDir);
    if (!meta) {
      return skip(`no lore index at ${indexDir}; run \`sim index --campaign ${campaign.id}\``);
    }
    const model = options.model ?? new OpenAICompatibleModelClient(campaign.models);
    store = await LanceStore.open(indexDir);
    const openedStore = store;
    const contradictions = await findContradictions({
      events,
      model,
      seat,
      chunkText: async (chunkId) => (await openedStore.byChunkId(chunkId))?.text,
    });
    return { contradictions };
  } catch (error) {
    // Deliberately broad — anything this section touches degrades it rather than failing the
    // audit — and therefore deliberately vague about the cause. The reason is persisted into
    // `audit.json` as `contradictionsSkipped` and printed into `audit.md`, so naming the lore
    // index here would send someone to debug an index over, say, a `TypeError` from a refactor.
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.SIM_DEBUG === '1' && error instanceof Error && error.stack) log(error.stack);
    return skip(`the contradiction pass failed (${message})`);
  } finally {
    await store?.close();
  }
}

/**
 * Builds `audit.md` and `audit.json` for one session from its event log, which it never modifies.
 * The first three sections read only that log: no lore index, no network, so an audit still runs
 * long after the lore has moved on, against a log played months ago. The fourth section, possible
 * contradictions, is the exception — it needs the campaign's checker seat and lore index, and is
 * skipped (not failed) when either is unavailable.
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
  const { contradictions, skipped } = await contradictionPass(options, events, log);
  const audit: Audit = {
    ...built,
    contradictions,
    ...(skipped === undefined ? {} : { contradictionsSkipped: skipped }),
  };

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
