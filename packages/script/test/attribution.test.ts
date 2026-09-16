import { ScriptedModelClient } from '@cartyx-sim/core/testing';
import { describe, expect, it } from 'vitest';
import {
  buildLabelMessages,
  fallbackLabels,
  LABEL_PROMPT_VERSION,
  labelCacheKey,
  ModelLabeler,
  parseLabelReply,
  type LabelCache,
  type LabelRequest,
} from '../src/attribution';

const REQUEST: LabelRequest = {
  seq: 73,
  narration: 'The slit opens. [[1]]"You... opened... the door," it rasps. [[2]]"Hm."',
  quotes: ['You... opened... the door.', 'Hm.'],
  npcs: [{ id: 'npc-warden', name: 'The Warden', description: 'A stone guardian' }],
  pcs: [{ id: 'kira', name: 'Kira Vale' }],
  newLabels: ['faceless creature'],
};

class MemoryCache implements LabelCache {
  readonly entries = new Map<string, unknown>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, value: unknown) {
    this.entries.set(key, value);
  }
}

const reply = (labels: { quote: number; speaker: string }[]) => ({
  text: JSON.stringify({ labels }),
  toolCalls: [],
});

describe('buildLabelMessages', () => {
  it('lists NPCs, PCs, earlier labels, and the numbered narration', () => {
    const [system, user] = buildLabelMessages(REQUEST);
    expect(system?.role).toBe('system');
    expect(system && 'content' in system ? system.content : '').toContain('"new:');
    const content = user && 'content' in user ? user.content : '';
    expect(content).toContain('- npc-warden: The Warden — A stone guardian');
    expect(content).toContain('- kira: Kira Vale');
    expect(content).toContain('- new:faceless creature');
    expect(content).toContain('Narration (2 quotations):');
    expect(content).toContain(REQUEST.narration);
  });

  it('writes (none) for empty lists', () => {
    const [, user] = buildLabelMessages({ ...REQUEST, npcs: [], newLabels: [] });
    const content = user && 'content' in user ? user.content : '';
    expect(content).toContain('Known NPCs:\n(none)');
    expect(content).toContain('Earlier new: labels this session:\n(none)');
  });

  it('tells the model that a quote inside reported speech is not speech', () => {
    const [system] = buildLabelMessages(REQUEST);
    expect(system && 'content' in system ? system.content : '').toMatch(/reported speech/i);
    expect(LABEL_PROMPT_VERSION).toBe(3);
  });
});

describe('parseLabelReply', () => {
  it('maps every speaker form, ignoring think blocks and surrounding text', () => {
    const text =
      '<think>{"labels": []}</think>Here: {"labels": [' +
      '{"quote": 2, "speaker": "none"}, {"quote": 1, "speaker": "new:  Faceless Creature "}]}';
    const parsed = parseLabelReply(text, REQUEST);
    expect('labels' in parsed && parsed.labels).toEqual([
      { kind: 'new', label: 'faceless creature' },
      { kind: 'none' },
    ]);
  });

  it('accepts known NPC and PC ids', () => {
    const parsed = parseLabelReply(
      JSON.stringify({
        labels: [
          { quote: 1, speaker: 'npc-warden' },
          { quote: 2, speaker: 'kira' },
        ],
      }),
      REQUEST
    );
    expect('labels' in parsed && parsed.labels).toEqual([
      { kind: 'npc', id: 'npc-warden' },
      { kind: 'pc', id: 'kira' },
    ]);
  });

  it.each([
    ['no JSON', 'I think quote 1 is the creature.', /no JSON object/],
    [
      'a missing quote',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'none' }] }),
      /quote 2 has no label/,
    ],
    [
      'a duplicate quote',
      JSON.stringify({
        labels: [
          { quote: 1, speaker: 'none' },
          { quote: 1, speaker: 'none' },
        ],
      }),
      /quote 1 is labeled twice/,
    ],
    [
      'an out-of-range quote',
      JSON.stringify({ labels: [{ quote: 3, speaker: 'none' }] }),
      /quote 3 does not exist/,
    ],
    [
      'an unknown speaker',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'npc-ghost' }] }),
      /unknown speaker "npc-ghost"/,
    ],
    [
      'an empty new label',
      JSON.stringify({ labels: [{ quote: 1, speaker: 'new: ' }] }),
      /unknown speaker/,
    ],
  ])('rejects %s', (_name, text, error) => {
    const parsed = parseLabelReply(text, REQUEST);
    expect('error' in parsed && parsed.error).toMatch(error);
  });
});

describe('toSpanLabel via parseLabelReply, `new:` labels', () => {
  const ONE_QUOTE: LabelRequest = { ...REQUEST, narration: '[[1]]"x"', quotes: ['x'] };
  const label = (speaker: string) =>
    parseLabelReply(JSON.stringify({ labels: [{ quote: 1, speaker }] }), ONE_QUOTE);

  it.each([
    ['a newline and a heading', 'new:guard\n## Injected heading'],
    ['markdown bold', 'new:**bold** guard'],
    ['a 61-character label', `new:${'a'.repeat(61)}`],
    ['a punctuation-only label', 'new:!!!'],
  ])('rejects %s', (_name, speaker) => {
    const parsed = label(speaker);
    expect('error' in parsed).toBe(true);
  });

  it('accepts a 60-character label', () => {
    const parsed = label(`new:${'a'.repeat(60)}`);
    expect('labels' in parsed && parsed.labels).toEqual([{ kind: 'new', label: 'a'.repeat(60) }]);
  });

  it('collapses whitespace, trims, and lowercases', () => {
    const parsed = label('new:  Old   Man ');
    expect('labels' in parsed && parsed.labels).toEqual([{ kind: 'new', label: 'old man' }]);
  });

  it('accepts straight and curly apostrophes', () => {
    const parsed = label("new:O'Brien’s dog");
    expect('labels' in parsed && parsed.labels).toEqual([{ kind: 'new', label: "o'brien’s dog" }]);
  });
});

describe('fallbackLabels', () => {
  it('labels short quotes as not speech and others as the only scene NPC', () => {
    expect(fallbackLabels(REQUEST, ['npc-warden'])).toEqual([
      { kind: 'npc', id: 'npc-warden' },
      { kind: 'none' },
    ]);
  });

  it('uses the unnamed speaker when the scene has no single NPC', () => {
    expect(fallbackLabels(REQUEST, [])[0]).toEqual({ kind: 'new', label: 'unnamed' });
    expect(fallbackLabels(REQUEST, ['npc-a', 'npc-b'])[0]).toEqual({
      kind: 'new',
      label: 'unnamed',
    });
  });
});

describe('labelCacheKey', () => {
  it('is a sha-256 hex digest that depends on the model and the request', async () => {
    const key = await labelCacheKey('glm', REQUEST);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await labelCacheKey('glm', REQUEST)).toBe(key);
    expect(await labelCacheKey('qwen', REQUEST)).not.toBe(key);
    expect(await labelCacheKey('glm', { ...REQUEST, seq: 74 })).not.toBe(key);
  });
});

describe('ModelLabeler', () => {
  const good = [
    { quote: 1, speaker: 'new:faceless creature' },
    { quote: 2, speaker: 'none' },
  ];

  it('asks the seat once, returns the labels, and caches the reply', async () => {
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const cache = new MemoryCache();
    const labeler = new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache });
    const result = await labeler.label(REQUEST);
    expect(result).toEqual({
      labels: [{ kind: 'new', label: 'faceless creature' }, { kind: 'none' }],
      source: 'model',
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ seat: 'script', tools: [], toolChoice: 'auto' });
    expect([...cache.entries.values()]).toEqual([{ labels: good }]);
  });

  it('retries once with the problem, then succeeds', async () => {
    const model = new ScriptedModelClient({
      script: [{ text: 'no idea', toolCalls: [] }, reply(good)],
    });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result.labels).not.toBeNull();
    expect(model.requests).toHaveLength(2);
    const retry = model.requests[1]!.messages.at(-1);
    expect(retry && 'content' in retry ? retry.content : '').toMatch(/could not be used/);
  });

  it('gives up after two unusable replies', async () => {
    const model = new ScriptedModelClient({
      script: [
        { text: 'no idea', toolCalls: [] },
        { text: 'still no idea', toolCalls: [] },
      ],
    });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result).toEqual({ labels: null, reason: expect.stringMatching(/model reply unusable/) });
  });

  it('reports an unavailable seat without throwing', async () => {
    const model = new ScriptedModelClient({ script: [{ throw: 'Every endpoint failed' }] });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm' }).label(REQUEST);
    expect(result).toEqual({
      labels: null,
      reason: expect.stringMatching(/seat "script" unavailable \(Every endpoint failed\)/),
    });
  });

  it('answers from the cache without calling the seat, unless refreshing', async () => {
    const cache = new MemoryCache();
    cache.entries.set(await labelCacheKey('glm', REQUEST), { labels: good });
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const cached = await new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache }).label(
      REQUEST
    );
    expect(cached.labels && cached.source).toBe('cache');
    expect(model.remaining('script')).toBe(1);

    const refreshed = await new ModelLabeler({
      model,
      seat: 'script',
      modelId: 'glm',
      cache,
      refresh: true,
    }).label(REQUEST);
    expect(refreshed.labels && refreshed.source).toBe('model');
    expect(model.remaining('script')).toBe(0);
  });

  it('ignores a cached value that no longer checks out', async () => {
    const cache = new MemoryCache();
    cache.entries.set(await labelCacheKey('glm', REQUEST), {
      labels: [{ quote: 1, speaker: 'x' }],
    });
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache }).label(
      REQUEST
    );
    expect(result.labels && result.source).toBe('model');
  });

  it('still returns the labels when the cache write fails', async () => {
    const cache: LabelCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error('disk full');
      },
    };
    const model = new ScriptedModelClient({ script: [reply(good)] });
    const result = await new ModelLabeler({ model, seat: 'script', modelId: 'glm', cache }).label(
      REQUEST
    );
    expect(result).toEqual({
      labels: [{ kind: 'new', label: 'faceless creature' }, { kind: 'none' }],
      source: 'model',
    });
  });

  it('caches a fallback model reply under that model, not the primary', async () => {
    const cache = new MemoryCache();
    const model = {
      complete: async () => ({ ...reply(good), model: 'fallback-model' }),
    };
    const labeler = new ModelLabeler({ model, seat: 'script', modelId: 'primary-model', cache });
    await labeler.label(REQUEST);
    expect(await cache.get(await labelCacheKey('fallback-model', REQUEST))).toBeDefined();
    expect(await cache.get(await labelCacheKey('primary-model', REQUEST))).toBeUndefined();
  });
});
