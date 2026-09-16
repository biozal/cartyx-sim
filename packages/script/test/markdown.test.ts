import { describe, expect, it } from 'vitest';
import { renderScriptMarkdown } from '../src/markdown';
import type { ScriptFile } from '../src/schema';

const at = (seq: number, start: number, end: number) => [{ seq, start, end }];

const SCRIPT: ScriptFile = {
  scriptSchemaVersion: 1,
  campaign: 'avalon',
  session: 3,
  eventsSha256: 'a'.repeat(64),
  speakers: [
    { id: 'dm', name: 'Dungeon Master', kind: 'dm' },
    { id: 'kira', name: 'Kira Vale', kind: 'pc' },
    { id: 'tomas', name: 'Tomas Reed', kind: 'pc' },
    {
      id: 'npc-faceless-creature',
      name: 'Faceless creature',
      kind: 'npc',
      unlisted: true,
      firstSeq: 2,
    },
  ],
  lines: [
    {
      id: 'L0001',
      kind: 'scene',
      sources: [{ seq: 1 }],
      scene: { location: 'Eldergrove gate', artPrompt: 'Arch' },
    },
    {
      id: 'L0002',
      kind: 'narration',
      speaker: 'dm',
      text: 'The slit opens.',
      emotion: 'neutral',
      sources: at(2, 0, 15),
    },
    {
      id: 'L0003',
      kind: 'narration',
      speaker: 'dm',
      text: 'It waits.',
      emotion: 'neutral',
      sources: at(2, 17, 26),
    },
    {
      id: 'L0004',
      kind: 'dialogue',
      speaker: 'npc-faceless-creature',
      text: 'You... opened... the door.',
      emotion: 'neutral',
      sources: at(2, 30, 55),
    },
    {
      id: 'L0005',
      kind: 'narration',
      speaker: 'dm',
      text: 'it rasps.',
      emotion: 'neutral',
      sources: at(2, 57, 66),
    },
    {
      id: 'L0006',
      kind: 'dialogue',
      speaker: 'kira',
      text: 'Holding its breath.',
      emotion: 'whisper',
      sources: at(3, 1, 20),
      dropped: [
        { seq: 3, start: 22, end: 45, reason: 'stage_direction', text: 'I keep my *voice*\n low.' },
      ],
    },
    {
      id: 'L0007',
      kind: 'dialogue',
      speaker: 'tomas',
      text: 'Not now!',
      emotion: 'afraid',
      sources: at(4, 0, 8),
      overlaps: 'L0006',
    },
    {
      id: 'L0008',
      kind: 'action',
      speaker: 'tomas',
      text: 'Raise my shield.',
      emotion: 'neutral',
      sources: at(5, 0, 17),
    },
    {
      id: 'L0009',
      kind: 'roll',
      sources: [{ seq: 6 }],
      roll: {
        actor: 'tomas',
        actorName: 'Tomas Reed',
        kind: 'check',
        label: 'Tomas Reed Athletics check',
        total: 15,
        target: 12,
        outcome: 'success',
      },
    },
    {
      id: 'L0010',
      kind: 'roll',
      sources: [{ seq: 7 }],
      roll: {
        actor: 'tomas',
        actorName: 'Tomas Reed',
        kind: 'attack',
        label: 'Tomas Reed Longsword attack',
        total: 18,
        target: 13,
        outcome: 'hit',
      },
    },
    {
      id: 'L0011',
      kind: 'dialogue',
      speaker: 'dm',
      text: 'We go now.',
      emotion: 'neutral',
      sources: at(8, 12, 22),
      flags: { dmWrotePc: 'kira' },
    },
    {
      id: 'L0012',
      kind: 'combat',
      sources: [{ seq: 9 }],
      combat: {
        phase: 'start',
        order: [
          { combatantId: 'goblin-1', name: 'Goblin', total: 17 },
          { combatantId: 'kira', name: 'Kira Vale', total: 10 },
        ],
      },
    },
    {
      id: 'L0013',
      kind: 'combat',
      sources: [{ seq: 10 }],
      combat: { phase: 'turn', round: 1, combatantId: 'goblin-1', name: 'Goblin' },
    },
    {
      id: 'L0014',
      kind: 'state',
      sources: [{ seq: 11 }],
      state: { entity: 'goblin-1', name: 'Goblin', field: 'hp', before: 7, after: 3, hidden: true },
    },
    {
      id: 'L0015',
      kind: 'state',
      sources: [{ seq: 12 }],
      state: {
        entity: 'kira',
        name: 'Kira Vale',
        field: 'hp',
        before: 10,
        after: 4,
        hidden: false,
      },
    },
    {
      id: 'L0016',
      kind: 'state',
      sources: [{ seq: 13 }],
      state: {
        entity: 'kira',
        name: 'Kira Vale',
        field: 'conditions',
        before: [],
        after: ['prone'],
        hidden: false,
      },
    },
    {
      id: 'L0017',
      kind: 'state',
      sources: [{ seq: 14 }],
      state: {
        entity: 'goblin-1',
        name: 'Goblin',
        field: 'dead',
        before: false,
        after: true,
        hidden: true,
      },
    },
    { id: 'L0018', kind: 'pause', sources: [{ seq: 15 }], pause: { reason: 'Seat failed' } },
    { id: 'L0019', kind: 'combat', sources: [{ seq: 17 }], combat: { phase: 'end' } },
  ],
  notes: [{ seq: 2, text: 'Quotes attributed by rules: model reply unusable (x).' }],
};

describe('renderScriptMarkdown', () => {
  it('renders a script as a book-style read', () => {
    expect(renderScriptMarkdown(SCRIPT)).toBe(
      [
        '# avalon — Session 3',
        '',
        '- Lines: 8 spoken, 11 cues · spoken words: 22 (~0.1 min)',
        '- Unlisted NPC speakers: Faceless creature (npc-faceless-creature)',
        '- Notes: 1 (listed at the end)',
        '',
        '---',
        '',
        '## Eldergrove gate',
        '',
        '**DM:** The slit opens.',
        '',
        'It waits.',
        '',
        '**Faceless creature:** You... opened... the door.',
        '',
        '**DM:** it rasps.',
        '',
        '**Kira Vale:** Holding its breath. *(I keep my voice low.)*',
        '',
        '**Tomas Reed:** *(interrupting)* Not now!',
        '',
        '> *Tomas Reed:* Raise my shield.',
        '',
        '> 🎲 *Tomas Reed Athletics check:* 15 vs 12 — success',
        '',
        '> 🎲 *Tomas Reed Longsword attack:* 18 — hit',
        '',
        '**DM (as Kira Vale):** We go now.',
        '',
        '*Combat begins. Initiative: Goblin 17, Kira Vale 10.*',
        '',
        "*Round 1: Goblin's turn.*",
        '',
        '*Goblin is wounded.*',
        '',
        '*Kira Vale: HP 10 → 4.*',
        '',
        '*Kira Vale conditions: prone.*',
        '',
        '*Goblin dies.*',
        '',
        '---',
        '',
        '*The session paused here and resumed later.*',
        '',
        '---',
        '',
        '*Combat ends.*',
        '',
        '## Notes',
        '',
        '- Event 2: Quotes attributed by rules: model reply unusable (x).',
        '',
      ].join('\n')
    );
  });

  it('shows a downed or recovering hidden entity without numbers', () => {
    const state = (before: number, after: number) =>
      renderScriptMarkdown({
        ...SCRIPT,
        speakers: [],
        notes: [],
        lines: [
          {
            id: 'L0001',
            kind: 'state',
            sources: [{ seq: 1 }],
            state: { entity: 'g', name: 'Goblin', field: 'hp', before, after, hidden: true },
          },
        ],
      });
    expect(state(3, 0)).toContain('*Goblin is down.*');
    expect(state(0, 4)).toContain('*Goblin recovers.*');
  });

  it('adds no line for an unchanged hidden HP value, and flags one that cannot be compared', () => {
    const state = (before: unknown, after: unknown) =>
      renderScriptMarkdown({
        ...SCRIPT,
        speakers: [],
        notes: [],
        lines: [
          {
            id: 'L0001',
            kind: 'state',
            sources: [{ seq: 1 }],
            state: { entity: 'g', name: 'Goblin', field: 'hp', before, after, hidden: true },
          },
        ],
      });
    expect(state(4, 4)).not.toContain('Goblin');
    expect(state('?', 3)).toContain("*Goblin's condition changes.*");
  });
});
