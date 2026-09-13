import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder } from '@cartyx-sim/core';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { sessionEventsPath } from '../src/paths';
import { runSession } from '../src/run';

const KIRA = `id: kira
name: Kira Vale
kind: pc
level: 3
abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }
proficiencyBonus: 2
ac: 15
maxHp: 24
hp: 24
`;

function campaignYaml(baseURL: string): string {
  return `name: Live test
targetMinutes: 0.12
endpoints:
  local: { baseURL: ${baseURL} }
seats:
  dm: { endpoint: local, model: dm-model, temperature: 0.7 }
  players:
    kira: { endpoint: local, model: player-model }
`;
}

describe('runSession with campaign model seats', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-live-'));
    let dmCalls = 0;
    fake = await startFakeOpenAIServer((body) => {
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
    await writeFile(join(dir, 'campaign.yaml'), campaignYaml(fake.baseURL));
    await writeFile(join(dir, 'characters', 'kira.yaml'), KIRA);
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
    await writeFile(join(campaignsDir, 'live', 'campaign.yaml'), 'name: Broken\n');
    await expect(
      runSession({ campaignsDir, campaign: 'live', session: 1, resume: false })
    ).rejects.toThrow('invalid campaign');
    await expect(stat(join(campaignsDir, 'live', 'sessions'))).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
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

  async function writeCampaignYaml(campaign: string, playersYaml: string): Promise<void> {
    await writeFile(
      join(campaignsDir, campaign, 'campaign.yaml'),
      `name: Resume test
targetMinutes: 0.02
endpoints:
  local: { baseURL: ${fake.baseURL} }
seats:
  dm: { endpoint: local, model: dm-model }
  players:
${playersYaml}
`
    );
  }

  async function writeCharacter(campaign: string, id: string, name: string): Promise<void> {
    await mkdir(join(campaignsDir, campaign, 'characters'), { recursive: true });
    await writeFile(
      join(campaignsDir, campaign, 'characters', `${id}.yaml`),
      KIRA.replace('id: kira', `id: ${id}`).replace('name: Kira Vale', `name: ${name}`)
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
    await writeCampaignYaml('resume-a', '    kira: { endpoint: local, model: player-model }');
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
    await writeCampaignYaml('resume-b', '    kira: { endpoint: local, model: player-model }');
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
    await writeCampaignYaml(
      'resume-c',
      '    kira: { endpoint: local, model: player-model }\n' +
        '    tomas: { endpoint: local, model: player-model }'
    );
    await seedShortSession('resume-c', 0.02);

    await expect(
      runSession({ campaignsDir, campaign: 'resume-c', session: 1, resume: true })
    ).rejects.toThrow('Resume with the original party');
    expect(fake.requests).toHaveLength(0);
  });
});
