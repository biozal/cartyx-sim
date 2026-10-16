import { readdir, readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { ownEntry, Persona, Premise } from '@cartyx-sim/core';
import { Endpoint, type SeatConfigInput } from '@cartyx-sim/models';
import { Combatant } from '@cartyx-sim/rules';
import { z } from 'zod';
import { campaignDir } from './paths';

const SeatRef = z.object({
  /** Name of an entry under `endpoints`. */
  endpoint: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  toolChoice: z.enum(['auto', 'required']).optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  fallbacks: z
    .array(z.object({ endpoint: z.string().min(1), model: z.string().min(1) }))
    .default([]),
});
type SeatRef = z.output<typeof SeatRef>;

/** `campaigns/<id>/campaign.json`. */
export const CampaignFile = z.object({
  name: z.string().min(1),
  targetMinutes: z.number().positive(),
  /** The lore version the campaign plays against. Plan 2B sets this from the lore repository. */
  loreCommit: z.string().min(1).default('unversioned'),
  /** Path to the cartyx-lore checkout, absolute or relative to the campaign directory. */
  lorePath: z.string().min(1).optional(),
  /** What world this campaign is set in. Injected at the top of the DM system prompt. */
  premise: Premise.optional(),
  /**
   * Minimum lore search score the DM is shown, overriding the engine's calibrated default
   * (`DEFAULT_LORE_THRESHOLD`). Scores are cosine similarities in [0, 1]. A campaign on a
   * different embedding model scores on a different scale, and this is how an operator retunes it
   * without editing engine source.
   */
  loreThreshold: z.number().min(0).max(1).optional(),
  endpoints: z.record(z.string(), Endpoint),
  seats: z.object({
    dm: SeatRef,
    /** Optional: reviews DM narration for playing the player characters. */
    checker: SeatRef.optional(),
    /** Optional: labels who speaks quotes in DM narration for `sim script`. Defaults to `checker`. */
    script: SeatRef.optional(),
    /** Embeds lore chunks and queries. Required when `lorePath` is set. */
    embed: SeatRef.optional(),
    /** Keyed by party member id. */
    players: z.record(z.string(), SeatRef),
  }),
});

export const DM_SEAT = 'dm';
export const CHECKER_SEAT = 'checker';
export const SCRIPT_SEAT = 'script';
export const EMBED_SEAT = 'embed';

export function playerSeat(pcId: string): string {
  return `player-${pcId}`;
}

export interface Campaign {
  id: string;
  dir: string;
  name: string;
  targetMinutes: number;
  loreCommit: string;
  /** Absolute path to the lore repository, when the campaign plays with lore. */
  lorePath?: string;
  /** Seat id for embeddings, present exactly when `lorePath` is. */
  embedSeat?: string;
  /** Overrides the engine's default lore relevance threshold, when the campaign sets one. */
  loreThreshold?: number;
  party: Combatant[];
  premise?: Premise;
  /** Personas by party member id, for the prompts and for `session_start`. */
  personas?: Record<string, Persona>;
  /** Seat ids for the director. */
  seats: { dm: string; players: Record<string, string>; checker?: string };
  /** Model configuration per seat id, for the model client and `sim bench`. */
  models: Record<string, SeatConfigInput>;
  /** The seat `sim script` labels quotes with: `script`, else `checker`, else none. */
  scriptSeat?: string;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readJson(path: string, missing: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw new Error(missing);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : error})`);
  }
}

async function loadParty(
  dir: string
): Promise<{ party: Combatant[]; personas: Record<string, Persona> }> {
  const charactersDir = join(dir, 'characters');
  let files: string[];
  try {
    files = (await readdir(charactersDir)).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    if (isNotFound(error)) files = [];
    else throw error;
  }
  if (files.length === 0) {
    throw new Error(`${charactersDir}: no character files. Add one <id>.json per party member.`);
  }
  const party: Combatant[] = [];
  // Entries rather than `personas[id] = ...`, for the same "__proto__" reason as `playerSeats` below.
  const personas: [string, Persona][] = [];
  for (const file of files) {
    const path = join(charactersDir, file);
    const raw = await readJson(path, `${path} is missing`);
    // Split persona off before Combatant.parse: Combatant is mechanical and shared with monsters,
    // and it is what lands in session_start.party.
    const { persona, ...mechanical } = (raw ?? {}) as Record<string, unknown>;
    const parsed = Combatant.safeParse(raw !== null && typeof raw === 'object' ? mechanical : raw);
    if (!parsed.success) {
      throw new Error(`${path}: invalid character\n${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.kind !== 'pc') {
      throw new Error(`${path}: party members must have kind "pc", not "${parsed.data.kind}"`);
    }
    if (party.some((pc) => pc.id === parsed.data.id)) {
      throw new Error(`${path}: duplicate party member id "${parsed.data.id}"`);
    }
    if (persona !== undefined) {
      const parsedPersona = Persona.safeParse(persona);
      if (!parsedPersona.success) {
        throw new Error(`${path}: invalid persona\n${z.prettifyError(parsedPersona.error)}`);
      }
      personas.push([parsed.data.id, parsedPersona.data]);
    }
    party.push(parsed.data);
  }
  return { party, personas: Object.fromEntries(personas) };
}

/** Loads and validates a campaign folder: its config, its party, and every seat's endpoints. */
export async function loadCampaign(campaignsDir: string, campaignId: string): Promise<Campaign> {
  const dir = campaignDir(campaignsDir, campaignId);
  const configPath = join(dir, 'campaign.json');
  const raw = await readJson(
    configPath,
    `${configPath} not found. Create it (see apps/cli/examples/local-campaign).`
  );
  const parsed = CampaignFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${configPath}: invalid campaign\n${z.prettifyError(parsed.error)}`);
  }
  const file = parsed.data;
  if (file.lorePath && file.loreCommit !== 'unversioned') {
    throw new Error(
      `${configPath}: loreCommit is derived from lorePath; remove it. The commit recorded in ` +
        `the log comes from the lore repository itself.`
    );
  }
  if (file.lorePath && !file.seats.embed) {
    throw new Error(
      `${configPath}: lorePath is set but seats.embed is missing. Add an embed seat, e.g. ` +
        `{"endpoint": "macbook", "model": "text-embedding-nomic-embed-text-v1.5"}.`
    );
  }
  if (!file.lorePath && file.seats.embed) {
    throw new Error(
      `${configPath}: seats.embed is set but lorePath is missing. Point lorePath at a ` +
        `cartyx-lore checkout, or remove the embed seat.`
    );
  }
  const { party, personas } = await loadParty(dir);

  const endpoint = (name: string, where: string) => {
    if (!Object.hasOwn(file.endpoints, name)) {
      const known = Object.keys(file.endpoints).join(', ') || 'none';
      throw new Error(
        `${configPath}: ${where} uses unknown endpoint "${name}". Defined endpoints: ${known}`
      );
    }
    return file.endpoints[name]!;
  };
  const resolve = (ref: SeatRef, where: string): SeatConfigInput => ({
    endpoint: endpoint(ref.endpoint, where),
    model: ref.model,
    temperature: ref.temperature,
    maxOutputTokens: ref.maxOutputTokens,
    timeoutMs: ref.timeoutMs,
    toolChoice: ref.toolChoice,
    reasoningEffort: ref.reasoningEffort,
    fallbacks: ref.fallbacks.map((fallback, index) => ({
      endpoint: endpoint(fallback.endpoint, `${where} fallback ${index + 1}`),
      model: fallback.model,
    })),
  });

  const partyIds = party.map((pc) => pc.id);
  const seatedIds = Object.keys(file.seats.players);
  const unseated = partyIds.filter((id) => !seatedIds.includes(id));
  if (unseated.length > 0) {
    throw new Error(`${configPath}: no seat under seats.players for ${unseated.join(', ')}`);
  }
  const strangers = seatedIds.filter((id) => !partyIds.includes(id));
  if (strangers.length > 0) {
    throw new Error(
      `${configPath}: seats.players lists ${strangers.join(', ')}, who ` +
        `${strangers.length === 1 ? 'is' : 'are'} not in characters/. Party: ${partyIds.join(', ')}`
    );
  }

  const models: Record<string, SeatConfigInput> = {
    [DM_SEAT]: resolve(file.seats.dm, 'seats.dm'),
  };
  if (file.seats.checker) models[CHECKER_SEAT] = resolve(file.seats.checker, 'seats.checker');
  if (file.seats.script) models[SCRIPT_SEAT] = resolve(file.seats.script, 'seats.script');
  if (file.seats.embed) models[EMBED_SEAT] = resolve(file.seats.embed, 'seats.embed');
  const scriptSeat = file.seats.script
    ? SCRIPT_SEAT
    : file.seats.checker
      ? CHECKER_SEAT
      : undefined;
  // Built as entries and turned into an object at the end, rather than assigning `players[pc.id]
  // = seat` in the loop: a party member id of "__proto__" would silently be dropped by that plain
  // assignment (the inherited `__proto__` setter ignores a non-object value) instead of becoming a
  // real, lookup-safe entry.
  const playerSeats: [string, string][] = [];
  for (const pc of party) {
    const seat = playerSeat(pc.id);
    // `ownEntry`, not bracket access: the seat-coverage check above already guarantees this is
    // present, but a config-supplied id must never be read by plain bracket access regardless.
    const ref = ownEntry(file.seats.players, pc.id);
    if (!ref) throw new Error(`${configPath}: no seat under seats.players for ${pc.id}`);
    models[seat] = resolve(ref, `seats.players.${pc.id}`);
    playerSeats.push([pc.id, seat]);
  }
  const players: Record<string, string> = Object.fromEntries(playerSeats);
  return {
    id: campaignId,
    dir,
    name: file.name,
    targetMinutes: file.targetMinutes,
    loreCommit: file.loreCommit,
    party,
    ...(file.premise ? { premise: file.premise } : {}),
    ...(Object.keys(personas).length > 0 ? { personas } : {}),
    seats: { dm: DM_SEAT, players, ...(file.seats.checker ? { checker: CHECKER_SEAT } : {}) },
    models,
    ...(scriptSeat ? { scriptSeat } : {}),
    ...(file.lorePath ? { lorePath: resolvePath(dir, file.lorePath) } : {}),
    ...(file.seats.embed ? { embedSeat: EMBED_SEAT } : {}),
    ...(file.loreThreshold === undefined ? {} : { loreThreshold: file.loreThreshold }),
  };
}
