import { describe, expect, it } from 'vitest';
import { basicPrompts } from '../src/prompts';
import { startedState } from './helpers';

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
});
