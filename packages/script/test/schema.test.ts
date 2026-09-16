import { describe, expect, it } from 'vitest';
import { ScriptFile, SpeakerOverrides } from '../src/schema';

describe('ScriptFile', () => {
  it('accepts a minimal script with a voiced line and a cue', () => {
    const parsed = ScriptFile.safeParse({
      scriptSchemaVersion: 1,
      campaign: 'avalon',
      session: 3,
      eventsSha256: 'a'.repeat(64),
      speakers: [{ id: 'dm', name: 'Dungeon Master', kind: 'dm' }],
      lines: [
        {
          id: 'L0001',
          kind: 'narration',
          speaker: 'dm',
          text: 'Mist.',
          emotion: 'neutral',
          sources: [{ seq: 2, start: 0, end: 5 }],
        },
        {
          id: 'L0002',
          kind: 'scene',
          sources: [{ seq: 1 }],
          scene: { location: 'Road', artPrompt: 'A road' },
        },
      ],
      notes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    expect(
      ScriptFile.safeParse({
        scriptSchemaVersion: 2,
        campaign: 'a',
        session: 1,
        eventsSha256: 'a'.repeat(64),
        speakers: [],
        lines: [],
        notes: [],
      }).success
    ).toBe(false);
  });
});

describe('SpeakerOverrides', () => {
  it('accepts ids and names and rejects unknown fields', () => {
    expect(SpeakerOverrides.safeParse({ 'npc-a': { id: 'npc-b', name: 'B' } }).success).toBe(true);
    expect(SpeakerOverrides.safeParse({ 'npc-a': { voice: 'x' } }).success).toBe(false);
  });
});
