import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { SimEvent } from '../src/events';
import { TurnRecorder } from '../src/recorder';
import { describeEvent, renderTranscript } from '../src/transcript';
import { now, startedState } from './helpers';

function sampleSession() {
  const { state, history } = startedState();
  const recorder = new TurnRecorder(state, 'turn', now);
  recorder.emit({
    type: 'npc_introduced',
    npcId: 'sella',
    name: 'Sella Vaunt',
    description: 'Crystal engine professor',
    invented: false,
  });
  recorder.emit({
    type: 'lore_lookup',
    visibility: 'dm',
    query: 'Sella Vaunt',
    hits: [],
    used: [],
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'sella',
    speakerKind: 'npc',
    text: 'Find out who.',
    emotion: 'angry',
  });
  recorder.emit({
    type: 'dialogue',
    speaker: 'kira',
    speakerKind: 'pc',
    text: 'On it!',
    emotion: 'excited',
    overlaps: 3,
  });
  recorder.emit({
    type: 'roll',
    actor: 'kira',
    kind: 'check',
    label: 'Kira Vale Investigation check (tool marks)',
    expr: '1d20+5',
    rolls: [15],
    modifier: 5,
    total: 20,
    target: 13,
    outcome: 'success',
  });
  recorder.emit({
    type: 'state_change',
    entity: 'tomas',
    field: 'hp',
    before: 12,
    after: 6,
    cause: 'test',
  });
  return { events: [...history, ...recorder.events], state: recorder.state };
}

describe('renderTranscript', () => {
  it('shows the DM everything', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'dm', 50)).toBe(
      [
        '[npc] Sella Vaunt (npcId: sella): Crystal engine professor',
        '[lore] "Sella Vaunt": 0 relevant result(s)',
        'Sella Vaunt: "Find out who."',
        'Kira Vale (interrupting): "On it!"',
        '[roll] Kira Vale Investigation check (tool marks): 20 vs 13 — success',
        '[state] Tomas Reed HP 12 → 6',
      ].join('\n')
    );
  });

  it('hides DM-only events from players', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'player', 50)).not.toContain('[lore]');
  });

  it('keeps only the last lines', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'player', 1)).toBe('[state] Tomas Reed HP 12 → 6');
  });
});

describe('describeEvent', () => {
  it('skips bookkeeping events', () => {
    const { history, state } = startedState();
    expect(describeEvent(history[0]!, state, 'dm')).toBeNull();
  });

  it('falls back to the raw id for a built-in property name instead of a prototype value', () => {
    const { state } = startedState();
    const event = SimEvent.parse({
      seq: 1,
      ts: '2026-09-13T00:00:00.000Z',
      turnId: 'turn',
      visibility: 'public',
      type: 'pass',
      actor: 'constructor',
    });
    expect(describeEvent(event, state, 'dm')).toBe('constructor holds back.');
  });

  it('defaults to the DM audience when none is given', () => {
    const { state } = startedState();
    const event = SimEvent.parse({
      seq: 1,
      ts: '2026-09-13T00:00:00.000Z',
      turnId: 'turn',
      visibility: 'public',
      type: 'pass',
      actor: 'constructor',
    });
    expect(describeEvent(event, state)).toBe('constructor holds back.');
  });
});

describe('G3.2: monster AC and HP are redacted for players', () => {
  function attackSession() {
    const { state, history } = startedState();
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      ac: 13,
      hp: 4,
      maxHp: 7,
    });
    const stateWithGoblin = {
      ...state,
      combatants: { ...state.combatants, [goblin.id]: goblin },
    };
    const recorder = new TurnRecorder(stateWithGoblin, 'turn', now);
    recorder.emit({
      type: 'roll',
      actor: 'kira',
      kind: 'attack',
      label: 'Kira Vale Light Hammer → Goblin',
      expr: '1d20+5',
      rolls: [15],
      modifier: 5,
      total: 20,
      target: 13,
      outcome: 'critical',
    });
    recorder.emit({
      type: 'state_change',
      entity: 'goblin-1',
      field: 'hp',
      before: 7,
      after: 4,
      cause: 'test',
    });
    return { events: [...history, ...recorder.events], state: recorder.state };
  }

  it('omits the AC comparison from an attack roll for players but keeps it for the DM', () => {
    const { events, state } = attackSession();
    const dmLine = renderTranscript(events, state, 'dm', 50);
    const playerLine = renderTranscript(events, state, 'player', 50);
    expect(dmLine).toContain('20 vs 13 — critical');
    expect(playerLine).toContain('20 — critical');
    expect(playerLine).not.toContain('13');
  });

  it('renders a wounded monster instead of its HP numbers for players', () => {
    const { events, state } = attackSession();
    const dmLine = renderTranscript(events, state, 'dm', 50);
    const playerLine = renderTranscript(events, state, 'player', 50);
    expect(dmLine).toContain('[state] Goblin HP 7 → 4');
    expect(playerLine).toContain('[state] Goblin is wounded');
    expect(playerLine).not.toMatch(/\b7\b|\b4\b/);
  });

  it('renders a downed monster at 0 HP for players', () => {
    const { state, history } = startedState();
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 4,
      maxHp: 7,
    });
    const recorder = new TurnRecorder(
      { ...state, combatants: { ...state.combatants, [goblin.id]: goblin } },
      'turn',
      now
    );
    recorder.emit({
      type: 'state_change',
      entity: 'goblin-1',
      field: 'hp',
      before: 4,
      after: 0,
      cause: 'test',
    });
    const events = [...history, ...recorder.events];
    expect(renderTranscript(events, recorder.state, 'player', 50)).toContain(
      '[state] Goblin is down'
    );
  });

  it('renders a recovering monster for players when its HP increases', () => {
    const { state, history } = startedState();
    const goblin = makeCombatant({
      id: 'goblin-1',
      name: 'Goblin',
      kind: 'monster',
      hp: 2,
      maxHp: 7,
    });
    const recorder = new TurnRecorder(
      { ...state, combatants: { ...state.combatants, [goblin.id]: goblin } },
      'turn',
      now
    );
    recorder.emit({
      type: 'state_change',
      entity: 'goblin-1',
      field: 'hp',
      before: 2,
      after: 5,
      cause: 'test',
    });
    const events = [...history, ...recorder.events];
    expect(renderTranscript(events, recorder.state, 'player', 50)).toContain(
      '[state] Goblin recovers'
    );
  });

  it('still shows PC HP numbers to players', () => {
    const { events, state } = sampleSession();
    expect(renderTranscript(events, state, 'player', 50)).toContain('[state] Tomas Reed HP 12 → 6');
  });
});
