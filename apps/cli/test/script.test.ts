import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder } from '@cartyx-sim/core';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { ScriptFile } from '@cartyx-sim/script';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFileSink } from '../src/jsonl-sink';
import { formatScriptSummary, makeScript, type ScriptOptions } from '../src/script';

const KIRA_FILE = {
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

const LABELS = '{"labels": [{"quote": 1, "speaker": "new:faceless creature"}]}';

function sessionEvents() {
  const recorder = new TurnRecorder(
    initialState(),
    'turn-1',
    () => new Date('2026-09-16T12:00:00Z')
  );
  recorder.emit({
    type: 'session_start',
    session: 1,
    loreCommit: 'test',
    targetMinutes: 10,
    party: [makeCombatant({ id: 'kira', name: 'Kira Vale' })],
  });
  recorder.emit({
    type: 'narration',
    speaker: 'dm',
    emotion: 'neutral',
    text: 'The slit opens. *"You... opened... the door,"* it rasps.',
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'neutral',
    text: '"Not us." I back away. "Not ever."',
  });
  return [...recorder.events];
}

describe('makeScript', () => {
  let campaignsDir: string;
  let sessionPath: string;
  let fake: FakeOpenAIServer;
  let reply: () => { text?: string; status?: number };

  async function writeCampaignJson(seats: Record<string, unknown>) {
    await writeFile(
      join(campaignsDir, 'live', 'campaign.json'),
      JSON.stringify({
        name: 'Live',
        targetMinutes: 10,
        endpoints: { local: { baseURL: fake.baseURL } },
        seats: {
          dm: { endpoint: 'local', model: 'dm-model' },
          players: { kira: { endpoint: 'local', model: 'player-model' } },
          ...seats,
        },
      })
    );
  }

  function options(overrides: Partial<ScriptOptions> = {}): ScriptOptions {
    return {
      campaignsDir,
      campaign: 'live',
      session: 1,
      useModel: true,
      refresh: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-script-'));
    reply = () => ({ text: LABELS });
    fake = await startFakeOpenAIServer(() => reply());
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA_FILE));
    await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
    sessionPath = join(dir, 'sessions', '001');
    await new JsonlFileSink(join(sessionPath, 'events.jsonl')).append(sessionEvents());
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('writes script.json and script.md, labeling quotes with the checker seat', async () => {
    const result = await makeScript(options());

    expect(result.scriptPath).toBe(join(sessionPath, 'script.json'));
    expect(result.markdownPath).toBe(join(sessionPath, 'script.md'));
    expect(result.labelSeat).toBe('checker');
    expect(result.stats.labels).toEqual({ model: 1, cache: 0, fallback: 0 });
    expect(fake.requests.map((request) => request.model)).toEqual(['checker-model']);

    const script = ScriptFile.parse(JSON.parse(await readFile(result.scriptPath, 'utf8')));
    const bytes = await readFile(join(sessionPath, 'events.jsonl'));
    expect(script.eventsSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(script.lines.map((line) => ('text' in line ? line.text : line.kind))).toEqual([
      'The slit opens.',
      'You... opened... the door.',
      'it rasps.',
      'Not us.',
      'Not ever.',
    ]);
    const book = await readFile(result.markdownPath, 'utf8');
    expect(book).toContain('**Faceless creature:** You... opened... the door.');
    expect(book).toContain('**Kira Vale:** Not us. *(I back away.)*');
    await expect(stat(join(sessionPath, 'events.jsonl.lock'))).rejects.toThrow();
  });

  it('releases the session lock before asking the labeling seat', async () => {
    let lockHeldDuringLabel: boolean | undefined;
    reply = () => {
      lockHeldDuringLabel = existsSync(join(sessionPath, 'events.jsonl.lock'));
      return { text: LABELS };
    };

    await makeScript(options());

    expect(lockHeldDuringLabel).toBe(false);
  });

  it('answers from the cache on a second run, and asks again with refresh', async () => {
    await makeScript(options());
    const cached = await makeScript(options());
    expect(cached.stats.labels).toEqual({ model: 0, cache: 1, fallback: 0 });
    expect(fake.requests).toHaveLength(1);
    const refreshed = await makeScript(options({ refresh: true }));
    expect(refreshed.stats.labels.model).toBe(1);
    expect(fake.requests).toHaveLength(2);
  });

  it('prefers a script seat over the checker', async () => {
    await writeCampaignJson({
      checker: { endpoint: 'local', model: 'checker-model' },
      script: { endpoint: 'local', model: 'script-model' },
    });
    const result = await makeScript(options());
    expect(result.labelSeat).toBe('script');
    expect(fake.requests.map((request) => request.model)).toEqual(['script-model']);
  });

  it('uses rules only without the model, and never reads the campaign', async () => {
    await rm(join(campaignsDir, 'live', 'campaign.json'));
    const result = await makeScript(options({ useModel: false }));
    expect(result.stats.labels).toEqual({ model: 0, cache: 0, fallback: 1 });
    expect(result.labelSeat).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('says so when the campaign has no seat to label with', async () => {
    await writeCampaignJson({});
    const lines: string[] = [];
    const result = await makeScript(options({ log: (line) => lines.push(line) }));
    expect(lines).toContain(
      'No script or checker seat in campaign.json; attributing quotes by rules only.'
    );
    expect(result.stats.labels.fallback).toBe(1);
  });

  it('warns that --refresh has no effect with --no-model', async () => {
    const lines: string[] = [];
    await makeScript(options({ useModel: false, refresh: true, log: (line) => lines.push(line) }));
    expect(lines).toContain('--refresh has no effect: no model labels quotes in this run.');
  });

  it('warns that --refresh has no effect when the campaign has no seat to label with', async () => {
    await writeCampaignJson({});
    const lines: string[] = [];
    await makeScript(options({ refresh: true, log: (line) => lines.push(line) }));
    expect(lines).toContain('--refresh has no effect: no model labels quotes in this run.');
  });

  it('falls back to rules with a note when the seat fails', async () => {
    reply = () => ({ status: 500 });
    const result = await makeScript(options());
    expect(result.stats.labels.fallback).toBe(1);
    expect(result.notes).toEqual([
      {
        seq: 1,
        text: expect.stringMatching(/^Quotes attributed by rules: seat "checker" unavailable/),
      },
    ]);
  });

  it('applies speakers.json and reports a bad one with its path', async () => {
    const path = join(sessionPath, 'speakers.json');
    await writeFile(
      path,
      JSON.stringify({ 'npc-faceless-creature': { name: 'The Faceless One' } })
    );
    const result = await makeScript(options());
    const script = ScriptFile.parse(JSON.parse(await readFile(result.scriptPath, 'utf8')));
    expect(script.speakers.at(-1)?.name).toBe('The Faceless One');

    await writeFile(path, '{ nope');
    await expect(makeScript(options())).rejects.toThrow(`${path}: invalid JSON`);
    await writeFile(path, JSON.stringify({ 'npc-x': { voice: 'deep' } }));
    await expect(makeScript(options())).rejects.toThrow(`${path}: invalid speaker overrides`);
    await writeFile(path, JSON.stringify({ 'npc-ghost': { name: 'Ghost' } }));
    await expect(makeScript(options())).rejects.toThrow('speakers.json: "npc-ghost"');
  });

  it('refuses a missing session, a held lock, and an unknown log version', async () => {
    await expect(makeScript(options({ session: 2 }))).rejects.toThrow('No event log at');

    const lock = join(sessionPath, 'events.jsonl.lock');
    await writeFile(lock, `${process.pid} now\n`);
    await expect(makeScript(options())).rejects.toThrow('another run may be active');
    await rm(lock);

    const events = join(sessionPath, 'events.jsonl');
    const lines = (await readFile(events, 'utf8')).split('\n');
    lines[0] = lines[0]!.replace('"schemaVersion":1', '"schemaVersion":2');
    await writeFile(events, lines.join('\n'));
    await expect(makeScript(options())).rejects.toThrow('invalid event');
  });

  it('formats a summary', async () => {
    const result = await makeScript(options());
    expect(formatScriptSummary(result)).toEqual([
      'Lines: narration 2, dialogue 3',
      'Spoken words: 13 (~0.1 min)',
      'Quote labels: model 1, cache 0, rules 0 (seat "checker")',
      'Stage directions dropped: 1',
      'Unlisted NPC speakers: npc-faceless-creature',
      `Script: ${result.scriptPath}`,
      `Book: ${result.markdownPath}`,
    ]);
  });
});
