import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, TurnRecorder, type SimEvent } from '@cartyx-sim/core';
import { makeCombatant } from '@cartyx-sim/rules/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_VERSION,
  buildAudit,
  clusterGaps,
  formatAuditSummary,
  normalizeQuery,
  renderAuditMarkdown,
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
        },
        {
          chunkId: 'c2',
          source: 'kanka/…',
          score: 0.64,
          entityId: 'kanka-2418574',
          entityName: 'Professor Sella Vaunt',
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
        entityType: 'unknown',
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

  it('leaves contradictions null whether or not --model is requested, since no checker exists yet', async () => {
    const withModel = await runAudit({
      campaignsDir,
      campaign: 'live',
      session: 1,
      useModel: true,
    });
    expect(withModel.audit.contradictions).toBeNull();
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
