import { scriptedRng } from '@cartyx-sim/rules';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director';
import { basicPrompts } from '../src/prompts';
import { MemorySink } from '../src/sink';
import { respond, ScriptedModelClient, StaticLoreIndex, toolCall } from '../src/testing';
import { kira, now, tomas } from './helpers';

describe('a reply that needed a retry or a fallback', () => {
  it('leaves a DM-only note naming the model that answered and why the others failed', async () => {
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'test',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model: new ScriptedModelClient({
          dm: [
            {
              ...respond(
                toolCall('narrate', { text: 'The lab hums.' }),
                toolCall('hand_off', { target: { kind: 'party' } })
              ),
              model: 'backup-model',
              failedAttempts: ['small-model at http://linus: prompt truncated'],
            },
          ],
        }),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
        now,
      }
    );
    // The first step records the session start; the second is the DM's turn.
    await director.run(2);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: 'ooc_note',
        visibility: 'dm',
        text: 'Seat dm answered on backup-model after: small-model at http://linus: prompt truncated',
      })
    );
  });

  it('leaves no note for a reply that came first time', async () => {
    const sink = new MemorySink();
    const director = await Director.create(
      {
        session: 1,
        targetMinutes: 60,
        loreCommit: 'test',
        party: [kira, tomas],
        seats: { dm: 'dm', players: { kira: 'player-kira', tomas: 'player-tomas' } },
        retryDelaysMs: [],
      },
      {
        model: new ScriptedModelClient({
          dm: [
            respond(
              toolCall('narrate', { text: 'The lab hums.' }),
              toolCall('hand_off', { target: { kind: 'party' } })
            ),
          ],
        }),
        lore: new StaticLoreIndex([]),
        rng: scriptedRng([]),
        sink,
        prompts: basicPrompts,
        now,
      }
    );
    await director.run(2);
    expect(sink.events.some((e) => e.type === 'ooc_note' && e.text.includes('answered on'))).toBe(
      false
    );
  });
});
