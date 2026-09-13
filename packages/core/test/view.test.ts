import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import { playerView } from '../src/view';
import { kira, now, startedState } from './helpers';

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
      { id: 'tomas', name: 'Tomas Reed', hp: 12, maxHp: 12, conditions: [], dead: false },
    ]);
    expect(view.scene).toBe('Crystal Engine Lab');
    expect(view.npcs).toEqual([{ npcId: 'npc-sella-vaunt', name: 'Sella Vaunt' }]);
    expect(view.inCombat).toBe(false);
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
