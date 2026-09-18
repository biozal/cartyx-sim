import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { TurnRecorder } from '../src/recorder';
import type { NpcRecord } from '../src/state';
import { playerView } from '../src/view';
import { kira, now, startedState, tomas } from './helpers';

describe('basicPrompts.pcControlCheck', () => {
  it('sends the rule, the party, what players declared, and the narration', () => {
    const [system, user] = basicPrompts.pcControlCheck({
      party: ['Kira Vale', 'Tomas Reed'],
      declarations: ['Kira Vale attempts: study the runes'],
      narration: 'Kira turns to the others.',
    });
    expect(system).toMatchObject({ role: 'system' });
    expect(system!.content).toContain('the DM must not play the player characters');
    expect(system!.content).toContain('{"violations": []}');
    expect(user).toMatchObject({ role: 'user' });
    expect(user!.content).toContain('Player characters: Kira Vale, Tomas Reed');
    expect(user!.content).toContain('- Kira Vale attempts: study the runes');
    expect(user!.content).toContain('DM narration to check:\nKira turns to the others.');
  });

  it('says so when no player has declared anything', () => {
    const [, user] = basicPrompts.pcControlCheck({
      party: ['Kira Vale'],
      declarations: [],
      narration: 'The door creaks.',
    });
    expect(user!.content).toContain('since the DM last spoke:\n- nothing');
  });
});

describe('basicPrompts.dm', () => {
  it("tells the DM never to write a player character's dialogue", () => {
    const [system] = basicPrompts.dm({
      state: startedState().state,
      transcript: '',
      instruction: 'Begin.',
    });
    expect(system!.content).toContain(
      "Never write a player character's dialogue, thoughts, feelings, or choices."
    );
  });

  it("includes an NPC's description, collapsed to one line and truncated at 200 characters", () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    const longDescription = `Runs the ${'crystal engine lab '.repeat(15)}with quiet precision.`;
    recorder.emit({
      type: 'npc_introduced',
      npcId: 'npc-sella-vaunt',
      name: 'Sella Vaunt',
      description: `Crystal engine\nprofessor.  ${longDescription}`,
      invented: false,
    });
    const [, user] = basicPrompts.dm({
      state: recorder.state,
      transcript: '',
      instruction: 'Begin.',
    });
    const collapsed = `Crystal engine professor.  ${longDescription}`.replace(/\s+/g, ' ').trim();
    const truncated = `${collapsed.slice(0, 200)}…`;
    expect(user!.content).toContain(`- Sella Vaunt (npcId: npc-sella-vaunt): ${truncated}`);
    expect(user!.content).not.toContain('\nprofessor');
  });

  it('marks a dying, a stable, and a dead player character in the party block', () => {
    const { state } = startedState([
      { ...kira, hp: 0, deathSaves: { successes: 2, failures: 1 } },
      { ...tomas, hp: 0, stable: true },
    ]);
    const [, user] = basicPrompts.dm({ state, transcript: '', instruction: 'Begin.' });
    expect(user!.content).toContain('- Kira Vale (id: kira) DYING (death saves 2/1), AC 15');
    expect(user!.content).toContain('- Tomas Reed (id: tomas) STABLE at 0 HP, AC 16');

    const dead = startedState([{ ...kira, hp: 0, dead: true }, tomas]).state;
    const [, deadUser] = basicPrompts.dm({ state: dead, transcript: '', instruction: 'Begin.' });
    expect(deadUser!.content).toContain('- Kira Vale (id: kira) DEAD, AC 15');
  });

  it("keeps today's line for an NPC with no description", () => {
    const { state } = startedState();
    const plain: NpcRecord = { npcId: 'plain', name: 'Plain Guard', invented: false };
    const [, user] = basicPrompts.dm({
      state: { ...state, npcs: { ...state.npcs, plain } },
      transcript: '',
      instruction: 'Begin.',
    });
    expect(user!.content).toContain('- Plain Guard (npcId: plain)');
    expect(user!.content).not.toContain('Plain Guard (npcId: plain):');
  });
});

describe('basicPrompts.player', () => {
  it('tells the player to use fresh wording', () => {
    const { state } = startedState();
    const [system] = basicPrompts.player({
      view: playerView(state, 'kira'),
      transcript: '',
      instruction: 'The DM has turned to you.',
    });
    expect(system!.content).toContain(
      'Use fresh wording: do not reuse phrases or lines you have already said this session.'
    );
  });
});

describe('basicPrompts.player in combat', () => {
  const ogre = makeCombatant({
    id: 'ogre-1',
    name: 'Ogre',
    kind: 'monster',
    ac: 17,
    hp: 30,
    maxHp: 59,
    attacks: [{ name: 'Greatclub', bonus: 6, damage: '2d8+4', damageType: 'bludgeoning' }],
  });

  it("adds the one-line rule on this PC's combat turn", () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'combatant_added', combatant: ogre });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'kira', roll: 20, dexMod: 2, total: 22 },
        { combatantId: 'ogre-1', roll: 10, dexMod: 0, total: 10 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    const [system] = basicPrompts.player({
      view: playerView(recorder.state, 'kira'),
      transcript: '',
      instruction: 'It is your turn in combat.',
    });
    expect(system!.content).toContain(
      'Say one short line in character as you act, unless silence fits the moment better.'
    );
  });

  it('omits the rule out of combat', () => {
    const { state } = startedState();
    const [system] = basicPrompts.player({
      view: playerView(state, 'kira'),
      transcript: '',
      instruction: 'The DM has turned to you.',
    });
    expect(system!.content).not.toContain('Say one short line in character');
  });

  it("omits the rule in combat when it is not this PC's turn", () => {
    const { state } = startedState();
    const recorder = new TurnRecorder(state, 'turn', now);
    recorder.emit({ type: 'combatant_added', combatant: ogre });
    recorder.emit({
      type: 'combat_start',
      order: [
        { combatantId: 'ogre-1', roll: 20, dexMod: 0, total: 20 },
        { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
        { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
      ],
    });
    const [system] = basicPrompts.player({
      view: playerView(recorder.state, 'kira'),
      transcript: '',
      instruction: 'Wait for your turn.',
    });
    expect(system!.content).not.toContain('Say one short line in character');
  });
});
