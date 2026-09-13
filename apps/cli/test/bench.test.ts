import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchResult } from '@cartyx-sim/models';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '@cartyx-sim/models/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { benchPassed, formatBenchTable, runBench } from '../src/bench';

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

describe('runBench', () => {
  let campaignsDir: string;
  let fake: FakeOpenAIServer;

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-bench-'));
    fake = await startFakeOpenAIServer(
      (body) =>
        (body.tools ?? []).some((entry) => entry.function.name === 'roll_dice')
          ? {
              toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'bench' } }],
            }
          : { text: 'A corridor.', completionTokens: 20 },
      { models: ['dm-model', 'player-model'] }
    );
    const dir = join(campaignsDir, 'live');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(
      join(dir, 'campaign.yaml'),
      `name: Bench
targetMinutes: 30
endpoints:
  local: { baseURL: ${fake.baseURL} }
seats:
  dm: { endpoint: local, model: dm-model }
  players:
    kira: { endpoint: local, model: player-model }
`
    );
    await writeFile(join(dir, 'characters', 'kira.yaml'), KIRA);
  });

  afterEach(async () => {
    await fake.close();
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('benchmarks every seat, prints a table, and saves a report', async () => {
    const lines: string[] = [];
    const report = await runBench({
      campaignsDir,
      campaign: 'live',
      trials: 2,
      now: () => new Date('2026-09-13T12:00:00.000Z'),
      log: (line) => lines.push(line),
    });

    expect(report.results.map((result) => [result.seat, result.toolCallSuccesses])).toEqual([
      ['dm', 2],
      ['player-kira', 2],
    ]);
    expect(benchPassed(report.results)).toBe(true);
    expect(report.reportPath).toBe(
      join(campaignsDir, 'live', 'bench', '2026-09-13T12-00-00-000Z.json')
    );
    const saved = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
      campaign: string;
      results: BenchResult[];
    };
    expect(saved).toMatchObject({ campaign: 'live', createdAt: '2026-09-13T12:00:00.000Z' });
    expect(saved.results).toHaveLength(2);
    expect(lines.some((line) => line.startsWith('seat') && line.includes('tool calls'))).toBe(true);
  });

  it('passes an auto seat that sometimes answers in plain text instead of a tool call', async () => {
    let playerTrial = 0;
    const autoFake = await startFakeOpenAIServer(
      (body) => {
        const hasRollDice = (body.tools ?? []).some((entry) => entry.function.name === 'roll_dice');
        if (!hasRollDice) return { text: 'A corridor.', completionTokens: 20 };
        if (body.model !== 'player-model') {
          return {
            toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'bench' } }],
          };
        }
        playerTrial++;
        return playerTrial % 2 === 0
          ? { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'bench' } }] }
          : { text: 'A whispered warning drifts down the corridor.' };
      },
      { models: ['dm-model', 'player-model'] }
    );
    const dir = join(campaignsDir, 'auto');
    await mkdir(join(dir, 'characters'), { recursive: true });
    await writeFile(
      join(dir, 'campaign.yaml'),
      `name: Bench auto
targetMinutes: 30
endpoints:
  local: { baseURL: ${autoFake.baseURL} }
seats:
  dm: { endpoint: local, model: dm-model }
  players:
    kira: { endpoint: local, model: player-model, toolChoice: auto }
`
    );
    await writeFile(join(dir, 'characters', 'kira.yaml'), KIRA);

    try {
      const report = await runBench({ campaignsDir, campaign: 'auto', trials: 2 });

      const player = report.results.find((result) => result.seat === 'player-kira')!;
      expect(player).toMatchObject({ toolCallTrials: 2, toolCallSuccesses: 1, textReplies: 1 });
      expect(benchPassed(report.results)).toBe(true);
      expect(formatBenchTable(report.results).some((line) => line.includes('1/2 (+1 text)'))).toBe(
        true
      );
    } finally {
      await autoFake.close();
    }
  });
});

describe('formatBenchTable', () => {
  it('aligns columns and lists each seat’s errors under the table', () => {
    const results: BenchResult[] = [
      {
        seat: 'dm',
        model: 'qwen',
        baseURL: 'http://a/v1',
        reachable: true,
        modelListed: true,
        latencyMs: 812,
        outputTokens: 60,
        tokensPerSecond: 73.9,
        toolCallTrials: 5,
        toolCallSuccesses: 5,
        textReplies: 0,
        errors: [],
      },
      {
        seat: 'player-kira',
        model: 'gemma',
        baseURL: 'http://b/v1',
        reachable: false,
        modelListed: null,
        latencyMs: null,
        outputTokens: null,
        tokensPerSecond: null,
        toolCallTrials: 5,
        toolCallSuccesses: 0,
        textReplies: 0,
        errors: ['GET /models failed: connect ECONNREFUSED'],
      },
    ];
    expect(formatBenchTable(results)).toEqual([
      'seat         model  reachable  listed  tok/s  latency ms  tool calls',
      'dm           qwen   yes        yes     73.9   812         5/5',
      'player-kira  gemma  NO         ?       -      -           0/5',
      '  player-kira: GET /models failed: connect ECONNREFUSED',
    ]);
    expect(benchPassed(results)).toBe(false);
  });

  it('shows text replies in the tool-calls cell, and counts them toward passing', () => {
    const results: BenchResult[] = [
      {
        seat: 'player-tomas',
        model: 'gemma',
        baseURL: 'http://b/v1',
        reachable: true,
        modelListed: true,
        latencyMs: 200,
        outputTokens: 40,
        tokensPerSecond: 20,
        toolCallTrials: 5,
        toolCallSuccesses: 3,
        textReplies: 2,
        errors: [],
      },
    ];
    expect(formatBenchTable(results)).toEqual([
      'seat          model  reachable  listed  tok/s  latency ms  tool calls',
      'player-tomas  gemma  yes        yes     20     200         3/5 (+2 text)',
    ]);
    expect(benchPassed(results)).toBe(true);
  });
});
