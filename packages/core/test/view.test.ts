import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { playerView } from '../src/view';
import { kira, now, startedState, tomas } from './helpers';

const ogre = makeCombatant({
  id: 'ogre-1',
  name: 'Ogre',
  kind: 'monster',
  ac: 17,
  hp: 30,
  maxHp: 59,
  attacks: [{ name: 'Greatclub', bonus: 6, damage: '2d8+4', damageType: 'bludgeoning' }],
});

function stateWithOgre() {
  const { state } = startedState();
  const recorder = new TurnRecorder(state, 'turn', now);
  recorder.emit({ type: 'combatant_added', combatant: ogre });
  recorder.emit({ type: 'scene_change', location: 'Crystal Engine Lab', artPrompt: 'A lab' });
  recorder.emit({
    type: 'npc_introduced',
    npcId: 'npc-sella-vaunt',
    name: 'Sella Vaunt',
    description: 'Crystal engine professor',
    invented: false,
  });
  return recorder.state;
}

describe('playerView', () => {
  it('gives the player their own sheet and allies vitals', () => {
    const view = playerView(stateWithOgre(), 'kira');
    expect(view.pc).toEqual(kira);
    expect(view.allies).toEqual([
      {
        id: 'tomas',
        name: 'Tomas Reed',
        hp: 12,
        maxHp: 12,
        conditions: [],
        dead: false,
        deathSaves: { successes: 0, failures: 0 },
        stable: false,
      },
    ]);
    expect(view.scene).toBe('Crystal Engine Lab');
    expect(view.npcs).toEqual([{ npcId: 'npc-sella-vaunt', name: 'Sella Vaunt' }]);
    expect(view.inCombat).toBe(false);
    expect(view.yourTurn).toBe(false);
  });

  it('flags yourTurn when combat is running and it is this PC turn', () => {
    const state = stateWithOgre();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 20, dexMod: 2, total: 22 },
        { combatantId: 'ogre-1', roll: 10, dexMod: 0, total: 10 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    const combatState = recorder.state;

    expect(playerView(combatState, 'kira').yourTurn).toBe(true);
    expect(playerView(combatState, 'tomas').yourTurn).toBe(false);
  });

  it('shows monsters only by coarse status, with no stat block', () => {
    const view = playerView(stateWithOgre(), 'kira');
    expect(view.others).toEqual([
      { id: 'ogre-1', name: 'Ogre', kind: 'monster', status: 'wounded' },
    ]);
    const serialized = JSON.stringify(view.others);
    for (const secret of ['17', '30', '59', 'Greatclub', '2d8']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('is a copy that cannot change the game state', () => {
    const state = stateWithOgre();
    const view = playerView(state, 'kira');
    view.pc.hp = 0;
    expect(state.combatants.kira?.hp).toBe(10);
  });

  it('rejects an unknown or prototype-named PC id', () => {
    expect(() => playerView(stateWithOgre(), 'constructor')).toThrow(
      'No party member "constructor"'
    );
  });

  it("shows a dying ally's death saves to every player", () => {
    const { state } = startedState([
      kira,
      { ...tomas, hp: 0, deathSaves: { successes: 1, failures: 2 } },
    ]);
    const view = playerView(state, 'kira');
    expect(view.allies[0]).toMatchObject({
      hp: 0,
      deathSaves: { successes: 1, failures: 2 },
      stable: false,
    });
    const messages = basicPrompts.player({ view, transcript: '', instruction: 'Your turn.' });
    expect(messages.map((message) => message.content).join('\n')).toContain(
      '- Tomas Reed (id: tomas) DYING (death saves 1/2)'
    );
  });

  it('marks a stable ally at 0 HP', () => {
    const { state } = startedState([kira, { ...tomas, hp: 0, stable: true }]);
    const messages = basicPrompts.player({
      view: playerView(state, 'kira'),
      transcript: '',
      instruction: 'Your turn.',
    });
    expect(messages.map((message) => message.content).join('\n')).toContain(
      '- Tomas Reed (id: tomas) STABLE at 0 HP'
    );
  });

  it('keeps monster stats out of the basic player prompt', () => {
    const messages = basicPrompts.player({
      view: playerView(stateWithOgre(), 'kira'),
      transcript: '',
      instruction: 'Your turn.',
    });
    const prompt = messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Ogre (id: ogre-1): wounded');
    expect(prompt).not.toContain('AC 17');
    expect(prompt).not.toContain('30/59');
  });
});
