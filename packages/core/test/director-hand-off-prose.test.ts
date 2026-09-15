import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director, type DirectorConfig } from '../src/director';
import type { SimEvent } from '../src/events';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import {
  respond,
  ScriptedModelClient,
  StaticLoreIndex,
  toolCall,
  type ScriptedResponse,
} from '../src/testing';
import { kira, now, tomas } from './helpers';

function config(overrides: Partial<DirectorConfig> = {}): DirectorConfig {
  return {
    session: 1,
    targetMinutes: 60,
    loreCommit: 'abc123',
    party: [kira, tomas],
    seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
    retryDelaysMs: [],
    ...overrides,
  };
}

function setup(
  script: Record<string, ScriptedResponse[]>,
  overrides: Partial<DirectorConfig> = {}
) {
  let turn = 0;
  const model = new ScriptedModelClient(script);
  const sink = new MemorySink();
  const director = Director.create(config(overrides), {
    model,
    lore: new StaticLoreIndex([]),
    rng: scriptedRng([]),
    sink,
    prompts: basicPrompts,
    now,
    newTurnId: () => `turn-${++turn}`,
    sleep: async () => {},
  });
  return { director, model, sink };
}

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T) {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}

async function playDmBeat(director: Promise<Director>) {
  const ready = await director;
  await ready.step(); // session_start
  await ready.step(); // DM beat
}

const narrate = (text: string) => toolCall('narrate', { text });

describe('a "Hand off to …" line written in DM narration', () => {
  it('is removed and treated as a hand_off call when the DM made no hand_off call itself', async () => {
    const { director, model, sink } = setup({
      dm: [{ text: 'The mist thickens.\n\nHand off to the party.', toolCalls: [] }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The mist thickens.']);
    expect(ofType(sink.events, 'hand_off')).toMatchObject([{ target: { kind: 'party' } }]);
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes.map((n) => n.text)).toEqual([
      'Hand-off written in DM narration (Hand off to the party.); removed from the narration and treated as a hand_off call.',
    ]);
    expect(model.requests.filter((request) => request.seat === 'dm')).toHaveLength(1);
  });

  it('is removed but not duplicated when the DM also called hand_off itself', async () => {
    const { director, sink } = setup({
      dm: [
        respond(
          narrate('The door opens.\n\nHand off to Tomas.'),
          toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } })
        ),
      ],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door opens.']);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes.map((n) => n.text)).toEqual([
      'Hand-off written in DM narration (Hand off to Tomas.); removed from the narration.',
    ]);
  });

  it('drops the narration entirely and hands off when the line is all there was', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('Hand off to Kira.'))],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toEqual([]);
    expect(ofType(sink.events, 'hand_off')).toMatchObject([
      { target: { kind: 'pcs', ids: ['kira'] } },
    ]);
  });

  it('logs the implied call as not executed, without a "treated as" note, when it is skipped', async () => {
    const { director, sink } = setup({
      dm: [
        respond(narrate('Kira decides to open the door.\n\nHand off to the party.')),
        respond(narrate('The door creaks.'), toolCall('hand_off', { target: { kind: 'party' } })),
      ],
    });
    await playDmBeat(director);

    const notes = ofType(sink.events, 'ooc_note').map((n) => n.text);
    expect(notes).toContainEqual(
      'Hand-off written in DM narration (Hand off to the party.); removed from the narration. The hand_off call it implied was not executed: an earlier call was rejected.'
    );
    expect(notes.some((text) => text.includes('treated as a hand_off call'))).toBe(false);
    expect(ofType(sink.events, 'hand_off')).toMatchObject([{ target: { kind: 'party' } }]);
  });

  it('is removed and treated as a hand_off call for a bare "**Hand off.**" line', async () => {
    const { director, sink } = setup({
      dm: [{ text: 'The creature steps forward.\n\n**Hand off.**', toolCalls: [] }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The creature steps forward.',
    ]);
    expect(ofType(sink.events, 'hand_off')).toMatchObject([{ target: { kind: 'party' } }]);
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes.map((n) => n.text)).toEqual([
      'Hand-off written in DM narration (**Hand off.**); removed from the narration and treated as a hand_off call.',
    ]);
  });

  it('runs the synthesized call exempt from the tool-call cap and logs it as treated', async () => {
    const { director, sink } = setup(
      {
        dm: [respond(narrate('First line.'), narrate('Second line.\n\nHand off to the party.'))],
      },
      { maxDmToolCallsPerBeat: 2 }
    );
    await playDmBeat(director);

    expect(ofType(sink.events, 'hand_off')).toMatchObject([{ target: { kind: 'party' } }]);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
    const notes = ofType(sink.events, 'ooc_note').map((n) => n.text);
    expect(notes).toEqual([
      'Hand-off written in DM narration (Hand off to the party.); removed from the narration and treated as a hand_off call.',
    ]);
  });
});
