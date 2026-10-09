import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_LORE_THRESHOLD,
  ownEntry,
  personaLoreQuery,
  LORE_RESULT_LIMIT,
  rankLoreHits,
  type LoreHit,
  type ModelClient,
} from '@cartyx-sim/core';
import { openIndex, type Embedder } from '@cartyx-sim/lore';
import { OpenAICompatibleModelClient, type SeatConfigInput } from '@cartyx-sim/models';
import { writeFileAtomic } from './atomic-write';
import { loadCampaign, type Campaign } from './campaign';
import { embedderFor, ensureIndex } from './index-lore';
import { campaignDir } from './paths';

export interface PrepOptions {
  campaignsDir: string;
  campaign: string;
  session: number;
  /** Pin the opening location by name; without it, the DM seat chooses near `premise.region`. */
  location?: string;
  /** Overwrite an existing outline. */
  force?: boolean;
  log?: (line: string) => void;
  /** Injected by tests; production builds one from the campaign's seats. */
  model?: ModelClient;
  /** Injected by tests; production builds one from the campaign's embed seat. */
  embedder?: Embedder;
}

export interface PrepResult {
  path: string;
  location: string;
  locationEntityId: string;
  chunkIds: string[];
}

/** Bump when the prompts below change in a way that changes what an outline looks like. */
export const PREP_PROMPT_VERSION = 3;

/** How many hits a pinned `--location` search reads. */
const LOCATION_LIMIT = 10;
/** How many hits the region search reads when the DM seat chooses the location. */
const CANDIDATE_LIMIT = 20;
const INCOMPLETE_REPLY_ATTEMPTS = 2;
/** How many chunks describe the opening location: its own, then the rest of what its name finds. */
const PLACE_CHUNK_LIMIT = 8;
/**
 * How many of those may be the location entity's own. A well-covered entity found by a region
 * search can bring more than the whole cap, which would crowd out the DM write-up about the same
 * place: the failure the place search exists to fix.
 */
const OWN_CHUNK_LIMIT = PLACE_CHUNK_LIMIT / 2;
/** How many entities each PC's persona brings in, after the place's chunks are taken out. */
const PARTY_CHUNK_LIMIT = 5;
/**
 * The DM seat's output floor for the outline. A session's DM turn is short, so seats are sized for
 * that; an outline is several times longer, and a reasoning model spends part of the limit
 * thinking first. At a 4000-token seat limit qwen3.6 ran out before finishing, twice.
 */
export const PREP_MAX_OUTPUT_TOKENS = 16000;

const CHOOSE_SYSTEM =
  'You are preparing a tabletop role-playing session. Choose the opening location from the ' +
  'list you are given. Reply with exactly one name from the list and nothing else.';

const OUTLINE_SYSTEM =
  'You are the game master preparing a tabletop role-playing session. Write a session outline ' +
  'in markdown with these sections: "## Hook", "## Scenes" (3 to 5 scenes), "## NPCs" (each ' +
  'with a motive), "## Secrets and Clues", and "## Likely Endings". The session opens at the ' +
  'location given. Use only places and people the lore supports: when the lore names someone ' +
  'who fits a role, use that person, under the exact name the lore gives, rather than inventing ' +
  'one. Invent a minor named character only when no one in the lore fits. Places work the same ' +
  'way: name a place only as the lore names it, and describe any other spot plainly (an orchard ' +
  'row, a side corridor) instead of coining a proper name for it, since during play the DM ' +
  'looks such names up and finds nothing. Reply with the outline only.';

/** Where a session's outline lives. Zero-padded to three digits, like the session log paths. */
export function prepPath(campaignsDir: string, campaign: string, session: number): string {
  const dir = campaignDir(campaignsDir, campaign);
  if (!Number.isSafeInteger(session) || session < 1) {
    throw new Error(`Session number must be a positive integer, got ${session}`);
  }
  return join(dir, 'prep', `session-${String(session).padStart(3, '0')}.md`);
}

/**
 * The outline's machine-readable header. Only the header is parsed: the body is prose for the
 * model and the operator, and nothing structural depends on parsing model-written text.
 *
 * Hand-rolled rather than a YAML dependency: the header is five known keys, and this project
 * prefers JSON for anything that needs a real parser.
 */
export function parsePrepHeader(
  markdown: string
): { location: string; locationEntityId: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const location = fields.get('location');
  const locationEntityId = fields.get('locationEntityId');
  // A malformed header is not a half-usable one: the engine needs both or neither.
  if (!location || !locationEntityId) return undefined;
  return { location, locationEntityId };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The reply's candidate: an exact name first, else the longest name the reply mentions. */
function namedCandidate(reply: string, names: string[]): string | undefined {
  const exact = names.find((name) => sameName(name, reply));
  if (exact) return exact;
  const lower = reply.toLowerCase();
  return names
    .filter((name) => lower.includes(name.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
}

function noLocationError(queries: string[], threshold: number): Error {
  const tried = queries.map((query) => `"${query}"`).join(', ');
  return new Error(
    `No lore entity cleared the relevance threshold (${threshold}) for ${tried}. sim prep ` +
      'will not invent an opening location; pass --location with a place the lore describes.'
  );
}

/** The Kanka type of a place, as `packages/lore`'s entity index records it. */
const LOCATION_TYPE = 'location';

/**
 * The hits that are places, when any are; otherwise every hit, so a lore repository whose only
 * match is a DM write-up typed `document` can still be prepped. Best first, by score.
 */
function placesFirst(hits: readonly LoreHit[]): LoreHit[] {
  const places = hits.filter((hit) => hit.entityType === LOCATION_TYPE);
  return [...(places.length > 0 ? places : hits)].sort((a, b) => b.score - a.score);
}

/**
 * The opening location, always a hit that came out of the index, and a place whenever one clears
 * the threshold. With `--location`, the entity with that name (a place before any other type),
 * else the best-scoring place; without, the DM seat's pick among the places near the premise
 * region, else the best-scoring one. Exported for tests.
 */
export async function chooseLocation(input: {
  campaign: Campaign;
  search: (query: string, limit: number) => Promise<LoreHit[]>;
  threshold: number;
  location?: string;
  model: ModelClient;
  log: (line: string) => void;
}): Promise<{ hit: LoreHit; hits: LoreHit[] }> {
  const { campaign, threshold } = input;
  if (input.location !== undefined) {
    const pinned = input.location;
    const hits = (await input.search(pinned, LOCATION_LIMIT)).filter(
      (hit) => hit.score >= threshold
    );
    const pool = placesFirst(hits);
    // The operator's exact name is intent, so it is honoured even when only a non-place has it.
    const named =
      pool.find((h) => sameName(h.entityName, pinned)) ??
      placesFirst(hits.filter((h) => sameName(h.entityName, pinned)))[0];
    const hit = named ?? pool[0];
    if (!hit) throw noLocationError([pinned], threshold);
    if (!named) {
      input.log(
        `No lore entity is named "${pinned}"; opening at the best match, ${hit.entityName}.`
      );
    } else if (hit.entityType !== LOCATION_TYPE) {
      input.log(
        `"${hit.entityName}" is a ${hit.entityType}, not a location; opening there anyway.`
      );
    }
    return { hit, hits };
  }

  const anchor = campaign.premise?.region ?? campaign.premise?.world ?? campaign.name;
  const hits = (await input.search(anchor, CANDIDATE_LIMIT)).filter(
    (hit) => hit.score >= threshold
  );
  if (hits.length === 0) throw noLocationError([anchor], threshold);
  // Keyed by entity id, so two entities that share a name stay two candidates. Best first, so the
  // first hit per entity is that entity's best, and the first per name is the name's best entity.
  const candidates = new Map<string, LoreHit>();
  for (const hit of placesFirst(hits)) {
    if (!candidates.has(hit.entityId)) candidates.set(hit.entityId, hit);
  }
  const best = [...candidates.values()];
  // The DM chooses by name; a name shared by several entities means its best-scoring one.
  const names = [...new Set(best.map((hit) => hit.entityName))];
  const reply = await input.model.complete({
    seat: campaign.seats.dm,
    turnId: `prep-v${PREP_PROMPT_VERSION}-choose`,
    messages: [
      { role: 'system', content: CHOOSE_SYSTEM },
      {
        role: 'user',
        content:
          `Region: ${anchor}\n\nChoose one opening location:\n` +
          names.map((name) => `- ${name}`).join('\n'),
      },
    ],
    // No tools, so the seat answers in prose even when it is configured to require a tool call.
    tools: [],
    toolChoice: 'auto',
    incompleteReplyAttempts: INCOMPLETE_REPLY_ATTEMPTS,
  });
  const chosen = namedCandidate(reply.text, names);
  if (!chosen) {
    input.log(
      `The DM seat named none of the candidates; opening at the best match, ${best[0]!.entityName}.`
    );
  }
  const hit = chosen ? best.find((candidate) => candidate.entityName === chosen)! : best[0]!;
  return { hit, hits };
}

/**
 * The campaign's models with the DM seat's output limit raised to at least
 * {@link PREP_MAX_OUTPUT_TOKENS}, for prep only: a session still plays at the configured limit.
 * Exported for tests.
 */
export function prepModels(campaign: Campaign): Record<string, SeatConfigInput> {
  const dm = campaign.models[campaign.seats.dm];
  if (!dm) return campaign.models;
  const maxOutputTokens = Math.max(dm.maxOutputTokens ?? 0, PREP_MAX_OUTPUT_TOKENS);
  return { ...campaign.models, [campaign.seats.dm]: { ...dm, maxOutputTokens } };
}

export interface PrepLore {
  /** The opening location's own chunks first, then the best of what a search on its name finds. */
  place: LoreHit[];
  /** Per PC with a persona, the entities that persona's prose finds, its tied entities promoted. */
  party: { name: string; hits: LoreHit[] }[];
}

/**
 * The lore the outline is written from. Not just the location entity's chunks: a place's Kanka
 * entry can be a two-line stub while the DM write-up about it is a separate entity per section,
 * and a DM who is shown neither the write-up nor the people the PCs are tied to invents a cast.
 * The party lookups use the director's query and ranking, so the outline is written from what the
 * session will retrieve, but keep fewer entities per PC and put the authored ties first, so a tie
 * that scored low is not the one the cap cuts. Exported for tests.
 */
export async function gatherPrepLore(input: {
  campaign: Campaign;
  search: (query: string, limit: number) => Promise<LoreHit[]>;
  threshold: number;
  location: LoreHit;
  /** The hits the location was chosen from, so its own chunks are kept even if a re-search misses. */
  locationHits: readonly LoreHit[];
}): Promise<PrepLore> {
  const { campaign, threshold, location } = input;
  const own = input.locationHits
    .filter((hit) => hit.entityId === location.entityId)
    .sort((a, b) => b.score - a.score)
    .slice(0, OWN_CHUNK_LIMIT);
  const named = (await input.search(location.entityName, PLACE_CHUNK_LIMIT * 2))
    .filter((hit) => hit.score >= threshold)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const place: LoreHit[] = [];
  for (const hit of [...own, ...named]) {
    if (place.length >= PLACE_CHUNK_LIMIT) break;
    if (seen.has(hit.chunkId)) continue;
    seen.add(hit.chunkId);
    place.push(hit);
  }

  const party: PrepLore['party'] = [];
  const personas = campaign.personas ?? {};
  for (const pc of campaign.party) {
    const persona = ownEntry(personas, pc.id);
    if (!persona) continue;
    const query = personaLoreQuery(persona);
    if (query === '') continue;
    // As many candidates as the director reads, so prep sees every tie the session would.
    const hits = await input.search(query, LORE_RESULT_LIMIT * 4);
    const ties = new Set(persona.loreEntityIds ?? []);
    const { used } = rankLoreHits(hits, threshold, ties);
    const unseen = used.filter((hit) => !seen.has(hit.chunkId));
    const fresh = [
      ...unseen.filter((hit) => ties.has(hit.entityId)),
      ...unseen.filter((hit) => !ties.has(hit.entityId)),
    ].slice(0, PARTY_CHUNK_LIMIT);
    for (const hit of fresh) seen.add(hit.chunkId);
    if (fresh.length > 0) party.push({ name: pc.name, hits: fresh });
  }
  return { place, party };
}

function renderChunk(chunk: LoreHit): string {
  return `[${chunk.chunkId}] ${chunk.text}`;
}

function outlinePrompt(campaign: Campaign, location: LoreHit, lore: PrepLore): string {
  const premise = campaign.premise;
  const premiseLines = [
    premise?.world && `World: ${premise.world}`,
    premise?.region && `Region: ${premise.region}`,
    premise?.party && `Party: ${premise.party}`,
    premise?.tone && `Tone: ${premise.tone}`,
  ].filter((line): line is string => Boolean(line));
  const party = campaign.party.map((pc) => {
    const motivation = campaign.personas
      ? ownEntry(campaign.personas, pc.id)?.motivation
      : undefined;
    return `- ${pc.name}${motivation ? `: ${motivation}` : ''}`;
  });
  return [
    `Campaign: ${campaign.name}`,
    ...premiseLines,
    '',
    `Opening location: ${location.entityName}`,
    '',
    'Lore for the opening location:',
    ...lore.place.map(renderChunk),
    '',
    'Party:',
    ...party,
    ...lore.party.flatMap(({ name, hits }) => [
      '',
      `Lore tied to ${name}:`,
      ...hits.map(renderChunk),
    ]),
  ].join('\n');
}

/** A header value on one line: a CR or LF inside it would end the field and break the header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

function header(session: number, location: LoreHit, chunkIds: string[]): string {
  return [
    '---',
    `session: ${session}`,
    `location: ${oneLine(location.entityName)}`,
    `locationEntityId: ${oneLine(location.entityId)}`,
    `loreChunkIds: [${chunkIds.join(', ')}]`,
    `generatedAt: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
}

/**
 * Writes `campaigns/<id>/prep/session-NNN.md`: an outline whose opening location is a real
 * indexed lore entity, under a header the engine reads. Fails rather than inventing a location
 * when nothing in the index clears the relevance threshold.
 */
export async function runPrep(options: PrepOptions): Promise<PrepResult> {
  const log = options.log ?? (() => {});
  const campaign = await loadCampaign(options.campaignsDir, options.campaign);
  if (!campaign.lorePath) {
    throw new Error('campaign.json has no lorePath; sim prep needs a lore repository');
  }
  const path = prepPath(options.campaignsDir, options.campaign, options.session);
  if (!options.force && (await exists(path))) {
    throw new Error(`${path} already exists. Pass --force to overwrite it.`);
  }
  const model = options.model ?? new OpenAICompatibleModelClient(prepModels(campaign));
  const embedder = options.embedder ?? embedderFor(campaign);
  // Build or refresh the index first, as `runSession` does: a missing index would otherwise fail
  // with an opaque LanceDB error, and a stale one could offer an entity the next `sim run`'s
  // rebuilt index no longer contains, which is exactly the invented location prep exists to stop.
  const built = await ensureIndex({
    campaignsDir: options.campaignsDir,
    campaign: options.campaign,
    embedder,
    log,
  });
  if (built.rebuilt) log(`Rebuilt the lore index: ${built.indexDir}`);
  const index = await openIndex(built.indexDir, embedder);
  try {
    const threshold = campaign.loreThreshold ?? DEFAULT_LORE_THRESHOLD;
    const { hit, hits } = await chooseLocation({
      campaign,
      search: (query, limit) => index.search(query, limit),
      threshold,
      location: options.location,
      model,
      log,
    });
    const lore = await gatherPrepLore({
      campaign,
      search: (query, limit) => index.search(query, limit),
      threshold,
      location: hit,
      locationHits: hits,
    });
    const chunkIds = [...lore.place, ...lore.party.flatMap((pc) => pc.hits)].map(
      (chunk) => chunk.chunkId
    );
    const reply = await model.complete({
      seat: campaign.seats.dm,
      turnId: `prep-v${PREP_PROMPT_VERSION}-outline`,
      messages: [
        { role: 'system', content: OUTLINE_SYSTEM },
        { role: 'user', content: outlinePrompt(campaign, hit, lore) },
      ],
      tools: [],
      toolChoice: 'auto',
      incompleteReplyAttempts: INCOMPLETE_REPLY_ATTEMPTS,
    });
    const body = reply.text.trim();
    if (!body) throw new Error(`The DM seat returned an empty outline; nothing was written.`);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${header(options.session, hit, chunkIds)}\n${body}\n`);
    return {
      path,
      location: oneLine(hit.entityName),
      locationEntityId: oneLine(hit.entityId),
      chunkIds,
    };
  } finally {
    // Never leak a LanceDB connection, for the same reason `runSession` closes its index.
    await index.close();
  }
}

/** The lines to print after `runPrep` finishes, in the style of `formatIndexSummary`. */
export function formatPrepSummary(result: PrepResult): string[] {
  return [
    `Opening location: ${result.location} (${result.locationEntityId})`,
    `Lore chunks: ${result.chunkIds.length}`,
    `Outline: ${result.path}`,
  ];
}
