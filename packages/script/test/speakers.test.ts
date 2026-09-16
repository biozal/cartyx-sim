import { describe, expect, it } from 'vitest';
import type { ScriptLine, Speaker } from '../src/schema';
import { applySpeakerOverrides, SpeakerTable } from '../src/speakers';

const PARTY = [
  { id: 'kira', name: 'Kira Vale' },
  { id: 'tomas', name: 'Tomas Reed' },
];

function table(): Speaker[] {
  const speakers = new SpeakerTable(PARTY);
  speakers.unlisted('npc-thing', 'Thing', 40);
  speakers.unlisted('npc-faceless-creature', 'Faceless creature', 73);
  speakers.npc('npc-warden', 'The Warden');
  return speakers.list();
}

function line(id: string, speaker: string): ScriptLine {
  return {
    id,
    kind: 'dialogue',
    speaker,
    text: 'Hm.',
    emotion: 'neutral',
    sources: [{ seq: 1, start: 0, end: 3 }],
  };
}

describe('SpeakerTable', () => {
  it('starts with the DM and the party and adds NPCs once, in order', () => {
    const speakers = new SpeakerTable(PARTY);
    expect(speakers.npc('npc-warden', 'The Warden')).toBe('npc-warden');
    expect(speakers.npc('npc-warden', 'Someone Else')).toBe('npc-warden');
    expect(speakers.unlisted('npc-thing', 'Thing', 12)).toBe('npc-thing');
    expect(speakers.unlisted('npc-thing', 'Other', 99)).toBe('npc-thing');
    expect(speakers.pc('bram')).toBe('bram');
    expect(speakers.list()).toEqual([
      { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
      { id: 'kira', name: 'Kira Vale', kind: 'pc' },
      { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
      { id: 'npc-warden', name: 'The Warden', kind: 'npc' },
      { id: 'npc-thing', name: 'Thing', kind: 'npc', unlisted: true, firstSeq: 12 },
      { id: 'bram', name: 'bram', kind: 'pc' },
    ]);
  });
});

describe('SpeakerTable.promote', () => {
  it('turns an unlisted NPC into a listed one, keeping its position', () => {
    const speakers = new SpeakerTable(PARTY);
    speakers.unlisted('npc-thing', 'Thing', 12);
    speakers.npc('npc-warden', 'The Warden');
    speakers.promote('npc-thing', 'The Thing');
    expect(speakers.list()).toEqual([
      { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
      { id: 'kira', name: 'Kira Vale', kind: 'pc' },
      { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
      { id: 'npc-thing', name: 'The Thing', kind: 'npc' },
      { id: 'npc-warden', name: 'The Warden', kind: 'npc' },
    ]);
  });

  it('does nothing to an already-listed speaker', () => {
    const speakers = new SpeakerTable(PARTY);
    speakers.npc('npc-warden', 'The Warden');
    speakers.promote('npc-warden', 'Someone Else');
    expect(speakers.list()).toContainEqual({ id: 'npc-warden', name: 'The Warden', kind: 'npc' });
  });

  it('does nothing for an unknown id', () => {
    const speakers = new SpeakerTable(PARTY);
    speakers.promote('npc-ghost', 'Ghost');
    expect(speakers.list().map((s) => s.id)).not.toContain('npc-ghost');
  });
});

describe('applySpeakerOverrides', () => {
  it('renames a speaker', () => {
    const result = applySpeakerOverrides(table(), [], {
      'npc-faceless-creature': { name: 'The Faceless One' },
      kira: { id: 'kira', name: 'Kira' },
    });
    expect(result.speakers.find((s) => s.id === 'npc-faceless-creature')?.name).toBe(
      'The Faceless One'
    );
    expect(result.speakers.find((s) => s.id === 'kira')?.name).toBe('Kira');
  });

  it('merges an NPC into another, moving its lines and keeping the earliest first seq', () => {
    const result = applySpeakerOverrides(
      table(),
      [line('L0001', 'npc-thing'), line('L0002', 'kira')],
      { 'npc-thing': { id: 'npc-faceless-creature' } }
    );
    expect(result.speakers.map((s) => s.id)).toEqual([
      'dm',
      'kira',
      'tomas',
      'npc-faceless-creature',
      'npc-warden',
    ]);
    expect(result.speakers.find((s) => s.id === 'npc-faceless-creature')?.firstSeq).toBe(40);
    expect(result.lines.map((l) => ('speaker' in l ? l.speaker : ''))).toEqual([
      'npc-faceless-creature',
      'kira',
    ]);
  });

  it.each([
    ['an unknown key', { 'npc-ghost': { name: 'Ghost' } }, /"npc-ghost" is not a speaker/],
    ['merging a PC', { kira: { id: 'npc-warden' } }, /"kira" is a pc; only NPCs can be merged/],
    [
      'merging into an unknown speaker',
      { 'npc-thing': { id: 'npc-ghost' } },
      /merges into "npc-ghost", which is not a speaker/,
    ],
    ['merging into the DM', { 'npc-thing': { id: 'dm' } }, /cannot merge into the dm "dm"/],
    [
      'setting both a merge and a name',
      { 'npc-thing': { id: 'npc-warden', name: 'X' } },
      /sets both "id" and "name"/,
    ],
    [
      'merging into a merged speaker',
      {
        'npc-thing': { id: 'npc-faceless-creature' },
        'npc-faceless-creature': { id: 'npc-warden' },
      },
      /which is itself merged; merge into "npc-warden" instead/,
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => applySpeakerOverrides(table(), [], overrides)).toThrow(message);
    expect(() => applySpeakerOverrides(table(), [], overrides)).toThrow(/^speakers\.json: /);
  });
});
