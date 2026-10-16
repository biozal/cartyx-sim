import {
  basicPrompts,
  DM_TOOLS,
  Director,
  MemorySink,
  toToolSchema,
  type ModelRequest,
  type ToolSchema,
} from '@cartyx-sim/core';
import { StaticLoreIndex } from '@cartyx-sim/core/testing';
import { scriptedRng } from '@cartyx-sim/rules';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleModelClient } from '../src/client';
import { reasoningProviderOptions } from '../src/seat';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '../src/testing';

const narrateTool: ToolSchema = {
  name: 'narrate',
  description: 'Narrate the scene.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    seat: 'dm',
    turnId: 'turn-1',
    messages: [
      { role: 'system', content: 'You are the DM.' },
      { role: 'user', content: 'Begin.' },
    ],
    tools: [narrateTool],
    toolChoice: 'required',
    ...overrides,
  };
}

/** About the size of session 015's player request: ~19,500 characters, ~4,300 tokens whole. */
function bigRequest(): ModelRequest {
  return request({
    messages: [
      { role: 'system', content: 'You are Tomas. '.repeat(1300) },
      { role: 'user', content: 'Your turn.' },
    ],
  });
}

const servers: FakeOpenAIServer[] = [];
async function server(...args: Parameters<typeof startFakeOpenAIServer>) {
  const started = await startFakeOpenAIServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

describe('OpenAICompatibleModelClient', () => {
  it('reasoningProviderOptions converts provider names to camelCase keys without warning', () => {
    expect(reasoningProviderOptions('cartyx-sim', 'none')).toEqual({
      cartyxSim: { reasoningEffort: 'none' },
    });
    expect(reasoningProviderOptions('cartyx-sim-bench', 'medium')).toEqual({
      cartyxSimBench: { reasoningEffort: 'medium' },
    });
    expect(reasoningProviderOptions('cartyx-sim', undefined)).toBeUndefined();
  });

  it('sends an OpenAI chat completion and maps the tool calls back', async () => {
    const fake = await server(() => ({
      text: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'narrate', arguments: { text: 'The lab hums.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: fake.baseURL },
        model: 'qwen-dm',
        temperature: 0.8,
        maxOutputTokens: 400,
      },
    });

    const response = await client.complete(request());

    expect(response).toEqual({
      text: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'narrate', args: { text: 'The lab hums.' } }],
      model: 'qwen-dm',
    });
    const sent = fake.requests[0]!;
    expect(sent).toMatchObject({
      model: 'qwen-dm',
      temperature: 0.8,
      max_tokens: 400,
      tool_choice: 'required',
      messages: [
        { role: 'system', content: 'You are the DM.' },
        { role: 'user', content: 'Begin.' },
      ],
    });
    expect(sent.tools?.[0]?.function).toMatchObject({
      name: 'narrate',
      parameters: narrateTool.parameters,
    });
  });

  it("sends a real tool's generated JSON schema with no $schema key at the wire", async () => {
    const fake = await server(() => ({
      toolCalls: [{ id: 'call_1', name: 'narrate', arguments: { text: 'The lab hums.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'qwen-dm' },
    });
    const narrateSchema = toToolSchema(DM_TOOLS.find((tool) => tool.name === 'narrate')!);

    await client.complete(request({ tools: [narrateSchema] }));

    const sentParameters = fake.requests[0]?.tools?.[0]?.function.parameters;
    expect(sentParameters).not.toHaveProperty('$schema');
    expect(sentParameters).toEqual(narrateSchema.parameters);
  });

  it('returns plain text when tool calls are optional', async () => {
    const fake = await server(() => ({ text: 'The lab hums.' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    expect(await client.complete(request({ toolChoice: 'auto' }))).toEqual({
      text: 'The lab hums.',
      toolCalls: [],
      model: 'm',
    });
  });

  it('treats a text-only reply to a required tool call as a failed attempt', async () => {
    const fake = await server(() => ({ text: 'I would rather just talk.' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    await expect(client.complete(request())).rejects.toThrow('did not contain a tool call');
  });

  it('recovers a required tool call that Gemma wrote as text instead of failing', async () => {
    const fake = await server(() => ({ text: 'narrate{text:<|"|>The lab hums.<|"|>}' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    expect(await client.complete(request())).toEqual({
      text: '',
      toolCalls: [{ id: 'text-call-1-0', name: 'narrate', args: { text: 'The lab hums.' } }],
      model: 'm',
    });
  });

  it('recovers a text-written call when tool calls are optional, rather than speaking it', async () => {
    const fake = await server(() => ({ text: 'call:narrate{text:<|"|>The lab hums.<|"|>}' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const response = await client.complete(request({ toolChoice: 'auto' }));
    expect(response.text).toBe('');
    expect(response.toolCalls).toEqual([
      { id: 'text-call-1-0', name: 'narrate', args: { text: 'The lab hums.' } },
    ]);
  });

  it('fails a reply whose server read far fewer prompt tokens than were sent, and falls back', async () => {
    // Session 015: Ollama read 2050 tokens of a ~4300-token prompt and the model played the wrong PC.
    // A well-formed call, so only the truncation check can explain the fallback.
    const truncating = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Kira steps forward.' } }],
      promptTokens: 2050,
    }));
    const whole = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Tomas acts.' } }],
      promptTokens: 4300,
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: truncating.baseURL },
        model: 'small-context',
        fallbacks: [{ endpoint: { baseURL: whole.baseURL }, model: 'big-context' }],
      },
    });
    const big = bigRequest();
    const response = await client.complete(big);
    expect(response.model).toBe('big-context');
    expect(truncating.requests).toHaveLength(1);
  });

  it('names the truncation, not the missing tool call, when every target truncates', async () => {
    const fake = await server(() => ({ text: 'Kira steps forward.', promptTokens: 2050 }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const big = bigRequest();
    await expect(client.complete(big)).rejects.toThrow(/truncating the prompt.*num_ctx/);
  });

  it('numbers recovered calls per reply, so two replies never share an id', async () => {
    const fake = await server(() => ({ text: 'narrate{text:<|"|>Again.<|"|>}' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const first = await client.complete(request());
    const second = await client.complete(request());
    expect(first.toolCalls[0]!.id).not.toBe(second.toolCalls[0]!.id);
  });

  it('says why a reply needed a fallback', async () => {
    const failing = await server(() => ({ status: 500 }));
    const working = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Fine.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: failing.baseURL },
        model: 'primary',
        fallbacks: [{ endpoint: { baseURL: working.baseURL }, model: 'backup' }],
      },
    });
    const response = await client.complete(request());
    expect(response.model).toBe('backup');
    expect(response.failedAttempts).toEqual([expect.stringMatching(/^primary at http.*500/)]);
  });

  it.each([
    ['reports no prompt tokens', 0],
    ['is small enough that framing skews the ratio', undefined],
  ])('does not call a prompt truncated when the server %s', async (_, promptTokens) => {
    const fake = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Fine.' } }],
      promptTokens: promptTokens ?? 1,
    }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    // The zero case needs a big request to prove it is ignored; the small case a small one.
    const response = await client.complete(promptTokens === 0 ? bigRequest() : request());
    expect(response.toolCalls).toHaveLength(1);
    expect(response.failedAttempts).toBeUndefined();
  });

  it('adds cached tokens back when a server counts them apart from prompt_tokens', async () => {
    const fake = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Fine.' } }],
      promptTokens: 300,
      cachedTokens: 4000,
    }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    expect((await client.complete(bigRequest())).toolCalls).toHaveLength(1);
  });

  it('accepts a big prompt the server read in full', async () => {
    const fake = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'Fine.' } }],
      promptTokens: 4300,
    }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const big = bigRequest();
    expect((await client.complete(big)).toolCalls).toHaveLength(1);
  });

  it('gives malformed tool arguments empty args for the engine to reject', async () => {
    const fake = await server(() => ({ toolCalls: [{ name: 'narrate', arguments: '{bad' }] }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });
    const response = await client.complete(request());
    expect(response.toolCalls).toMatchObject([{ name: 'narrate', args: {} }]);
  });

  it("lets a seat's toolChoice override the engine's request", async () => {
    const fake = await server(() => ({ text: 'ok' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm', toolChoice: 'auto' },
    });
    await client.complete(request());
    expect(fake.requests[0]?.tool_choice).toBe('auto');
  });

  it('falls back to the next target when the primary fails', async () => {
    const primary = await server(() => ({ status: 500 }));
    const backup = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'From the backup.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    expect(await client.complete(request())).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'From the backup.' } }],
      model: 'small',
    });
    expect(primary.requests).toHaveLength(1);
    expect(backup.requests[0]?.model).toBe('small');
  });

  it('names every failed endpoint when all targets fail', async () => {
    const primary = await server(() => ({ status: 503 }));
    const backup = await server(() => ({ status: 500 }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    await expect(client.complete(request())).rejects.toThrow(
      new RegExp(`Every endpoint failed: big at ${primary.baseURL}.*; small at ${backup.baseURL}`)
    );
  });

  it('names the seat exactly once when a Director run pauses after every endpoint fails', async () => {
    const primary = await server(() => ({ status: 500 }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: primary.baseURL }, model: 'big' },
    });
    const kira = makeCombatant({ id: 'kira', name: 'Kira Vale' });
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'test',
        party: [kira],
        seats: { dm: 'dm', players: { kira: 'player-kira' } },
        retryDelaysMs: [],
      },
      {
        model: client,
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
      }
    );

    const result = await director.run();

    expect(result).toMatchObject({ status: 'paused', seat: 'dm' });
    const paused = sink.events.at(-1) as { reason: string };
    // Before the fix, the client's own "Seat ... failed on every endpoint" combined with the
    // director's SessionPausedError wrapper repeated the seat name.
    expect(paused.reason.match(/"dm"/g)).toHaveLength(1);
  });

  it('times out a slow endpoint', async () => {
    const fake = await server(() => ({ text: 'late', delayMs: 500 }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm', timeoutMs: 50 },
    });
    await expect(client.complete(request())).rejects.toThrow('Every endpoint failed');
  });

  it('does not fall back after a deliberate abort', async () => {
    const primary = await server(() => ({ text: 'late', delayMs: 500 }));
    const backup = await server(() => ({ text: 'from backup' }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });
    const controller = new AbortController();
    const pending = client.complete(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
    expect(backup.requests).toHaveLength(0);
  });

  it('rejects an unconfigured seat', async () => {
    const client = new OpenAICompatibleModelClient({});
    await expect(client.complete(request({ seat: 'player-kira' }))).rejects.toThrow(
      'No model is configured for seat "player-kira".'
    );
  });

  it('drives a Director turn, including a tool result sent back mid-beat', async () => {
    const fake = await server((body) => {
      const tools = (body.tools ?? []).map((entry) => entry.function.name);
      if (!tools.includes('narrate')) return { toolCalls: [{ name: 'pass', arguments: {} }] };
      const sawToolResult = body.messages.some((message) => message.role === 'tool');
      return sawToolResult
        ? { toolCalls: [{ name: 'hand_off', arguments: { target: { kind: 'party' } } }] }
        : { toolCalls: [{ name: 'narrate', arguments: { text: 'The crystal engines hum.' } }] };
    });
    const kira = makeCombatant({ id: 'kira', name: 'Kira Vale' });
    const seat = { endpoint: { baseURL: fake.baseURL }, model: 'm' };
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'test',
        party: [kira],
        seats: { dm: 'dm', players: { kira: 'player-kira' } },
        retryDelaysMs: [],
      },
      {
        model: new OpenAICompatibleModelClient({ dm: seat, 'player-kira': seat }),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
      }
    );

    const result = await director.run(3);

    expect(result.status).toBe('turn_limit');
    expect(sink.events.map((event) => event.type)).toEqual([
      'session_start',
      'narration',
      'hand_off',
      'turn_end',
      'pass',
      'turn_end',
    ]);
    const secondDmCall = fake.requests[1]!;
    const toolMessage = secondDmCall.messages.find((message) => message.role === 'tool');
    const assistant = secondDmCall.messages.find((message) => message.role === 'assistant');
    expect(toolMessage).toMatchObject({ content: 'Narrated.' });
    expect(toolMessage?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
  });

  it('retries an empty reply on the same target when incompleteReplyAttempts is set', async () => {
    const fake = await server((_body, index) =>
      index === 0
        ? { text: '' }
        : { toolCalls: [{ name: 'narrate', arguments: { text: 'Second try.' } }] }
    );
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });

    const response = await client.complete(
      request({ incompleteReplyAttempts: 2, toolChoice: 'auto' })
    );

    expect(response).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'Second try.' } }],
    });
    expect(fake.requests).toHaveLength(2);
  });

  it('falls back after every attempt on the primary is cut off by the output-token limit', async () => {
    const primary = await server(() => ({ text: 'thinking forever', finishReason: 'length' }));
    const backup = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'From the backup.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });

    const response = await client.complete(
      request({ incompleteReplyAttempts: 2, toolChoice: 'auto' })
    );

    expect(response).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'From the backup.' } }],
    });
    expect(primary.requests).toHaveLength(2);
  });

  it('throws naming the incomplete-reply failures when every attempt on every target is incomplete', async () => {
    const fake = await server(() => ({ text: '', finishReason: 'length' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });

    await expect(
      client.complete(request({ incompleteReplyAttempts: 2, toolChoice: 'auto' }))
    ).rejects.toThrow(/Every endpoint failed.*incomplete reply \(finish: length\)/s);
    expect(fake.requests).toHaveLength(2);
  });

  it('returns an empty reply as-is when incompleteReplyAttempts is unset', async () => {
    const fake = await server(() => ({ text: '' }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });

    expect(await client.complete(request({ toolChoice: 'auto' }))).toEqual({
      text: '',
      toolCalls: [],
      model: 'm',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('does not retry a 500 on the same target even when incompleteReplyAttempts is set', async () => {
    const primary = await server(() => ({ status: 500 }));
    const backup = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'From the backup.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: {
        endpoint: { baseURL: primary.baseURL },
        model: 'big',
        fallbacks: [{ endpoint: { baseURL: backup.baseURL }, model: 'small' }],
      },
    });

    const response = await client.complete(request({ incompleteReplyAttempts: 2 }));

    expect(response).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'From the backup.' } }],
    });
    expect(primary.requests).toHaveLength(1);
  });

  it('still makes one call and returns a complete reply when incompleteReplyAttempts is 0', async () => {
    const fake = await server(() => ({
      toolCalls: [{ name: 'narrate', arguments: { text: 'The lab hums.' } }],
    }));
    const client = new OpenAICompatibleModelClient({
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'm' },
    });

    const response = await client.complete(request({ incompleteReplyAttempts: 0 }));

    expect(response).toMatchObject({
      toolCalls: [{ name: 'narrate', args: { text: 'The lab hums.' } }],
    });
    expect(fake.requests).toHaveLength(1);
  });

  it("sends a seat's reasoning effort as reasoning_effort, and nothing when unset", async () => {
    const fake = await server(() => ({ text: '{"violations": []}' }));
    const client = new OpenAICompatibleModelClient({
      checker: { endpoint: { baseURL: fake.baseURL }, model: 'glm', reasoningEffort: 'none' },
      dm: { endpoint: { baseURL: fake.baseURL }, model: 'qwen-dm' },
    });

    await client.complete(request({ seat: 'checker', tools: [], toolChoice: 'auto' }));
    await client.complete(request({ seat: 'dm', toolChoice: 'auto' }));

    expect(fake.requests[0]).toMatchObject({ model: 'glm', reasoning_effort: 'none' });
    expect(fake.requests[0]).not.toHaveProperty('reasoningEffort');
    expect(fake.requests[0]).not.toHaveProperty('tools');
    expect(fake.requests[0]).not.toHaveProperty('tool_choice');
    expect(fake.requests[1]).not.toHaveProperty('reasoning_effort');
  });
});
