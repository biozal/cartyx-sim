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
    seats: {
      dm: 'dm',
      checker: 'checker',
      players: { kira: 'player-kira', tomas: 'player-tomas' },
    },
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

const CLEAN: ScriptedResponse = { text: '{"violations": []}', toolCalls: [] };

/** The raw checker reply text `flagged` scripts, for asserting the logged `Checker reply: …` note. */
function flaggedText(sentence: string, pc = 'Kira Vale'): string {
  return JSON.stringify({ violations: [{ pc, sentence, why: 'the player never declared it' }] });
}

function flagged(sentence: string, pc = 'Kira Vale'): ScriptedResponse {
  return { text: flaggedText(sentence, pc), toolCalls: [] };
}

const narrate = (text: string) => toolCall('narrate', { text });
const handOffTomas = () => toolCall('hand_off', { target: { kind: 'pcs', ids: ['tomas'] } });

function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T) {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}

async function playDmBeat(director: Promise<Director>) {
  const ready = await director;
  await ready.step(); // session_start
  await ready.step(); // DM beat
}

const BAD = 'The runes pulse. Kira turns to the others. "These runes are old."';
const BAD_SENTENCE = '"These runes are old."';

describe('DM player-character control checker', () => {
  it('narrates a clean narration and asks the checker with no tools', async () => {
    const { director, model, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks open.']);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
    expect(ofType(sink.events, 'ooc_note')).toEqual([]);
    const [check] = model.requests.filter((request) => request.seat === 'checker');
    expect(check).toMatchObject({ tools: [], toolChoice: 'auto' });
    expect(check!.messages[1]!.content).toContain('DM narration to check:\nThe door creaks open.');
  });

  it('asks the DM to rewrite once, then narrates the clean rewrite', async () => {
    const { director, model, sink } = setup({
      dm: [respond(narrate(BAD)), respond(narrate('The runes pulse softly.'), handOffTomas())],
      checker: [flagged(BAD_SENTENCE), CLEAN],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The runes pulse softly.',
    ]);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([
      { seat: 'dm', rule: 'dm_controls_pc_checker', resolution: 're_prompted', retries: 1 },
    ]);
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    expect(dmRequests[1]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Rejected (dm_controls_pc_checker)'),
    });
    expect(dmRequests[1]!.messages.at(-1)!.content).toContain('These runes are old.');

    // The rejected draft and the checker's raw reply are kept DM-only, right after the flag.
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes).toEqual([
      expect.objectContaining({
        visibility: 'dm',
        text: `Rejected DM draft (dm_controls_pc_checker): ${BAD}`,
      }),
      expect.objectContaining({
        visibility: 'dm',
        text: `Checker reply: ${flaggedText(BAD_SENTENCE)}`,
      }),
    ]);
  });

  it('cuts the offending sentences on a second offense and records them', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate(BAD)), respond(narrate(`The wind rises. ${BAD}`), handOffTomas())],
      checker: [flagged(BAD_SENTENCE), flagged(BAD_SENTENCE)],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The wind rises. The runes pulse. Kira turns to the others.',
    ]);
    expect(ofType(sink.events, 'validator_flag').map((e) => e.resolution)).toEqual([
      're_prompted',
      'trimmed',
    ]);
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes.every((n) => n.visibility === 'dm')).toBe(true);
    // First offense: rejected draft, then the checker's raw reply.
    expect(notes[0]!.text).toBe(`Rejected DM draft (dm_controls_pc_checker): ${BAD}`);
    expect(notes[1]!.text).toBe(`Checker reply: ${flaggedText(BAD_SENTENCE)}`);
    // Second offense: the cut note, then the checker's raw reply again.
    expect(notes[2]!.text).toContain('Cut from DM narration (dm_controls_pc_checker)');
    expect(notes[2]!.text).toContain('These runes are old.');
    expect(notes[3]!.text).toBe(`Checker reply: ${flaggedText(BAD_SENTENCE)}`);
    expect(notes).toHaveLength(4);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
  });

  it('skips the retry for a later offense in the same beat', async () => {
    const { director, sink } = setup({
      dm: [
        respond(narrate(BAD)),
        respond(narrate('The runes pulse softly.')),
        respond(narrate('Tomas leans on a tree. The wind rises.'), handOffTomas()),
      ],
      checker: [flagged(BAD_SENTENCE), CLEAN, flagged('Tomas leans on a tree.', 'Tomas Reed')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The runes pulse softly.',
      'The wind rises.',
    ]);
    expect(ofType(sink.events, 'validator_flag').map((e) => e.resolution)).toEqual([
      're_prompted',
      'trimmed',
    ]);
  });

  it("cuts engine-made prose without a retry and still runs the DM's calls", async () => {
    const { director, model, sink } = setup({
      dm: [
        {
          text: 'The runes pulse. Kira turns to the others, eyes bright.',
          toolCalls: [
            toolCall('scene_change', { location: 'Crossroads', artPrompt: 'A misty crossroads' }),
            handOffTomas(),
          ],
        },
      ],
      checker: [flagged('Kira turns to the others, eyes bright.')],
    });
    await playDmBeat(director);

    expect(sink.events.slice(1).map((e) => e.type)).toEqual([
      'scene_change',
      'validator_flag',
      'ooc_note',
      'ooc_note',
      'narration',
      'hand_off',
      'turn_end',
    ]);
    expect(ofType(sink.events, 'narration')[0]).toMatchObject({ text: 'The runes pulse.' });
    expect(ofType(sink.events, 'validator_flag')[0]).toMatchObject({
      resolution: 'trimmed',
      retries: 0,
    });
    // No retry happens for engine-made prose, so only the cut note and the checker's raw reply
    // are logged (no "Rejected DM draft" note, which is only for the DM's own re-prompted call).
    const notes = ofType(sink.events, 'ooc_note');
    expect(notes[0]!.text).toContain('Cut from DM narration (dm_controls_pc_checker)');
    expect(notes[1]!.text).toBe(
      `Checker reply: ${flaggedText('Kira turns to the others, eyes bright.')}`
    );
    expect(model.requests.filter((request) => request.seat === 'dm')).toHaveLength(1);
  });

  it('narrates nothing when every sentence is cut, and the beat still hands off', async () => {
    const { director, sink } = setup({
      dm: [{ text: 'Kira turns to the others, eyes bright.', toolCalls: [handOffTomas()] }],
      checker: [flagged('Kira turns to the others, eyes bright.')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toEqual([]);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([{ resolution: 'trimmed' }]);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
  });

  it('ignores a flagged sentence that is not in the narration', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [flagged('Kira sings a song.')],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks open.']);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
    expect(ofType(sink.events, 'ooc_note')).toEqual([]);
  });

  it('narrates unchecked with a note when the checker fails or its reply is unreadable', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), narrate('The wind rises.'), handOffTomas())],
      checker: [{ throw: 'connection refused' }, { text: 'Looks fine to me!', toolCalls: [] }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(2);
    expect(ofType(sink.events, 'ooc_note').map((e) => e.text)).toEqual([
      // A thrown error has no reply text, so only the "unavailable" note is logged.
      'Checker unavailable (connection refused); narration not checked.',
      // An unreadable-but-present reply also logs the checker's raw text, right after.
      'Checker reply unreadable; narration not checked.',
      'Checker reply: Looks fine to me!',
    ]);
    expect(ofType(sink.events, 'ooc_note').every((n) => n.visibility === 'dm')).toBe(true);
    expect(ofType(sink.events, 'session_paused')).toEqual([]);
  });

  it('stops checking for the rest of the run after repeated failures', async () => {
    const { director, model, sink } = setup({
      dm: [
        respond(
          narrate('One bell tolls.'),
          narrate('Two bells toll.'),
          narrate('Three bells toll.'),
          narrate('Four bells toll.'),
          handOffTomas()
        ),
      ],
      checker: [{ throw: 'down' }, { throw: 'down' }, { throw: 'down' }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(4);
    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(3);
    expect(ofType(sink.events, 'ooc_note').at(-1)!.text).toBe(
      'Checker failed 3 times in a row; narration is not checked for the rest of this run.'
    );
  });

  it('falls back to the verb-list rule once the checker disables itself', async () => {
    const { director, model, sink } = setup(
      {
        dm: [
          respond(
            narrate('The wind rises.'),
            narrate('Kira decides to open the door.'),
            handOffTomas()
          ),
          respond(handOffTomas()),
        ],
        checker: [{ throw: 'down' }],
      },
      { maxCheckerFailures: 1 }
    );
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The wind rises.']);
    expect(
      ofType(sink.events, 'validator_flag').filter((e) => e.rule === 'dm_controls_pc')
    ).toMatchObject([{ resolution: 're_prompted', retries: 1 }]);
    expect(
      ofType(sink.events, 'ooc_note').some((note) =>
        note.text.includes('Checker failed 1 times in a row')
      )
    ).toBe(true);
    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(1);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);
  });

  it('resets the failure count after a successful check', async () => {
    const { director, model, sink } = setup({
      dm: [
        respond(
          narrate('One bell tolls.'),
          narrate('Two bells toll.'),
          narrate('Three bells toll.'),
          narrate('Four bells toll.'),
          narrate('Five bells toll.'),
          handOffTomas()
        ),
      ],
      checker: [{ throw: 'down' }, { throw: 'down' }, CLEAN, { throw: 'down' }, { throw: 'down' }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(5);
    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(5);
    expect(
      ofType(sink.events, 'ooc_note').some((note) => note.text.includes('Checker failed 3 times'))
    ).toBe(false);
  });

  it('does not narrate a trimmed narration twice in the same beat', async () => {
    const { director, model, sink } = setup({
      dm: [
        respond(narrate(BAD)),
        respond(narrate(`The wind rises. ${BAD}`)),
        respond(narrate(`The wind rises. ${BAD}`), handOffTomas()),
      ],
      checker: [flagged(BAD_SENTENCE), flagged(BAD_SENTENCE), flagged(BAD_SENTENCE)],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'The wind rises. The runes pulse. Kira turns to the others.',
    ]);
    expect(
      ofType(sink.events, 'validator_flag')
        .filter((e) => e.rule === 'dm_controls_pc_checker')
        .map((e) => e.resolution)
    ).toEqual(['re_prompted', 'trimmed']);
    expect(
      ofType(sink.events, 'validator_flag').filter((e) => e.rule === 'duplicate_narration')
    ).toHaveLength(1);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);

    // The trim from step 2 tells the DM what it removed, visible in the next request's history.
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    expect(dmRequests[2]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Removed sentences that played player characters'),
    });
    // Only the retry and the cut log the checker's reply; the third (duplicate) check does not.
    expect(
      ofType(sink.events, 'ooc_note').filter((n) => n.text.startsWith('Checker reply:'))
    ).toHaveLength(2);
  });

  it('skips a repeated fully cut narration without calling the checker again', async () => {
    const FULL = 'Kira turns to the others, eyes bright.';
    const { director, model, sink } = setup({
      dm: [
        respond(narrate(FULL)),
        respond(narrate(FULL)),
        respond(narrate(FULL)),
        respond(handOffTomas()),
      ],
      checker: [flagged(FULL), flagged(FULL)],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toEqual([]);
    expect(
      ofType(sink.events, 'validator_flag')
        .filter((e) => e.rule === 'dm_controls_pc_checker')
        .map((e) => e.resolution)
    ).toEqual(['re_prompted', 'trimmed']);
    expect(
      ofType(sink.events, 'ooc_note').filter((n) => n.text.includes('Cut from DM narration'))
    ).toHaveLength(1);
    expect(
      ofType(sink.events, 'validator_flag').filter((e) => e.rule === 'duplicate_narration')
    ).toHaveLength(1);
    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(2);
    expect(ofType(sink.events, 'hand_off')).toHaveLength(1);

    // The resent, already-cut narration gets its own message, not the "already narrated" one:
    // nothing was actually narrated the first time, only cut.
    const dmRequests = model.requests.filter((request) => request.seat === 'dm');
    expect(dmRequests[3]!.messages.at(-1)).toMatchObject({
      role: 'tool',
      content:
        'Not narrated: every sentence of that narration was already cut this turn because it played player characters. Continue with other tools, or call hand_off.',
    });
  });

  it('logs the reply as unreadable when its shape does not parse', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [{ text: 42, toolCalls: [] } as unknown as ScriptedResponse],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'ooc_note').map((e) => e.text)).toEqual([
      'Checker reply unreadable; narration not checked.',
    ]);
    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks open.']);
    expect(ofType(sink.events, 'session_paused')).toEqual([]);
  });

  it('does not call the checker when the mechanics rule already rejected the narration', async () => {
    const { director, model } = setup({
      dm: [
        respond(narrate('Kira takes 5 damage.')),
        respond(narrate('The door creaks.'), handOffTomas()),
      ],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    const checks = model.requests.filter((request) => request.seat === 'checker');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.messages[1]!.content).toMatch(/DM narration to check:\nThe door creaks\.$/);
  });

  it('reaches the checker with a checker seat configured, for a narration the verb list would have rejected', async () => {
    const { director, model, sink } = setup({
      dm: [respond(narrate('Kira decides to open the door.'), handOffTomas())],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    const checks = model.requests.filter((request) => request.seat === 'checker');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.messages[1]!.content).toMatch(
      /DM narration to check:\nKira decides to open the door\.$/
    );
    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual([
      'Kira decides to open the door.',
    ]);
    expect(ofType(sink.events, 'validator_flag')).toEqual([]);
  });

  it('checks a narration the mechanics rule accepted with a flag once retries are used up', async () => {
    const { director, model, sink } = setup(
      {
        dm: [respond(narrate('Kira takes 5 damage.'), handOffTomas())],
        checker: [CLEAN],
      },
      { maxValidatorRetries: 0 }
    );
    await playDmBeat(director);

    const checks = model.requests.filter((request) => request.seat === 'checker');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.messages[1]!.content).toMatch(
      /DM narration to check:\nKira takes 5 damage\.$/
    );
    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['Kira takes 5 damage.']);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([
      { seat: 'dm', rule: 'mechanics_without_tool', resolution: 'accepted_with_flag' },
    ]);
  });

  it('asks for a rewrite when the checker flags a narration the verb list no longer rejects', async () => {
    const { director, model, sink } = setup(
      {
        dm: [
          respond(narrate('Kira decides to open the door.')),
          respond(narrate('The door creaks.'), handOffTomas()),
        ],
        checker: [flagged('Kira decides to open the door.'), CLEAN],
      },
      { maxValidatorRetries: 0 }
    );
    await playDmBeat(director);

    expect(model.requests.filter((request) => request.seat === 'checker')).toHaveLength(2);
    expect(ofType(sink.events, 'narration').map((e) => e.text)).toEqual(['The door creaks.']);
    expect(ofType(sink.events, 'validator_flag')).toMatchObject([
      { seat: 'dm', rule: 'dm_controls_pc_checker', resolution: 're_prompted', retries: 1 },
    ]);
  });

  it('sends the checker what players declared since the DM last spoke', async () => {
    const { director, model } = setup({
      dm: [
        respond(
          narrate('The hall is quiet.'),
          toolCall('hand_off', { target: { kind: 'pcs', ids: ['kira'] } })
        ),
        respond(narrate("The runes glow under Kira's palm."), handOffTomas()),
      ],
      'player-kira': [respond(toolCall('act', { intent: 'press my palm to the runes' }))],
      checker: [CLEAN, CLEAN],
    });
    await (await director).run(4);

    const checks = model.requests.filter((request) => request.seat === 'checker');
    expect(checks[0]!.messages[1]!.content).toContain('since the DM last spoke:\n- nothing');
    expect(checks[1]!.messages[1]!.content).toContain(
      '- Kira Vale attempts: press my palm to the runes'
    );
  });

  it('asks the checker with incompleteReplyAttempts set, to retry an empty or cut-off reply', async () => {
    const { director, model } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [CLEAN],
    });
    await playDmBeat(director);

    const [check] = model.requests.filter((request) => request.seat === 'checker');
    expect(check).toMatchObject({ incompleteReplyAttempts: 2 });
  });

  it('logs no Checker reply note for a blank checker reply', async () => {
    const { director, sink } = setup({
      dm: [respond(narrate('The door creaks open.'), handOffTomas())],
      checker: [{ text: '', toolCalls: [] }],
    });
    await playDmBeat(director);

    expect(ofType(sink.events, 'ooc_note').map((e) => e.text)).toEqual([
      'Checker reply unreadable; narration not checked.',
    ]);
  });

  it('never calls a checker when no checker seat is configured', async () => {
    const { director, model, sink } = setup(
      { dm: [respond(narrate('The door creaks open.'), handOffTomas())] },
      { seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } } }
    );
    await playDmBeat(director);

    expect(ofType(sink.events, 'narration')).toHaveLength(1);
    expect(model.requests.every((request) => request.seat === 'dm')).toBe(true);
  });
});
