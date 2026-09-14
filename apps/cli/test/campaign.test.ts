import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign';

const EXAMPLE = fileURLToPath(new URL('../examples/local-campaign', import.meta.url));

const KIRA = {
  id: 'kira',
  name: 'Kira Vale',
  kind: 'pc',
  level: 3,
  abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
  proficiencyBonus: 2,
  ac: 15,
  maxHp: 24,
  hp: 24,
};

function character(overrides: Record<string, unknown>) {
  return { ...KIRA, ...overrides };
}

/** A fresh config each call, so a test can change it without affecting the others. */
function config() {
  return {
    name: 'Test',
    targetMinutes: 30,
    endpoints: {
      studio: { baseURL: 'http://10.0.0.2:1234/v1' },
      ampere: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
    },
    seats: {
      dm: {
        endpoint: 'studio',
        model: 'big-dm',
        fallbacks: [{ endpoint: 'ampere', model: 'backup-dm' }],
      },
      players: {
        kira: { endpoint: 'ampere', model: 'player-model', toolChoice: 'auto' },
      } as Record<string, unknown>,
    },
  };
}

describe('loadCampaign', () => {
  let campaignsDir: string;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-campaign-'));
  });

  afterEach(async () => {
    await rm(campaignsDir, { recursive: true, force: true });
  });

  /** Writes objects as JSON; a string is written as-is, for malformed files. */
  async function writeCampaign(campaign: unknown, characters: Record<string, unknown>) {
    const json = (value: unknown) =>
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const dir = join(campaignsDir, 'test');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'campaign.json'), json(campaign));
    for (const [file, value] of Object.entries(characters)) {
      await writeFile(join(dir, 'characters', file), json(value));
    }
  }

  it('loads the shipped example campaign', async () => {
    await cp(EXAMPLE, join(campaignsDir, 'local-campaign'), { recursive: true });
    const campaign = await loadCampaign(campaignsDir, 'local-campaign');
    expect(campaign.party.map((pc) => pc.id)).toEqual(['kira', 'tomas']);
    expect(campaign.seats).toEqual({
      dm: 'dm',
      players: { kira: 'player-kira', tomas: 'player-tomas' },
    });
    expect(campaign.models.dm).toMatchObject({
      endpoint: { baseURL: 'http://127.0.0.1:1234/v1' },
    });
    expect(campaign.loreCommit).toBe('unversioned');
  });

  it('resolves endpoints, fallbacks, and seat options', async () => {
    await writeCampaign(config(), { 'kira.json': KIRA });
    const campaign = await loadCampaign(campaignsDir, 'test');
    expect(campaign).toMatchObject({ name: 'Test', targetMinutes: 30 });
    expect(campaign.models).toEqual({
      dm: {
        endpoint: { baseURL: 'http://10.0.0.2:1234/v1' },
        model: 'big-dm',
        fallbacks: [
          {
            endpoint: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
            model: 'backup-dm',
          },
        ],
      },
      'player-kira': {
        endpoint: { baseURL: 'http://10.0.0.3:8080/v1', apiKey: 'secret' },
        model: 'player-model',
        toolChoice: 'auto',
        fallbacks: [],
      },
    });
  });

  it('names an unknown endpoint and where it is used', async () => {
    const campaign = config();
    campaign.seats.dm.fallbacks[0]!.endpoint = 'nowhere';
    await writeCampaign(campaign, { 'kira.json': KIRA });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'seats.dm fallback 1 uses unknown endpoint "nowhere". Defined endpoints: studio, ampere'
    );
  });

  it('requires a seat for every party member and no extra seats', async () => {
    await writeCampaign(config(), {
      'kira.json': KIRA,
      'tomas.json': character({ id: 'tomas' }),
    });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'no seat under seats.players for tomas'
    );

    const extraSeat = config();
    extraSeat.seats.players.kira2 = { endpoint: 'studio', model: 'm' };
    await writeCampaign(extraSeat, { 'kira.json': KIRA });
    await rm(join(campaignsDir, 'test', 'characters', 'tomas.json'));
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'seats.players lists kira2, who is not in characters/'
    );
  });

  it('handles a character id of "constructor" like any other id, not a prototype property', async () => {
    const withConstructorSeat = config();
    withConstructorSeat.seats.players = {
      constructor: { endpoint: 'ampere', model: 'player-model', toolChoice: 'auto' },
    };
    await writeCampaign(withConstructorSeat, {
      'constructor.json': character({ id: 'constructor' }),
    });
    const campaign = await loadCampaign(campaignsDir, 'test');
    expect(campaign.party.map((pc) => pc.id)).toEqual(['constructor']);
    expect(campaign.seats.players).toEqual({ constructor: 'player-constructor' });
    expect(campaign.models['player-constructor']).toMatchObject({ model: 'player-model' });

    // A "constructor"-named character with no matching seat fails with the normal message,
    // rather than a plain bracket lookup silently resolving to a built-in property.
    await writeCampaign(config(), {
      'constructor.json': character({ id: 'constructor' }),
    });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'no seat under seats.players for constructor'
    );
  });

  it('reports an invalid character file by path', async () => {
    await writeCampaign(config(), { 'kira.json': character({ ac: 'nope' }) });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      `${join(campaignsDir, 'test', 'characters', 'kira.json')}: invalid character`
    );
  });

  it('reports malformed JSON by path', async () => {
    await writeCampaign('{ "name": "Test", }', { 'kira.json': KIRA });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      `${join(campaignsDir, 'test', 'campaign.json')}: invalid JSON`
    );
  });

  it('only accepts player characters in the party', async () => {
    await writeCampaign(config(), { 'kira.json': character({ kind: 'npc' }) });
    await expect(loadCampaign(campaignsDir, 'test')).rejects.toThrow(
      'party members must have kind "pc", not "npc"'
    );
  });

  it('explains a missing campaign.json', async () => {
    await expect(loadCampaign(campaignsDir, 'absent')).rejects.toThrow(
      'campaign.json not found. Create it (see apps/cli/examples/local-campaign).'
    );
  });

  it('rejects an unsafe campaign id', async () => {
    await expect(loadCampaign(campaignsDir, '../escape')).rejects.toThrow(
      'must be lowercase letters, digits, and dashes'
    );
  });
});
