import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { buildScript } from '../src/build';
import { isVoiced, ScriptError, type ScriptFile } from '../src/schema';
import { eventLog, FakeLabeler, KIRA, narration, SHA, TOMAS } from './helpers';

const CREATURE = 'The slit opens.\n\n*"You... opened... the door,"* it rasps.\n\n**Hand off.**';

const TABLE_LOG = eventLog([
  { type: 'scene_change', location: 'Eldergrove gate', artPrompt: 'A ruined arch' }, // 1
  narration(CREATURE), // 2
  {
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    emotion: 'whisper',
    text: '"Holding its breath." I keep my voice low. "Or holding us."',
  }, // 3
  {
    type: 'dialogue',
    speaker: 'tomas',
    speakerKind: 'pc',
    emotion: 'afraid',
    text: 'Not now!',
    overlaps: 3,
  }, // 4
  { type: 'action', actor: 'tomas', intent: 'Raise my *shield*' }, // 5
  {
    type: 'roll',
    actor: 'tomas',
    kind: 'check',
    label: 'Tomas Reed Athletics check',
    expr: '1d20+3',
    rolls: [12],
    modifier: 3,
    total: 15,
    target: 12,
    outcome: 'success',
    mode: 'normal',
  }, // 6
  { type: 'ooc_note', visibility: 'dm', text: 'Checker reply: {}' }, // 7
  {
    type: 'npc_introduced',
    npcId: 'npc-warden',
    name: 'The Warden',
    description: 'A stone guardian',
    invented: true,
  }, // 8
  {
    type: 'dialogue',
    speaker: 'npc-warden',
    speakerKind: 'npc',
    emotion: 'angry',
    text: 'Leave.',
  }, // 9
]);

const creatureLabeler = () =>
  new FakeLabeler(() => ({
    labels: [{ kind: 'new', label: 'faceless creature' }],
    source: 'model',
  }));

function build(events = TABLE_LOG, extra: Partial<Parameters<typeof buildScript>[0]> = {}) {
  return buildScript({ campaign: 'avalon', session: 3, eventsSha256: SHA, events, ...extra });
}

function summary(script: ScriptFile) {
  return script.lines.map((line) =>
    'text' in line ? [line.id, line.kind, line.speaker, line.text] : [line.id, line.kind]
  );
}

describe('buildScript', () => {
  it('turns a table exchange into ordered, attributed lines and cues', async () => {
    const labeler = creatureLabeler();
    const { script, stats } = await build(TABLE_LOG, { labeler });

    expect(summary(script)).toEqual([
      ['L0001', 'scene'],
      ['L0002', 'narration', 'dm', 'The slit opens.'],
      ['L0003', 'dialogue', 'npc-faceless-creature', 'You... opened... the door.'],
      ['L0004', 'narration', 'dm', 'it rasps.'],
      ['L0005', 'dialogue', 'kira', 'Holding its breath.'],
      ['L0006', 'dialogue', 'kira', 'Or holding us.'],
      ['L0007', 'dialogue', 'tomas', 'Not now!'],
      ['L0008', 'action', 'tomas', 'Raise my shield.'],
      ['L0009', 'roll'],
      ['L0010', 'dialogue', 'npc-warden', 'Leave.'],
    ]);
    expect(script).toMatchObject({
      scriptSchemaVersion: 1,
      campaign: 'avalon',
      session: 3,
      eventsSha256: SHA,
      notes: [],
    });
    expect(script.speakers).toEqual([
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
      { id: 'npc-warden', name: 'The Warden', kind: 'npc' },
    ]);

    const [, , dialogue, rasps, kira, , tomas] = script.lines;
    expect(dialogue).toMatchObject({ emotion: 'neutral' });
    expect(rasps).toMatchObject({
      emotion: 'neutral',
      dropped: [{ seq: 2, reason: 'hand_off', text: '**Hand off.**' }],
    });
    expect(kira).toMatchObject({
      emotion: 'whisper',
      dropped: [{ seq: 3, reason: 'stage_direction', text: 'I keep my voice low.' }],
    });
    expect(tomas).toMatchObject({ overlaps: 'L0005' });
    expect(script.lines[8]).toMatchObject({
      sources: [{ seq: 6 }],
      roll: { actor: 'tomas', actorName: 'Tomas Reed', total: 15, target: 12, outcome: 'success' },
    });

    expect(stats).toEqual({
      lines: { scene: 1, narration: 2, dialogue: 5, action: 1, roll: 1 },
      labels: { model: 1, cache: 0, fallback: 0 },
      stageDirections: 1,
      spokenWords: 21,
      unlisted: ['npc-faceless-creature'],
    });
    expect(labeler.requests).toEqual([
      {
        seq: 2,
        narration: 'The slit opens.\n\n[[1]]"You... opened... the door," it rasps.',
        quotes: ['You... opened... the door.'],
        npcs: [],
        pcs: [
          { id: 'kira', name: 'Kira Vale' },
          { id: 'tomas', name: 'Tomas Reed' },
        ],
        newLabels: [],
      },
    ]);
  });

  it('adds cues for combat, visible state changes, and a resumed pause', async () => {
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 7,
      maxHp: 7,
    });
    const events = eventLog([
      { type: 'combatant_added', combatant: goblin },
      {
        type: 'combat_start',
        order: [
          { combatantId: 'goblin-1', roll: 15, dexMod: 2, total: 17 },
          { combatantId: 'kira', roll: 10, dexMod: 0, total: 10 },
          { combatantId: 'tomas', roll: 6, dexMod: 0, total: 6 },
        ],
      },
      { type: 'combat_turn', round: 1, turnIndex: 0, combatantId: 'goblin-1' },
      { type: 'state_change', entity: 'goblin-1', field: 'hp', before: 7, after: 3, cause: 'hit' },
      { type: 'state_change', entity: 'kira', field: 'tempHp', before: 0, after: 2, cause: 'x' },
      { type: 'session_paused', visibility: 'dm', seat: 'dm', reason: 'Seat failed', kind: 'seat' },
      { type: 'ooc_note', visibility: 'dm', text: 'Session resumed.' },
      { type: 'combat_end' },
    ]);
    const { script } = await build(events);
    expect(script.lines).toEqual([
      {
        id: 'L0001',
        kind: 'combat',
        sources: [{ seq: 2 }],
        combat: {
          phase: 'start',
          order: [
            { combatantId: 'goblin-1', name: 'Goblin', total: 17 },
            { combatantId: 'kira', name: 'Kira Vale', total: 10 },
            { combatantId: 'tomas', name: 'Tomas Reed', total: 6 },
          ],
        },
      },
      {
        id: 'L0002',
        kind: 'combat',
        sources: [{ seq: 3 }],
        combat: { phase: 'turn', round: 1, combatantId: 'goblin-1', name: 'Goblin' },
      },
      {
        id: 'L0003',
        kind: 'state',
        sources: [{ seq: 4 }],
        state: {
          entity: 'goblin-1',
          name: 'Goblin',
          field: 'hp',
          before: 7,
          after: 3,
          hidden: true,
        },
      },
      { id: 'L0004', kind: 'pause', sources: [{ seq: 6 }], pause: { reason: 'Seat failed' } },
      { id: 'L0005', kind: 'combat', sources: [{ seq: 8 }], combat: { phase: 'end' } },
    ]);
  });

  it('keeps every pause when the session pauses more than once in a row', async () => {
    const events = eventLog([
      { type: 'session_paused', visibility: 'dm', seat: 'dm', reason: 'Seat failed', kind: 'seat' },
      {
        type: 'session_paused',
        visibility: 'dm',
        seat: 'player',
        reason: 'Player disconnected',
        kind: 'seat',
      },
      narration('The fire crackles.'),
    ]);
    const { script } = await build(events);
    expect(summary(script)).toEqual([
      ['L0001', 'pause'],
      ['L0002', 'pause'],
      ['L0003', 'narration', 'dm', 'The fire crackles.'],
    ]);
    expect(script.lines[0]).toMatchObject({
      sources: [{ seq: 1 }],
      pause: { reason: 'Seat failed' },
    });
    expect(script.lines[1]).toMatchObject({
      sources: [{ seq: 2 }],
      pause: { reason: 'Player disconnected' },
    });
  });

  it('promotes an NPC named by the model before its npc_introduced event', async () => {
    const labeler = new FakeLabeler((request) =>
      request.seq === 1
        ? { labels: [{ kind: 'new', label: 'the warden' }], source: 'model' }
        : { labels: [{ kind: 'npc', id: 'npc-the-warden' }], source: 'model' }
    );
    const events = eventLog([
      narration('"Open the gate," a voice says.'),
      {
        type: 'npc_introduced',
        npcId: 'npc-the-warden',
        name: 'The Warden',
        description: 'A stone guardian',
        invented: true,
      },
      narration('"Now," the Warden says.'),
    ]);
    const { script } = await build(events, { labeler });
    expect(script.speakers.filter((speaker) => speaker.id === 'npc-the-warden')).toEqual([
      { id: 'npc-the-warden', name: 'The Warden', kind: 'npc' },
    ]);
    const dialogueLines = script.lines.filter((line) => isVoiced(line) && line.kind === 'dialogue');
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines.every((line) => isVoiced(line) && line.speaker === 'npc-the-warden')).toBe(
      true
    );
    expect(labeler.requests[1]!.newLabels).not.toContain('the warden');
  });

  it('attributes quotes by rules without a labeler, and says why when the labeler fails', async () => {
    const { script, stats } = await build();
    expect(script.lines[2]).toMatchObject({ speaker: 'npc-unnamed' });
    expect(script.speakers).toContainEqual({
      id: 'npc-unnamed',
      name: 'Unnamed',
      kind: 'npc',
      unlisted: true,
      firstSeq: 2,
    });
    expect(stats.labels).toEqual({ model: 0, cache: 0, fallback: 1 });
    expect(script.notes).toEqual([]);

    const failing = new FakeLabeler(() => ({
      labels: null,
      reason: 'script seat unavailable (down)',
    }));
    const failed = await build(TABLE_LOG, { labeler: failing });
    expect(failed.script.notes).toEqual([
      { seq: 2, text: 'Quotes attributed by rules: script seat unavailable (down).' },
    ]);
  });

  it('gives a quote to the only NPC in the scene when rules decide', async () => {
    const events = eventLog([
      { type: 'scene_change', location: 'Hall', artPrompt: 'A hall' },
      {
        type: 'npc_introduced',
        npcId: 'npc-warden',
        name: 'The Warden',
        description: 'A stone guardian',
        invented: true,
      },
      narration('It turns. "You should not be here."'),
    ]);
    const { script } = await build(events);
    expect(summary(script)).toContainEqual([
      'L0003',
      'dialogue',
      'npc-warden',
      'You should not be here.',
    ]);
  });

  it('uses an introduced NPC when a new label matches its id, and shares earlier labels', async () => {
    const events = eventLog([
      {
        type: 'npc_introduced',
        npcId: 'npc-faceless-creature',
        name: 'The Faceless',
        description: 'No face',
        invented: true,
      },
      narration('"Leave this place," it says.'),
      narration('"Now," it says again.'),
    ]);
    const labeler = new FakeLabeler((request) => ({
      labels: request.quotes.map(() => ({ kind: 'new', label: 'faceless creature' })),
      source: 'cache',
    }));
    const { script, stats } = await build(events, { labeler });
    expect(script.speakers.at(-1)).toEqual({
      id: 'npc-faceless-creature',
      name: 'The Faceless',
      kind: 'npc',
    });
    expect(labeler.requests[0]!.npcs).toEqual([
      { id: 'npc-faceless-creature', name: 'The Faceless', description: 'No face' },
    ]);
    expect(labeler.requests[1]!.newLabels).toEqual(['faceless creature']);
    expect(stats.labels.cache).toBe(2);
  });

  it('keeps DM-written PC dialogue in the DM voice with a flag', async () => {
    const events = eventLog([narration('Kira nods. "We go now," she says.')]);
    const labeler = new FakeLabeler(() => ({
      labels: [{ kind: 'pc', id: 'kira' }],
      source: 'model',
    }));
    const { script } = await build(events, { labeler });
    expect(script.lines[1]).toMatchObject({
      kind: 'dialogue',
      speaker: 'dm',
      text: 'We go now.',
      flags: { dmWrotePc: 'kira' },
    });
  });

  it('applies speakers.json overrides', async () => {
    const { script } = await build(TABLE_LOG, {
      labeler: creatureLabeler(),
      speakers: { 'npc-faceless-creature': { id: 'npc-warden' } },
    });
    expect(script.lines[2]).toMatchObject({ speaker: 'npc-warden' });
    expect(script.speakers.map((speaker) => speaker.id)).not.toContain('npc-faceless-creature');
    await expect(
      build(TABLE_LOG, { speakers: { 'npc-ghost': { name: 'Ghost' } } })
    ).rejects.toThrow(ScriptError);
  });

  it('keeps text dropped from an event with no line on a note', async () => {
    const { script } = await build(eventLog([narration('**Hand off.**')]));
    expect(script.lines).toEqual([]);
    expect(script.notes).toEqual([
      {
        seq: 1,
        text: 'Dropped text from an event that produced no line.',
        dropped: [{ seq: 1, start: 0, end: 13, reason: 'hand_off', text: '**Hand off.**' }],
      },
    ]);
  });

  it('refuses a log that does not begin with session_start', async () => {
    const events = eventLog([narration('Mist.')]).slice(1);
    await expect(build(events)).rejects.toThrow(ScriptError);
  });

  it('keeps party speakers in session_start order', async () => {
    const { script } = await build(eventLog([], [TOMAS, KIRA]));
    expect(script.speakers.map((speaker) => speaker.id)).toEqual(['dm', 'tomas', 'kira']);
  });

  it('shows conditions and a death cue, but not a reversal back to alive', async () => {
    const events = eventLog([
      {
        type: 'state_change',
        entity: 'kira',
        field: 'conditions',
        before: [],
        after: ['prone'],
        cause: 'trip',
      },
      {
        type: 'state_change',
        entity: 'kira',
        field: 'dead',
        before: false,
        after: true,
        cause: 'defeated',
      },
      {
        type: 'state_change',
        entity: 'kira',
        field: 'dead',
        before: true,
        after: false,
        cause: 'revived',
      },
    ]);
    const { script } = await build(events);
    expect(script.lines).toEqual([
      {
        id: 'L0001',
        kind: 'state',
        sources: [{ seq: 1 }],
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
        id: 'L0002',
        kind: 'state',
        sources: [{ seq: 2 }],
        state: {
          entity: 'kira',
          name: 'Kira Vale',
          field: 'dead',
          before: false,
          after: true,
          hidden: false,
        },
      },
    ]);
  });

  it('does not choke on emoji-only text that has no letters or digits', async () => {
    const dice = await build(eventLog([narration('The door opens.\n\n🎲')]));
    expect(summary(dice.script)).toEqual([['L0001', 'narration', 'dm', 'The door opens.']]);

    const swords = await build(eventLog([narration('The door opens.\n\n⚔️')]));
    expect(summary(swords.script)).toEqual([['L0001', 'narration', 'dm', 'The door opens.']]);

    const dagger = await build(eventLog([{ type: 'action', actor: 'kira', intent: '🗡️' }]));
    expect(dagger.script.lines).toEqual([]);
  });
});
