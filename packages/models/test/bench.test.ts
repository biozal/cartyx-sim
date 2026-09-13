import { afterEach, describe, expect, it } from 'vitest';
import { benchSeat } from '../src/bench';
import { startFakeOpenAIServer, type FakeOpenAIServer, type FakeReply } from '../src/testing';

const servers: FakeOpenAIServer[] = [];
async function server(...args: Parameters<typeof startFakeOpenAIServer>) {
  const started = await startFakeOpenAIServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

/** A clock that returns each value in turn. */
function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('benchSeat', () => {
  it('reports reachability, model listing, and generation speed', async () => {
    const fake = await server(
      (_body, index) =>
        index === 0
          ? { text: 'A corridor.', completionTokens: 40 }
          : { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'test' } }] },
      { models: ['qwen-dm', 'other'] }
    );

    const result = await benchSeat(
      'dm',
      { endpoint: { baseURL: fake.baseURL }, model: 'qwen-dm' },
      { trials: 1, now: clock(1000, 1500) }
    );

    expect(result).toMatchObject({
      seat: 'dm',
      model: 'qwen-dm',
      baseURL: fake.baseURL,
      reachable: true,
      modelListed: true,
      latencyMs: 500,
      outputTokens: 40,
      tokensPerSecond: 80,
      toolCallTrials: 1,
      toolCallSuccesses: 1,
      errors: [],
    });
  });

  it('counts only well-formed calls to the test tool as successes', async () => {
    const trials: FakeReply[] = [
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'ok' } }] },
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '2d6', reason: 'wrong dice' } }] },
      { toolCalls: [{ name: 'roll_dice', arguments: '{not json' }] },
      { toolCalls: [{ name: 'narrate', arguments: { text: 'wrong tool' } }] },
      { text: 'No tool at all.' },
      { toolCalls: [{ name: 'roll_dice', arguments: { dice: '1d20+3', reason: 'ok again' } }] },
    ];
    const fake = await server((_body, index) =>
      index === 0 ? { text: 'A corridor.' } : trials[index - 1]!
    );

    const result = await benchSeat(
      'player-kira',
      { endpoint: { baseURL: fake.baseURL }, model: 'gemma' },
      { trials: trials.length }
    );

    expect(result.toolCallTrials).toBe(6);
    expect(result.toolCallSuccesses).toBe(2);
    expect(result.errors).toEqual([expect.stringContaining('tool trial 5 failed')]);
    expect(fake.requests.slice(1).every((request) => request.tool_choice === 'required')).toBe(
      true
    );
  });

  it('flags a model the server does not list', async () => {
    const fake = await server(() => ({ text: 'ok' }), { models: ['something-else'] });
    const result = await benchSeat(
      'dm',
      { endpoint: { baseURL: fake.baseURL }, model: 'missing-model', toolChoice: 'auto' },
      { trials: 0 }
    );
    expect(result.modelListed).toBe(false);
  });

  it('reports an unreachable endpoint without throwing', async () => {
    const fake = await server(() => ({ text: 'never used' }));
    const baseURL = fake.baseURL;
    await fake.close();
    servers.splice(servers.indexOf(fake), 1);

    const result = await benchSeat('dm', { endpoint: { baseURL }, model: 'm' }, { trials: 1 });

    expect(result).toMatchObject({
      reachable: false,
      modelListed: null,
      latencyMs: null,
      tokensPerSecond: null,
      toolCallSuccesses: 0,
    });
    expect(result.errors).toEqual([
      expect.stringContaining('GET /models failed'),
      expect.stringContaining('speed test failed'),
      expect.stringContaining('tool trial 1 failed'),
    ]);
  });
});
