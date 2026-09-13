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
    expect(describeEvent(history[0]!, state)).toBeNull();
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
    expect(describeEvent(event, state)).toBe('constructor holds back.');
  });
});
