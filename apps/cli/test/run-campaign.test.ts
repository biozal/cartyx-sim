import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
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
