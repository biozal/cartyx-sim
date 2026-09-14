import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownEntry } from '@cartyx-sim/core';
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
  endpoints: z.record(z.string(), Endpoint),
  seats: z.object({
    dm: SeatRef,
    /** Keyed by party member id. */
    players: z.record(z.string(), SeatRef),
  }),
});

export const DM_SEAT = 'dm';

export function playerSeat(pcId: string): string {
  return `player-${pcId}`;
}

export interface Campaign {
  id: string;
  dir: string;
  name: string;
  targetMinutes: number;
  loreCommit: string;
  party: Combatant[];
  /** Seat ids for the director. */
  seats: { dm: string; players: Record<string, string> };
  /** Model configuration per seat id, for the model client and `sim bench`. */
  models: Record<string, SeatConfigInput>;
}

function isNotFound(error: unknown): boolean {
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

async function loadParty(dir: string): Promise<Combatant[]> {
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
  for (const file of files) {
    const path = join(charactersDir, file);
    const parsed = Combatant.safeParse(await readJson(path, `${path} is missing`));
    if (!parsed.success) {
      throw new Error(`${path}: invalid character\n${z.prettifyError(parsed.error)}`);
    }
    if (parsed.data.kind !== 'pc') {
      throw new Error(`${path}: party members must have kind "pc", not "${parsed.data.kind}"`);
    }
    if (party.some((pc) => pc.id === parsed.data.id)) {
      throw new Error(`${path}: duplicate party member id "${parsed.data.id}"`);
    }
    party.push(parsed.data);
  }
  return party;
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
  const party = await loadParty(dir);

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
    seats: { dm: DM_SEAT, players },
    models,
  };
}
