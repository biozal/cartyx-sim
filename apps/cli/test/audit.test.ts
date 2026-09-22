import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder, type ModelClient, type SimEvent } from '@cartyx-sim/core';
import { LanceStore } from '@cartyx-sim/lore';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_VERSION,
  buildAudit,
  clusterGaps,
  findContradictions,
  formatAuditSummary,
  normalizeQuery,
  renderAuditMarkdown,
  summarizeEntityTypes,
  runAudit,
  type Audit,
} from '../src/audit';
import { JsonlFileSink } from '../src/jsonl-sink';

let seq = 0;
function event(partial: Record<string, unknown>): SimEvent {
  return {
    seq: seq++,
    ts: '2026-09-20T00:00:00.000Z',
    turnId: 't1',
    visibility: 'dm',
    ...partial,
  } as SimEvent;
}

/** The same event, in a named turn: the default fixture turn is `t1` for everything. */
function turnEvent(turnId: string, partial: Record<string, unknown>): SimEvent {
  return event({ turnId, ...partial });
}

describe('normalizeQuery', () => {
  it('lowercases, drops filler, and keeps meaningful words', () => {
    expect(normalizeQuery('Who is the Warden of the Old Stone Bridge?')).toEqual([
      'warden',
      'old',
      'stone',
      'bridge',
    ]);
  });
});

describe('clusterGaps', () => {
  it('groups queries that share most of their words and ranks by frequency', () => {
    const clusters = clusterGaps([
      { query: 'the Old Stone Bridge', seq: 1 },
      { query: 'Old Stone Bridge history', seq: 2 },
      { query: 'Warden Silas Thorne', seq: 3 },
    ]);
    expect(clusters[0]!.count).toBe(2);
    expect(clusters[0]!.queries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(clusters[1]!.count).toBe(1);
  });
});

describe('buildAudit', () => {
  const events: SimEvent[] = [
    event({
      type: 'session_start',
      visibility: 'public',
      session: 1,
      loreCommit: 'abc123',
      targetMinutes: 60,
      party: [],
      seats: { dm: 'dm', players: {} },
    }),
    event({
      type: 'lore_lookup',
      query: 'Professor Sella Vaunt',
      hits: [
        {
          chunkId: 'c1',
          source: 'dm/avalon.md',
          score: 0.71,
          entityId: 'kanka-2418574',
          entityName: 'Professor Sella Vaunt',
          entityType: 'character',
        },
        {
          chunkId: 'c2',
          source: 'kanka/…',
          score: 0.64,
          entityId: 'kanka-2418574',
          entityName: 'Professor Sella Vaunt',
          entityType: 'character',
        },
      ],
      used: ['c1'],
    }),
    event({ type: 'lore_lookup', query: 'the Old Stone Bridge', hits: [], used: [] }),
    event({ type: 'lore_lookup', query: 'Old Stone Bridge history', hits: [], used: [] }),
    event({
      type: 'lore_invention',
      fact: 'The bridge is warded with a salt line.',
      reason: 'no lore',
      query: 'the Old Stone Bridge',
      narrationSeq: 5,
    }),
    event({
      type: 'narration',
      visibility: 'public',
      speaker: 'dm',
      emotion: 'neutral',
      text: 'A salt line crosses the bridge’s threshold.',
    }),
    event({
      type: 'npc_introduced',
      visibility: 'public',
      npcId: 'npc-elias',
      name: 'Elias',
      description: 'A steward.',
      invented: false,
      loreEntityId: 'kanka-999',
    }),
    event({
      type: 'npc_introduced',
      visibility: 'public',
      npcId: 'npc-borin',
      name: 'Borin',
      description: 'A smith.',
      invented: true,
    }),
    event({
      type: 'scene_change',
      visibility: 'public',
      location: 'the manor foyer',
      artPrompt: 'a foyer',
    }),
  ];

  const audit = buildAudit({ campaign: 'avalon', session: 1, events });

  it('stamps the audit version and identifies the campaign and session', () => {
    expect(audit.auditVersion).toBe(AUDIT_VERSION);
    expect(audit.campaign).toBe('avalon');
    expect(audit.session).toBe(1);
  });

  it('records the lore commit from session_start', () => {
    expect(audit.loreCommit).toBe('abc123');
  });

  it('reports only lookups that found nothing usable as gaps', () => {
    expect(audit.gaps.map((cluster) => cluster.count)).toEqual([2]);
    expect(audit.gaps[0]!.queries.map((entry) => entry.query)).toEqual([
      'the Old Stone Bridge',
      'Old Stone Bridge history',
    ]);
  });

  it('links each invention to its narration text and where it falls in the session', () => {
    expect(audit.inventions).toHaveLength(1);
    expect(audit.inventions[0]!.narration).toBe('A salt line crosses the bridge’s threshold.');
    expect(audit.inventions[0]!.query).toBe('the Old Stone Bridge');
    expect(audit.inventions[0]!.spokenMinutes).toBeGreaterThan(0);
  });

  it('counts an entity once per lookup, not once per chunk', () => {
    expect(audit.coverage).toEqual([
      {
        entityId: 'kanka-2418574',
        entityName: 'Professor Sella Vaunt',
        entityType: 'character',
        lookups: 1,
      },
    ]);
  });

  it('splits NPCs into lore-backed and invented', () => {
    expect(audit.npcs).toEqual([
      { npcId: 'npc-elias', name: 'Elias', loreEntityId: 'kanka-999', invented: false },
      { npcId: 'npc-borin', name: 'Borin', invented: true },
    ]);
  });

  it('lists scenes and whether they were tied to lore', () => {
    expect(audit.scenes).toEqual([{ seq: 8, location: 'the manor foyer' }]);
  });
});

describe('buildAudit npc invented flag', () => {
  it("reports the DM's own declared invented flag, not a guess from whether lore was linked", () => {
    // Invented and loreEntityId are independent questions on npc_introduced (see
    // packages/core/src/tools/narrative.ts): a lore-less NPC the DM did not mark invented must
    // not be reported as invented just because it has no loreEntityId.
    const events: SimEvent[] = [
      event({
        type: 'npc_introduced',
        visibility: 'public',
        npcId: 'npc-mira',
        name: 'Mira',
        description: 'A ferry operator with no lore entry.',
        invented: false,
      }),
    ];

    const audit = buildAudit({ campaign: 'avalon', session: 1, events });

    expect(audit.npcs).toEqual([{ npcId: 'npc-mira', name: 'Mira', invented: false }]);
  });
});

describe('buildAudit with a log written before Plan 2B', () => {
  it('keys coverage on chunkId when hits carry no entityId', () => {
    const events: SimEvent[] = [
      event({
        type: 'session_start',
        visibility: 'public',
        session: 1,
        loreCommit: 'pre-plan-2b',
        targetMinutes: 60,
        party: [],
      }),
      event({
        type: 'lore_lookup',
        query: 'the Sunken Archive',
        hits: [{ chunkId: 'chunk-77', source: 'dm/archive.md', score: 0.8 }],
        used: ['chunk-77'],
      }),
      event({
        type: 'lore_lookup',
        query: 'the Sunken Archive again',
        hits: [{ chunkId: 'chunk-77', source: 'dm/archive.md', score: 0.75 }],
        used: ['chunk-77'],
      }),
    ];

    const audit = buildAudit({ campaign: 'avalon', session: 1, events });

    expect(audit.coverage).toEqual([
      { entityId: 'chunk-77', entityName: 'chunk-77', entityType: 'unknown', lookups: 2 },
    ]);
    expect(audit.gaps).toEqual([]);
  });
});

describe('coverage by entity type', () => {
  function lookup(chunkId: string, entityId: string, entityType: string): SimEvent {
    return event({
      type: 'lore_lookup',
      query: `about ${entityId}`,
      hits: [
        {
          chunkId,
          source: `dm/${chunkId}.md`,
          score: 0.8,
          entityId,
          entityName: entityId,
          entityType,
        },
      ],
      used: [chunkId],
    });
  }

  const audit = buildAudit({
    campaign: 'avalon',
    session: 1,
    events: [
      lookup('c1', 'kanka-1', 'character'),
      lookup('c2', 'kanka-2', 'character'),
      lookup('c3', 'kanka-3', 'location'),
    ],
  });

  it('records the type the lookup logged, not a placeholder', () => {
    expect(audit.coverage.map((entry) => entry.entityType)).toEqual([
      'character',
      'character',
      'location',
    ]);
  });

  it('summarizes the mix for a lore author, ranked by count', () => {
    expect(summarizeEntityTypes(audit.coverage)).toBe('2 characters, 1 location');
  });

  it('says nothing about the type of a hit logged before the field existed', () => {
    const old = buildAudit({
      campaign: 'avalon',
      session: 1,
      events: [
        event({
          type: 'lore_lookup',
          query: 'the Sunken Archive',
          hits: [{ chunkId: 'chunk-77', source: 'dm/archive.md', score: 0.8 }],
          used: ['chunk-77'],
        }),
      ],
    });
    expect(old.coverage[0]!.entityType).toBe('unknown');
    expect(summarizeEntityTypes(old.coverage)).toBe('1 of unrecorded type');
  });

  it('prints the mix and a type column in the markdown', () => {
    const markdown = renderAuditMarkdown({ ...audit, contradictions: null });
    expect(markdown).toContain('3 entities used: 2 characters, 1 location.');
    expect(markdown).toContain('| entity | type | id | lookups |');
    expect(markdown).toContain('| kanka-3 | location | `kanka-3` | 1 |');
  });
});

describe('renderAuditMarkdown', () => {
  it('writes every section, and says when the checker pass was skipped', () => {
    const audit: Audit = {
      ...buildAudit({ campaign: 'avalon', session: 1, events: [] }),
      contradictions: null,
    };
    const markdown = renderAuditMarkdown(audit);
    expect(markdown).toContain('## Gaps');
    expect(markdown).toContain('## Inventions');
    expect(markdown).toContain('## Coverage');
    expect(markdown).toContain('## Possible contradictions');
    expect(markdown).toContain('Skipped');
  });

  it('reports contradictions found by the checker, when it ran', () => {
    const audit: Audit = {
      ...buildAudit({ campaign: 'avalon', session: 1, events: [] }),
      contradictions: [
        { seq: 12, narration: 'The bridge is made of iron.', chunkIds: ['c9'], note: 'mismatch' },
      ],
    };
    const markdown = renderAuditMarkdown(audit);
    expect(markdown).not.toContain('Skipped');
    expect(markdown).toContain('mismatch');
    expect(markdown).toContain('The bridge is made of iron.');
  });

  it('says so when the checker ran and found nothing', () => {
    const audit: Audit = {
      ...buildAudit({ campaign: 'avalon', session: 1, events: [] }),
      contradictions: [],
    };
    expect(renderAuditMarkdown(audit)).toContain('The checker found none.');
  });
});

describe('findContradictions', () => {
  const events: SimEvent[] = [
    event({
      type: 'lore_lookup',
      query: 'Professor Sella Vaunt',
      hits: [
        {
          chunkId: 'c1',
          source: 'dm/avalon.md',
          score: 0.8,
          entityId: 'kanka-1',
          entityName: 'Sella Vaunt',
        },
      ],
      used: ['c1'],
    }),
    event({ type: 'narration', visibility: 'public', text: 'Vaunt teaches technical dueling.' }),
    event({ type: 'lore_lookup', query: 'the bridge', hits: [], used: [] }),
    event({ type: 'narration', visibility: 'public', text: 'The bridge is old.' }),
  ];

  function stubModel(replies: string[]): ModelClient {
    let index = 0;
    return {
      async complete() {
        return { text: replies[index++]!, toolCalls: [], model: 'checker' };
      },
    };
  }

  const chunkText = async (chunkId: string) =>
    chunkId === 'c1' ? 'Sella Vaunt teaches applied crystal engines.' : undefined;

  it('asks only about narrations that followed a lookup with usable hits', async () => {
    let calls = 0;
    const model: ModelClient = {
      async complete() {
        calls++;
        return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
      },
    };
    await findContradictions({ events, model, seat: 'checker', chunkText });
    expect(calls).toBe(1);
  });

  it('sends the chunk text, not just its id', async () => {
    let sent = '';
    const model: ModelClient = {
      async complete(request) {
        sent = JSON.stringify(request.messages);
        return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
      },
    };
    await findContradictions({ events, model, seat: 'checker', chunkText });
    expect(sent).toContain('applied crystal engines');
  });

  it('skips a narration whose chunks cannot be fetched', async () => {
    let calls = 0;
    const model: ModelClient = {
      async complete() {
        calls++;
        return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
      },
    };
    await findContradictions({ events, model, seat: 'checker', chunkText: async () => undefined });
    expect(calls).toBe(0);
  });

  it('returns a finding when the checker says the narration conflicts', async () => {
    const found = await findContradictions({
      events,
      chunkText,
      model: stubModel(['{"conflicts": true, "note": "The lore says applied crystal engines."}']),
      seat: 'checker',
    });
    expect(found).toEqual([
      {
        seq: expect.any(Number),
        narration: 'Vaunt teaches technical dueling.',
        chunkIds: ['c1'],
        note: 'The lore says applied crystal engines.',
      },
    ]);
  });

  it('returns nothing when the checker says there is no conflict', async () => {
    const found = await findContradictions({
      events,
      chunkText,
      model: stubModel(['{"conflicts": false}']),
      seat: 'checker',
    });
    expect(found).toEqual([]);
  });

  it('skips a narration whose checker reply cannot be parsed, rather than failing the audit', async () => {
    const found = await findContradictions({
      events,
      chunkText,
      model: stubModel(['not json at all']),
      seat: 'checker',
    });
    expect(found).toEqual([]);
  });

  it('does not fail the pass when the checker seat throws', async () => {
    const model: ModelClient = {
      async complete() {
        throw new Error('seat unavailable');
      },
    };
    await expect(
      findContradictions({ events, model, seat: 'checker', chunkText })
    ).resolves.toEqual([]);
  });

  it('records only the chunk ids whose text actually resolved and was sent to the checker', async () => {
    const twoChunkEvents: SimEvent[] = [
      event({
        type: 'lore_lookup',
        query: 'two chunks',
        hits: [
          { chunkId: 'c1', source: 'dm/a.md', score: 0.9, entityId: 'kanka-1', entityName: 'A' },
          { chunkId: 'c2', source: 'dm/b.md', score: 0.8, entityId: 'kanka-2', entityName: 'B' },
        ],
        used: ['c1', 'c2'],
      }),
      event({ type: 'narration', visibility: 'public', text: 'Some narration.' }),
    ];
    // Only c1 resolves: c2 is used by the lookup but has since fallen out of the lore index.
    const onlyC1 = async (chunkId: string) => (chunkId === 'c1' ? 'text of c1' : undefined);

    const found = await findContradictions({
      events: twoChunkEvents,
      chunkText: onlyC1,
      model: stubModel(['{"conflicts": true, "note": "mismatch"}']),
      seat: 'checker',
    });

    expect(found).toEqual([
      { seq: expect.any(Number), narration: 'Some narration.', chunkIds: ['c1'], note: 'mismatch' },
    ]);
  });

  it('asks about only the first narration after a lookup, not a later one in the same streak', async () => {
    const twoNarrations: SimEvent[] = [
      event({
        type: 'lore_lookup',
        query: 'Professor Sella Vaunt',
        hits: [
          {
            chunkId: 'c1',
            source: 'dm/avalon.md',
            score: 0.8,
            entityId: 'kanka-1',
            entityName: 'Sella Vaunt',
          },
        ],
        used: ['c1'],
      }),
      event({ type: 'narration', visibility: 'public', text: 'Vaunt teaches technical dueling.' }),
      event({ type: 'narration', visibility: 'public', text: 'She waves her staff.' }),
    ];
    let calls = 0;
    const model: ModelClient = {
      async complete() {
        calls++;
        return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
      },
    };
    await findContradictions({ events: twoNarrations, model, seat: 'checker', chunkText });
    expect(calls).toBe(1);
  });

  it('does not pair a lookup with a narration from a later turn', async () => {
    // The DM looks lore up and hands off without narrating, so turn t1 narrates nothing. The
    // narration in t2 was written against whatever t2 retrieved — nothing here — and pairing it
    // with t1's chunks would record those ids in audit.json as its evidence (spec §7.4 item 4).
    const acrossTurns: SimEvent[] = [
      turnEvent('t1', {
        type: 'lore_lookup',
        query: 'Professor Sella Vaunt',
        hits: [
          {
            chunkId: 'c1',
            source: 'dm/avalon.md',
            score: 0.8,
            entityId: 'kanka-1',
            entityName: 'Sella Vaunt',
          },
        ],
        used: ['c1'],
      }),
      turnEvent('t1', { type: 'hand_off', target: { kind: 'party' }, responders: [] }),
      turnEvent('t1', { type: 'turn_end', actor: 'dm' }),
      turnEvent('t2', {
        type: 'narration',
        visibility: 'public',
        text: 'The corridor smells of cold iron.',
      }),
    ];
    let calls = 0;
    const model: ModelClient = {
      async complete() {
        calls++;
        return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
      },
    };
    await findContradictions({ events: acrossTurns, model, seat: 'checker', chunkText });
    expect(calls).toBe(0);
  });

  it('still pairs a lookup with a narration in its own turn', async () => {
    const sameTurn: SimEvent[] = [
      turnEvent('t7', {
        type: 'lore_lookup',
        query: 'Professor Sella Vaunt',
        hits: [
          {
            chunkId: 'c1',
            source: 'dm/avalon.md',
            score: 0.8,
            entityId: 'kanka-1',
            entityName: 'Sella Vaunt',
          },
        ],
        used: ['c1'],
      }),
      turnEvent('t7', {
        type: 'narration',
        visibility: 'public',
        text: 'Vaunt teaches technical dueling.',
      }),
    ];
    const found = await findContradictions({
      events: sameTurn,
      chunkText,
      model: stubModel(['{"conflicts": true, "note": "mismatch"}']),
      seat: 'checker',
    });
    expect(found).toEqual([
      {
        seq: expect.any(Number),
        narration: 'Vaunt teaches technical dueling.',
        chunkIds: ['c1'],
        note: 'mismatch',
      },
    ]);
  });
});

describe('runAudit', () => {
  let campaignsDir: string;
  let sessionPath: string;

  function sessionEvents() {
    const recorder = new TurnRecorder(
      initialState(),
      'turn-1',
      () => new Date('2026-09-20T12:00:00Z')
    );
    recorder.emit({
      type: 'session_start',
      session: 1,
      loreCommit: 'lore-abc',
      targetMinutes: 10,
      party: [makeCombatant({ id: 'kira', name: 'Kira Vale' })],
    });
    recorder.emit({
      type: 'lore_lookup',
      query: 'the Old Stone Bridge',
      hits: [],
      used: [],
    });
    recorder.emit({
      type: 'lore_invention',
      fact: 'The bridge is warded with a salt line.',
      reason: 'no lore',
      query: 'the Old Stone Bridge',
    });
    recorder.emit({
      type: 'narration',
      speaker: 'dm',
      emotion: 'neutral',
      text: 'A salt line crosses the threshold.',
    });
    recorder.linkInventions();
    return [...recorder.events];
  }

  beforeEach(async () => {
    campaignsDir = await mkdtemp(join(tmpdir(), 'cartyx-sim-audit-'));
    sessionPath = join(campaignsDir, 'live', 'sessions', '001');
    await new JsonlFileSink(join(sessionPath, 'events.jsonl')).append(sessionEvents());
  });

  afterEach(async () => {
    await rm(campaignsDir, { recursive: true, force: true });
  });

  it('writes audit.md and audit.json from the event log alone', async () => {
    const result = await runAudit({
      campaignsDir,
      campaign: 'live',
      session: 1,
      useModel: false,
    });

    expect(result.markdownPath).toBe(join(sessionPath, 'audit.md'));
    expect(result.auditPath).toBe(join(sessionPath, 'audit.json'));
    expect(result.audit.loreCommit).toBe('lore-abc');
    expect(result.audit.inventions).toHaveLength(1);
    expect(result.audit.contradictions).toBeNull();

    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(await readFile(result.auditPath, 'utf8')) as Audit;
    expect(written.contradictions).toBeNull();
    const markdown = await readFile(result.markdownPath, 'utf8');
    expect(markdown).toContain('## Gaps');
  });

  describe('the contradiction checker pass', () => {
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

    async function writeCampaignJson(seats: Record<string, unknown> = {}) {
      const dir = join(campaignsDir, 'live');
      await mkdir(join(dir, 'characters'), { recursive: true });
      await writeFile(join(dir, 'characters', 'kira.json'), JSON.stringify(KIRA_FILE));
      await writeFile(
        join(dir, 'campaign.json'),
        JSON.stringify({
          name: 'Live',
          targetMinutes: 10,
          endpoints: { local: { baseURL: 'http://localhost:1234/v1' } },
          seats: {
            dm: { endpoint: 'local', model: 'dm-model' },
            players: { kira: { endpoint: 'local', model: 'player-model' } },
            ...seats,
          },
        })
      );
    }

    async function writeLoreIndex(
      chunks: { chunkId: string; text: string; entityId: string }[]
    ): Promise<string> {
      const indexDir = join(campaignsDir, 'live', '.cache', 'lore-index');
      await LanceStore.write(
        indexDir,
        chunks.map((chunk) => ({
          chunk: {
            chunkId: chunk.chunkId,
            source: 'dm/lore.md',
            title: chunk.chunkId,
            text: chunk.text,
            entityId: chunk.entityId,
            entityName: chunk.chunkId,
            entityType: 'character',
          },
          vector: new Float32Array([1, 0, 0]),
        }))
      );
      await writeFile(
        join(indexDir, 'meta.json'),
        JSON.stringify({
          lorePath: '/tmp/lore',
          loreCommit: 'lore-abc',
          contentDigest: 'digest',
          embedModel: 'test-embed',
          dims: 3,
          documentPrefix: '',
          queryPrefix: '',
          chunkerVersion: 1,
          files: 1,
          chunks: chunks.length,
          builtAt: '2026-09-20T00:00:00.000Z',
          ambiguous: [],
        })
      );
      return indexDir;
    }

    /** A second session (so it does not collide with the outer `beforeEach`'s session 1) whose
     * lookup has a usable hit, followed by a narration that draws on it — the shape the checker
     * pass actually acts on. */
    async function writeUsableLookupSession(session: number): Promise<void> {
      const recorder = new TurnRecorder(
        initialState(),
        'turn-1',
        () => new Date('2026-09-20T12:00:00Z')
      );
      recorder.emit({
        type: 'session_start',
        session,
        loreCommit: 'lore-abc',
        targetMinutes: 10,
        party: [makeCombatant({ id: 'kira', name: 'Kira Vale' })],
      });
      recorder.emit({
        type: 'lore_lookup',
        query: 'Sella Vaunt',
        hits: [
          {
            chunkId: 'c1',
            source: 'dm/avalon.md',
            score: 0.8,
            entityId: 'kanka-1',
            entityName: 'Sella Vaunt',
          },
        ],
        used: ['c1'],
      });
      recorder.emit({
        type: 'narration',
        speaker: 'dm',
        emotion: 'neutral',
        text: 'Vaunt teaches technical dueling.',
      });
      const path = join(
        campaignsDir,
        'live',
        'sessions',
        String(session).padStart(3, '0'),
        'events.jsonl'
      );
      await new JsonlFileSink(path).append([...recorder.events]);
    }

    it('does not run without a campaign checker seat, and says so', async () => {
      await writeCampaignJson();
      const lines: string[] = [];
      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 1,
        useModel: true,
        log: (line) => lines.push(line),
      });
      expect(result.audit.contradictions).toBeNull();
      expect(lines.some((line) => line.includes('no checker seat'))).toBe(true);
      expect(result.audit.contradictionsSkipped).toContain('no checker seat');
      const { readFile } = await import('node:fs/promises');
      const markdown = await readFile(result.markdownPath, 'utf8');
      expect(markdown).toContain('no checker seat');
    });

    it('does not run without a lore index, and says so', async () => {
      await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
      const lines: string[] = [];
      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 1,
        useModel: true,
        log: (line) => lines.push(line),
      });
      expect(result.audit.contradictions).toBeNull();
      expect(lines.some((line) => line.includes('no lore index'))).toBe(true);
      expect(result.audit.contradictionsSkipped).toContain('no lore index');
    });

    it('stays null with --no-model even when a checker seat and lore index both exist', async () => {
      await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
      await writeLoreIndex([{ chunkId: 'c1', text: 'chunk text', entityId: 'kanka-1' }]);
      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 1,
        useModel: false,
      });
      expect(result.audit.contradictions).toBeNull();
    });

    it('runs the checker, reports its finding, and closes the lore index store', async () => {
      await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
      await writeLoreIndex([
        {
          chunkId: 'c1',
          text: 'Sella Vaunt teaches applied crystal engines.',
          entityId: 'kanka-1',
        },
      ]);
      await writeUsableLookupSession(2);

      let calls = 0;
      const model: ModelClient = {
        async complete() {
          calls++;
          return {
            text: '{"conflicts": true, "note": "The lore says applied crystal engines."}',
            toolCalls: [],
            model: 'checker',
          };
        },
      };
      const closeSpy = vi.spyOn(LanceStore.prototype, 'close');

      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 2,
        useModel: true,
        model,
      });

      expect(calls).toBe(1);
      expect(result.audit.contradictions).toEqual([
        {
          seq: expect.any(Number),
          narration: 'Vaunt teaches technical dueling.',
          chunkIds: ['c1'],
          note: 'The lore says applied crystal engines.',
        },
      ]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockRestore();
    });

    it('still closes the lore index store when the checker seat fails', async () => {
      await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
      await writeLoreIndex([
        {
          chunkId: 'c1',
          text: 'Sella Vaunt teaches applied crystal engines.',
          entityId: 'kanka-1',
        },
      ]);
      await writeUsableLookupSession(2);

      const model: ModelClient = {
        async complete() {
          throw new Error('seat unavailable');
        },
      };
      const closeSpy = vi.spyOn(LanceStore.prototype, 'close');

      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 2,
        useModel: true,
        model,
      });

      // The seat failure degrades the pass rather than crashing the audit, and the report is
      // still explicit that the checker ran and simply found nothing checkable.
      expect(result.audit.contradictions).toEqual([]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockRestore();
    });

    it('degrades to null, keeping the rest of the audit intact, when the lore store fails', async () => {
      await writeCampaignJson({ checker: { endpoint: 'local', model: 'checker-model' } });
      await writeLoreIndex([
        {
          chunkId: 'c1',
          text: 'Sella Vaunt teaches applied crystal engines.',
          entityId: 'kanka-1',
        },
      ]);
      await writeUsableLookupSession(2);

      // The lore index passed `readMeta` (it exists), but the query itself fails: IO error,
      // corruption, or lock contention with a concurrent `sim index`. This must not propagate out
      // of `runAudit` and take the gaps/inventions/coverage sections down with it — those read
      // only the event log and are meant to stay usable long after the lore has moved on.
      const byChunkIdSpy = vi
        .spyOn(LanceStore.prototype, 'byChunkId')
        .mockRejectedValue(new Error('lance is angry'));
      const closeSpy = vi.spyOn(LanceStore.prototype, 'close');
      let modelCalled = false;
      const model: ModelClient = {
        async complete() {
          modelCalled = true;
          return { text: '{"conflicts": false}', toolCalls: [], model: 'checker' };
        },
      };

      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 2,
        useModel: true,
        model,
      });

      expect(result.audit.contradictions).toBeNull();
      // Reports what is known — the pass failed, and with what message — without claiming a
      // diagnosis it never made. The broad catch also sees errors that have nothing to do with
      // the index, and this string is persisted into audit.json and printed into audit.md.
      expect(result.audit.contradictionsSkipped).toContain('the contradiction pass failed');
      expect(result.audit.contradictionsSkipped).toContain('lance is angry');
      expect(result.audit.contradictionsSkipped).not.toContain('index could not be read');
      expect(modelCalled).toBe(false);
      // The rest of the audit — built from the event log alone — is untouched by the store
      // failure: this session's usable lookup still counts as coverage.
      expect(result.audit.loreCommit).toBe('lore-abc');
      expect(result.audit.gaps).toEqual([]);
      expect(result.audit.coverage).toEqual([
        { entityId: 'kanka-1', entityName: 'Sella Vaunt', entityType: 'unknown', lookups: 1 },
      ]);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      byChunkIdSpy.mockRestore();
      closeSpy.mockRestore();
    });

    it('degrades to null, keeping the rest of the audit intact, when campaign.json is malformed', async () => {
      // `loadCampaign` happens inside the contradiction pass, and a config it cannot parse is a
      // reason to skip the fourth section — not to fail an audit whose other three sections were
      // already computed from the event log alone.
      const dir = join(campaignsDir, 'live');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'campaign.json'), '{ "name": "Broken"');

      const result = await runAudit({
        campaignsDir,
        campaign: 'live',
        session: 1,
        useModel: true,
        model: {
          async complete() {
            throw new Error('the checker must never be reached');
          },
        },
      });

      expect(result.audit.contradictions).toBeNull();
      expect(result.audit.contradictionsSkipped).toContain('the contradiction pass failed');
      expect(result.audit.loreCommit).toBe('lore-abc');
      expect(result.audit.inventions).toHaveLength(1);
    });
  });

  it('releases the session lock after reading', async () => {
    await runAudit({ campaignsDir, campaign: 'live', session: 1, useModel: false });
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(sessionPath, 'events.jsonl.lock'))).rejects.toThrow();
  });

  it('throws a clear error when there is no event log for the session', async () => {
    await expect(
      runAudit({ campaignsDir, campaign: 'live', session: 2, useModel: false })
    ).rejects.toThrow(/No event log at/);
  });
});

describe('formatAuditSummary', () => {
  it('prints counts for every section and both output paths', () => {
    const audit: Audit = {
      ...buildAudit({
        campaign: 'avalon',
        session: 1,
        events: [
          event({ type: 'lore_lookup', query: 'a gap', hits: [], used: [] }),
          event({
            type: 'lore_invention',
            fact: 'invented fact',
            reason: 'no lore',
          }),
        ],
      }),
      contradictions: null,
    };

    const lines = formatAuditSummary({
      markdownPath: '/tmp/audit.md',
      auditPath: '/tmp/audit.json',
      audit,
    });

    expect(lines).toEqual([
      'Gaps: 1 empty lookup in 1 topic',
      'Inventions: 1',
      'Entities covered: 0',
      'Contradictions: skipped',
      'Report: /tmp/audit.md',
      'Data: /tmp/audit.json',
    ]);
  });

  it('counts contradictions when the checker ran', () => {
    const audit: Audit = {
      ...buildAudit({ campaign: 'avalon', session: 1, events: [] }),
      contradictions: [
        { seq: 1, narration: 'x', chunkIds: [], note: 'y' },
        { seq: 2, narration: 'x', chunkIds: [], note: 'y' },
      ],
    };
    const lines = formatAuditSummary({
      markdownPath: '/tmp/audit.md',
      auditPath: '/tmp/audit.json',
      audit,
    });
    expect(lines).toContain('Contradictions: 2 contradictions');
  });
});
