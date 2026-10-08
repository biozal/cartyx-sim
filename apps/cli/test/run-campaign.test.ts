import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder, type SimEvent } from '@cartyx-sim/core';
import { FakeEmbedder, LanceStore, readMeta } from '@cartyx-sim/lore';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCampaign } from '../src/campaign';
import { loreIndexDir } from '../src/index-lore';
import { JsonlFileSink } from '../src/jsonl-sink';
import { sessionEventsPath } from '../src/paths';
import { directorConfig, runSession } from '../src/run';

async function readEvents(eventsPath: string) {
  return new JsonlFileSink(eventsPath).readAll();
}

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

function campaignJson(baseURL: string): string {
  return JSON.stringify({
    name: 'Live test',
    targetMinutes: 0.12,
    endpoints: { local: { baseURL } },
    seats: {
      dm: { endpoint: 'local', model: 'dm-model', temperature: 0.7 },
      players: { kira: { endpoint: 'local', model: 'player-model' } },
    },
  });
}

describe('runSession with campaign model seats', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-live-'));
    let dmCalls = 0;
    fake = await startFakeOpenAIServer((body) => {
      if (body.tools === undefined) return { text: '{"violations": []}' };
      const tools = (body.tools ?? []).map((entry) => entry.function.name);
      if (tools.includes('speak')) {
        return { toolCalls: [{ name: 'speak', arguments: { text: 'Who turned off the wards?' } }] };
      }
      dmCalls++;
      return dmCalls === 1
        ? {
            toolCalls: [
              {
                name: 'scene_change',
                arguments: { location: 'Crystal Engine Lab', artPrompt: 'A humming lab' },
              },
              { name: 'narrate', arguments: { text: 'The lab lights flicker as you arrive.' } },
              { name: 'hand_off', arguments: { target: { kind: 'open' } } },
            ],
          }
        : {
            toolCalls: [
              {
                name: 'narrate',
                arguments: { text: 'A shadow slips out the east door, leaving frost behind.' },
              },
              {
                name: 'scene_change',
                arguments: { location: 'East Corridor', artPrompt: 'A frosted corridor' },
              },
              { name: 'hand_off', arguments: { target: { kind: 'party' } } },
            ],
          };
    });
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'campaign.json'), campaignJson(fake.baseURL));
    await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA));
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('plays a session against the configured OpenAI-compatible endpoints', async () => {
    const lines: string[] = [];
    const result = await runSession({
      campaignsDir,
      campaign: 'live',
      session: 1,
      resume: false,
      log: (line) => lines.push(line),
    });

    expect(result.status).toBe('ended');
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    expect(events.map((event) => event.type)).toEqual([
      'session_start',
      'scene_change',
      'narration',
      'hand_off',
      'turn_end',
      // The DM's scene_change makes the engine fetch lore for the new location.
      'lore_lookup',
      'dialogue',
      'turn_end',
      'narration',
      'scene_change',
      'hand_off',
      'turn_end',
      'session_end',
    ]);
    expect(lines).toContain('Kira Vale: "Who turned off the wards?"');
    expect(fake.requests.map((request) => request.model)).toEqual([
      'dm-model',
      'player-model',
      'dm-model',
    ]);
    expect(fake.requests[0]).toMatchObject({ temperature: 0.7, tool_choice: 'required' });
    await expect(stat(`${result.eventsPath}.lock`)).rejects.toThrow();
  });

  it('rejects an invalid campaign before creating a lock or log', async () => {
    await writeFile(join(campaignsDir, 'live', 'campaign.json'), '{ "name": "Broken" }');
    await expect(
      runSession({ campaignsDir, campaign: 'live', session: 1, resume: false })
    ).rejects.toThrow('invalid campaign');
    await expect(stat(join(campaignsDir, 'live', 'sessions'))).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  it('checks DM narration with a configured checker seat', async () => {
    const dir = join(campaignsDir, 'checked');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(
      join(dir, 'campaign.json'),
      JSON.stringify({
        name: 'Checked',
        targetMinutes: 0.12,
        endpoints: { local: { baseURL: fake.baseURL } },
        seats: {
          dm: { endpoint: 'local', model: 'dm-model' },
          checker: { endpoint: 'local', model: 'dm-model', reasoningEffort: 'none' },
          players: { kira: { endpoint: 'local', model: 'player-model' } },
        },
      })
    );
    await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA));

    const result = await runSession({
      campaignsDir,
      campaign: 'checked',
      session: 1,
      resume: false,
    });

    expect(result.status).toBe('ended');
    const checks = fake.requests.filter((request) => request.tools === undefined);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]).toMatchObject({ reasoning_effort: 'none' });
  });
});

describe('runSession --resume against a campaign', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  const KIRA_COMBATANT = makeCombatant({ id: 'kira', name: 'Kira Vale' });
  const SEED_NOW = () => new Date('2026-01-01T00:00:00.000Z');
  // Well over the ~3.45-word hard-stop threshold for the 0.02-minute target below, so kira's own
  // speech alone (with the DM never called again) is enough to end the resumed session.
  const KIRA_SPEECH = 'I raise my hammer high and charge straight at the crumbling wall.';

  /**
   * Seeds a log as if a session had started, the DM set a scene, and handed off to the party —
   * then the process was interrupted before anyone answered. A resume should pick up exactly here.
   */
  async function seedShortSession(campaign: string, targetMinutes: number): Promise<void> {
    const recorder = new TurnRecorder(initialState(), 'seed', SEED_NOW);
    recorder.emit({
      type: 'session_start',
      schemaVersion: 1,
      session: 1,
      loreCommit: 'unversioned',
      targetMinutes,
      party: [KIRA_COMBATANT],
    });
    recorder.emit({
      type: 'scene_change',
      location: 'Old Ruins',
      artPrompt: 'Crumbling stone ruins under moonlight',
    });
    recorder.emit({ type: 'hand_off', target: { kind: 'party' }, responders: ['kira'] });
    recorder.emit({ type: 'turn_end', actor: 'dm' });
    await new JsonlFileSink(sessionEventsPath(campaignsDir, campaign, 1)).append(recorder.events);
  }

  const PLAYER_SEAT = { endpoint: 'local', model: 'player-model' };

  async function writeCampaignJson(
    campaign: string,
    players: Record<string, typeof PLAYER_SEAT>
  ): Promise<void> {
    await writeFile(
      join(campaignsDir, campaign, 'campaign.json'),
      JSON.stringify({
        name: 'Resume test',
        targetMinutes: 0.02,
        endpoints: { local: { baseURL: fake.baseURL } },
        seats: { dm: { endpoint: 'local', model: 'dm-model' }, players },
      })
    );
  }

  async function writeCharacter(campaign: string, id: string, name: string): Promise<void> {
    await mkdir(join(campaignsDir, campaign, 'characters'), { recursive: true });
    await writeFile(
      join(campaignsDir, campaign, 'characters', `${id}.json`),
      JSON.stringify({ ...KIRA, id, name })
    );
  }

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-resume-'));
    fake = await startFakeOpenAIServer((body) => {
      const tools = (body.tools ?? []).map((entry) => entry.function.name);
      if (tools.includes('speak')) {
        return { toolCalls: [{ name: 'speak', arguments: { text: KIRA_SPEECH } }] };
      }
      // Not expected: kira's own speech already pushes the short session past its target, so the
      // very next step ends it before any DM beat runs. A safety net in case that ever changes.
      return { toolCalls: [{ name: 'hand_off', arguments: { target: { kind: 'party' } } }] };
    });
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('continues from the log with the same campaign', async () => {
    await writeCharacter('resume-a', 'kira', 'Kira Vale');
    await writeCampaignJson('resume-a', { kira: PLAYER_SEAT });
    await seedShortSession('resume-a', 0.02);

    const result = await runSession({
      campaignsDir,
      campaign: 'resume-a',
      session: 1,
      resume: true,
    });

    expect(result.status).toBe('ended');
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    expect(events.map((event) => event.type)).toEqual([
      'session_start',
      'scene_change',
      'hand_off',
      'turn_end',
      'ooc_note',
      'dialogue',
      'turn_end',
      'session_end',
    ]);
    // The seeded events are untouched, not replayed or rewritten.
    expect(events.slice(0, 4)).toMatchObject([
      { type: 'session_start' },
      { type: 'scene_change', location: 'Old Ruins' },
      { type: 'hand_off' },
      { type: 'turn_end', actor: 'dm' },
    ]);
    expect(events[4]).toMatchObject({ type: 'ooc_note', text: 'Session resumed.' });
    expect(events.at(-1)).toMatchObject({ type: 'session_end', reason: 'hard_stop' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.model).toBe('player-model');
  });

  it('keeps the logged targetMinutes on --resume with a changed value, and notes the override', async () => {
    await writeCharacter('resume-b', 'kira', 'Kira Vale');
    await writeCampaignJson('resume-b', { kira: PLAYER_SEAT });
    await seedShortSession('resume-b', 0.02);

    const result = await runSession({
      campaignsDir,
      campaign: 'resume-b',
      session: 1,
      resume: true,
      targetMinutes: 30,
    });

    expect(result.status).toBe('ended');
    const events = await new JsonlFileSink(result.eventsPath).readAll();
    const overrideNote = events.find(
      (event) => event.type === 'ooc_note' && event.text.includes('targetMinutes')
    );
    expect(overrideNote).toMatchObject({
      text: expect.stringContaining(
        'Ignoring the configured targetMinutes override (30); the session already logged ' +
          'targetMinutes 0.02'
      ),
    });
    // Still governed by the logged 0.02, not the 30-minute override: it reaches hard_stop from
    // one short line of dialogue rather than needing 30 minutes of it.
    expect(events.at(-1)).toMatchObject({ type: 'session_end', reason: 'hard_stop' });
  });

  it('refuses to resume with a changed party', async () => {
    await writeCharacter('resume-c', 'kira', 'Kira Vale');
    await writeCharacter('resume-c', 'tomas', 'Tomas Reed');
    await writeCampaignJson('resume-c', { kira: PLAYER_SEAT, tomas: PLAYER_SEAT });
    await seedShortSession('resume-c', 0.02);

    await expect(
      runSession({ campaignsDir, campaign: 'resume-c', session: 1, resume: true })
    ).rejects.toThrow('Resume with the original party');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('runSession with lore', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  // The fixture's one lore section, as a single heading and a one-paragraph body: `chunkMarkdown`
  // produces exactly `{ title: LORE_TITLE, text: LORE_BODY }` for it (no heading path separator,
  // since there's only one heading; trimmed to just the body line). `buildIndex` embeds
  // `${title}\n\n${text}` for that chunk, so `LORE_QUERY` is byte-identical to what was embedded —
  // with `FakeEmbedder` (no real semantics), that guarantees the query's vector exactly matches
  // the document's, rather than depending on similarity a hash-based embedder cannot provide.
  const LORE_TITLE = 'Avalon Artificers Academy';
  const LORE_BODY =
    'A polished rival school north of the river, famous for its duels, its bake-offs and its ' +
    'extremely well-funded workshops.';
  const LORE_QUERY = `${LORE_TITLE}\n\n${LORE_BODY}`;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-lore-'));
    // The DM always looks up the fixture's own lore, narrates, sets a scene, and hands off to the
    // party — but Kira is written in at 0 HP, so she is never "up" to receive that hand-off. Each
    // such beat is therefore an idle hand-off; after `idleHandOffLimit` (3) of them in a row, the
    // backstop pauses the session on its own, with no player turn ever needed. targetMinutes is
    // generous (5) so this never also trips the word-count clock, which would end the session
    // outright instead of pausing it.
    fake = await startFakeOpenAIServer(() => ({
      toolCalls: [
        { name: 'lookup_lore', arguments: { query: LORE_QUERY } },
        {
          name: 'narrate',
          arguments: {
            text: 'Dust motes drift through the shafts of light falling across the archive floor.',
          },
        },
        {
          name: 'scene_change',
          arguments: { location: 'Avalon Archive Vault', artPrompt: 'A dusty vault of scrolls' },
        },
        { name: 'hand_off', arguments: { target: { kind: 'party' } } },
      ],
    }));
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  /**
   * Writes a campaign whose lorePath points at a tiny lore repo, with an embed seat pointing at
   * the fake server (never actually called: every test injects a FakeEmbedder), and a party of
   * one — Kira, downed from the start so the DM's own hand-offs pause the session quickly instead
   * of requiring a scripted player turn.
   */
  async function loreFixture(extra: Record<string, unknown> = {}): Promise<{
    campaignsDir: string;
    campaign: string;
    lorePath: string;
  }> {
    const campaign = 'live';
    const dir = join(campaignsDir, campaign);
    const lorePath = join(dir, 'lore');
    await mkdir(join(lorePath, 'dm'), { recursive: true });
    await writeFile(join(lorePath, 'dm', 'avalon.md'), `# ${LORE_TITLE}\n\n${LORE_BODY}\n`);
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(
      join(dir, 'campaign.json'),
      JSON.stringify({
        name: 'Lore live',
        targetMinutes: 5,
        lorePath,
        ...extra,
        endpoints: { local: { baseURL: fake.baseURL } },
        seats: {
          dm: { endpoint: 'local', model: 'dm-model' },
          embed: { endpoint: 'local', model: 'embed-model' },
          players: { kira: { endpoint: 'local', model: 'player-model' } },
        },
      })
    );
    await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify({ ...KIRA, hp: 0 }));
    return { campaignsDir, campaign, lorePath };
  }

  async function indexDirFor(campaign: string): Promise<string> {
    return loreIndexDir(await loadCampaign(campaignsDir, campaign));
  }

  it('builds a missing index before a fresh session and records the lore commit', async () => {
    const { campaign } = await loreFixture();
    const result = await runSession({
      campaignsDir,
      campaign,
      session: 1,
      resume: false,
      embedder: new FakeEmbedder(16),
    });
    const events = await readEvents(result.eventsPath);
    const start = events.find((event) => event.type === 'session_start');
    expect(start).toMatchObject({ loreCommit: expect.stringMatching(/^(nogit-|[0-9a-f]{40})/) });
  });

  it('refuses a resume when the on-disk index no longer matches the logged lore', async () => {
    const { campaign, lorePath } = await loreFixture();
    await runSession({
      campaignsDir,
      campaign,
      session: 1,
      resume: false,
      embedder: new FakeEmbedder(16),
    });
    await writeFile(
      join(lorePath, 'dm', 'avalon.md'),
      '# Avalon Artificers Academy\n\nRewritten lore that no longer matches the logged session, ' +
        'and long enough that the chunker keeps it too.\n'
    );
    await expect(
      runSession({
        campaignsDir,
        campaign,
        session: 1,
        resume: true,
        embedder: new FakeEmbedder(16),
      })
    ).rejects.toThrow(/lore has changed since session 1 started.*the lore repository is now at/s);
  });

  it('does not rebuild the index on resume', async () => {
    const { campaign } = await loreFixture();
    await runSession({
      campaignsDir,
      campaign,
      session: 1,
      resume: false,
      embedder: new FakeEmbedder(16),
    });
    const before = await readMeta(await indexDirFor(campaign));
    await runSession({
      campaignsDir,
      campaign,
      session: 1,
      resume: true,
      embedder: new FakeEmbedder(16),
    });
    const after = await readMeta(await indexDirFor(campaign));
    expect(after!.builtAt).toBe(before!.builtAt);
  });

  it('finds real lore for a matching lookup_lore query', async () => {
    const { campaign } = await loreFixture();
    const result = await runSession({
      campaignsDir,
      campaign,
      session: 1,
      resume: false,
      embedder: new FakeEmbedder(16),
    });
    const events = await readEvents(result.eventsPath);
    const lookup = events.find(
      (event): event is Extract<SimEvent, { type: 'lore_lookup' }> => event.type === 'lore_lookup'
    );
    expect(lookup).toBeDefined();
    expect(lookup!.query).toBe(LORE_QUERY);
    // A real search, not a stub: `used` is non-empty (a search that always returns nothing would
    // pass every other test in this file), and the hit it names carries the fixture's own entity
    // metadata rather than a placeholder, proving it was read back from the real LanceDB index.
    expect(lookup!.used.length).toBeGreaterThan(0);
    const usedHit = lookup!.hits.find((hit) => hit.chunkId === lookup!.used[0]);
    expect(usedHit).toMatchObject({ entityName: LORE_TITLE, entityId: expect.any(String) });
  });

  it('threads a campaign-configured loreThreshold through to the director', async () => {
    const { campaign } = await loreFixture({ loreThreshold: 0.42 });
    const loaded = await loadCampaign(campaignsDir, campaign);
    expect(loaded.loreThreshold).toBe(0.42);
    const config = directorConfig(
      loaded,
      { campaignsDir, campaign, session: 1, resume: false },
      'lore-abc'
    );
    expect(config).toMatchObject({ session: 1, loreCommit: 'lore-abc', loreThreshold: 0.42 });
  });

  it('leaves the threshold to the engine default when the campaign configures none', async () => {
    const { campaign } = await loreFixture();
    const loaded = await loadCampaign(campaignsDir, campaign);
    // Absent, not `undefined`: the director's `config.loreThreshold ?? DEFAULT_LORE_THRESHOLD`
    // must see nothing at all rather than an explicit override that happens to be empty.
    expect(
      directorConfig(loaded, { campaignsDir, campaign, session: 1, resume: false }, 'lore-abc')
    ).not.toHaveProperty('loreThreshold');
  });

  it('closes the lore index even when the session lock is already held', async () => {
    const { campaign } = await loreFixture();
    const eventsPath = sessionEventsPath(campaignsDir, campaign, 1);
    const holder = new JsonlFileSink(eventsPath);
    await holder.acquireLock();
    const closeSpy = vi.spyOn(LanceStore.prototype, 'close');
    try {
      // campaignSetup opens a real LanceDB handle before runSession ever tries the lock; this
      // proves that handle is still closed even though acquireLock throws right after.
      await expect(
        runSession({
          campaignsDir,
          campaign,
          session: 1,
          resume: false,
          embedder: new FakeEmbedder(16),
        })
      ).rejects.toThrow(/another run may be active/i);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      await holder.releaseLock();
    }
  });
});
