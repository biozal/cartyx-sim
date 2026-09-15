import { makeCombatant } from '@cartyx-sim/rules/testing';
import { describe, expect, it } from 'vitest';
import {
  cutSentences,
  declarationsSinceDm,
  describeFindings,
  parseCheckerReply,
  verifyFindings,
  type PcControlFinding,
} from '../src/pc-control';
import { TurnRecorder } from '../src/recorder';
import { kira, now, startedState, tomas } from './helpers';

function historyWith(emit: (recorder: TurnRecorder) => void) {
  const started = startedState([kira, tomas]);
  const recorder = new TurnRecorder(started.state, 'turn-2', now);
  emit(recorder);
  return { history: [...started.history, ...recorder.events], state: recorder.state };
}

function finding(sentence: string, pc = 'Kira Vale'): PcControlFinding {
  return { pc, sentence, why: 'dialogue the player never said' };
}

describe('declarationsSinceDm', () => {
  it("lists what players said, declared, or passed on since the DM's last turn ended", () => {
    const { history, state } = historyWith((recorder) => {
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: 'Before the DM spoke.',
        emotion: 'neutral',
      });
      recorder.emit({
        type: 'narration',
        speaker: 'dm',
        text: 'The door opens.',
        emotion: 'neutral',
      });
      recorder.emit({ type: 'turn_end', actor: 'dm' });
      recorder.emit({
        type: 'dialogue',
        speaker: 'kira',
        speakerKind: 'pc',
        text: 'Who is there?',
        emotion: 'afraid',
      });
      recorder.emit({ type: 'action', actor: 'kira', intent: 'raise my hammer' });
      recorder.emit({ type: 'pass', actor: 'tomas' });
      recorder.emit({
        type: 'dialogue',
        speaker: 'npc-guard',
        speakerKind: 'npc',
        text: 'Halt!',
        emotion: 'angry',
      });
    });

    expect(declarationsSinceDm(history, state)).toEqual([
      'Kira Vale says: "Who is there?"',
      'Kira Vale attempts: raise my hammer',
      'Tomas Reed holds back.',
    ]);
  });

  it('lists everything since the session started when the DM has not had a turn yet', () => {
    const { history, state } = historyWith((recorder) => {
      recorder.emit({ type: 'action', actor: 'kira', intent: 'study the runes' });
    });
    expect(declarationsSinceDm(history, state)).toEqual(['Kira Vale attempts: study the runes']);
  });

  it('includes the combat declaration the DM is resolving', () => {
    const goblin = makeCombatant({ id: 'goblin-1', name: 'Goblin', kind: 'monster' });
    const { history, state } = historyWith((recorder) => {
      recorder.emit({ type: 'combatant_added', combatant: goblin });
      recorder.emit({
        type: 'combat_start',
        order: [
          { combatantId: 'goblin-1', roll: 20, dexMod: 0, total: 20 },
          { combatantId: 'kira', roll: 10, dexMod: 2, total: 12 },
          { combatantId: 'tomas', roll: 5, dexMod: 1, total: 6 },
        ],
      });
      recorder.emit({
        type: 'narration',
        speaker: 'dm',
        text: 'The goblin lunges.',
        emotion: 'neutral',
      });
      recorder.emit({ type: 'turn_end', actor: 'dm' });
      recorder.emit({ type: 'combat_turn', round: 1, turnIndex: 1, combatantId: 'kira' });
      recorder.emit({ type: 'action', actor: 'kira', intent: 'swing my hammer at the goblin' });
      recorder.emit({ type: 'turn_end', actor: 'kira' });
    });

    expect(state.combat).not.toBeNull();
    expect(declarationsSinceDm(history, state)).toEqual([
      'Kira Vale attempts: swing my hammer at the goblin',
    ]);
  });
});

describe('parseCheckerReply', () => {
  const reply =
    '{"violations": [{"pc": "Kira Vale", "sentence": "Kira nods.", "why": "undeclared"}]}';

  it('reads plain JSON', () => {
    expect(parseCheckerReply(reply)).toEqual([
      { pc: 'Kira Vale', sentence: 'Kira nods.', why: 'undeclared' },
    ]);
  });

  it('reads JSON inside a code fence or surrounded by text', () => {
    expect(parseCheckerReply('```json\n' + reply + '\n```')).toHaveLength(1);
    expect(parseCheckerReply(`Here is my answer: ${reply} Done.`)).toHaveLength(1);
  });

  it('reads an empty violations list and defaults a missing reason', () => {
    expect(parseCheckerReply('{"violations": []}')).toEqual([]);
    expect(
      parseCheckerReply('{"violations": [{"pc": "Kira Vale", "sentence": "Kira nods."}]}')
    ).toEqual([{ pc: 'Kira Vale', sentence: 'Kira nods.', why: '' }]);
  });

  it('reads a reply after a leaked thinking block that holds braces', () => {
    expect(
      parseCheckerReply(
        '<THINK>\nThe format is {"violations": [...]}, so {maybe}.\n</think>\n{"violations": []}'
      )
    ).toEqual([]);
  });

  it('reads a reply followed by text with a brace in it', () => {
    expect(parseCheckerReply(`${reply}\nI followed the format, which was {violations}.`)).toEqual([
      { pc: 'Kira Vale', sentence: 'Kira nods.', why: 'undeclared' },
    ]);
  });

  it('reads the first valid object when the reply holds two', () => {
    expect(parseCheckerReply(`{"note": "checking"}\n${reply}\n{"violations": []}`)).toEqual([
      { pc: 'Kira Vale', sentence: 'Kira nods.', why: 'undeclared' },
    ]);
  });

  it('returns null for the wrong shape, cut-off JSON, or no JSON', () => {
    expect(parseCheckerReply('{"violations": "none"}')).toBeNull();
    expect(parseCheckerReply('{"violations": [{"pc": "Kira Vale", "sentence": "Kira')).toBeNull();
    expect(parseCheckerReply('No violations found.')).toBeNull();
  });
});

describe('verifyFindings', () => {
  const narration = 'Kira turns to the others.  "I can’t quite grasp it," she admits.';

  it('keeps findings that appear in the narration despite spacing and quote style', () => {
    const kept = verifyFindings(narration, [
      finding('Kira turns to the others.'),
      finding('"I can\'t quite grasp it," she admits.'),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('drops findings that are not in the narration', () => {
    expect(verifyFindings(narration, [finding('I grip the stone a little harder.')])).toEqual([]);
  });

  it('matches across ellipsis and dash styles', () => {
    const styled = 'Kira hesitates\u2026 then speaks \u2014 softly \u2013 to the others.';
    expect(
      verifyFindings(styled, [finding('Kira hesitates... then speaks - softly - to the others.')])
    ).toHaveLength(1);
    expect(
      verifyFindings('Kira hesitates... then speaks - softly.', [
        finding('Kira hesitates\u2026 then speaks \u2014 softly.'),
      ])
    ).toHaveLength(1);
  });

  it('keeps a short finding that is a whole sentence', () => {
    expect(verifyFindings('The door opens. Kira nods.', [finding('Kira nods.')])).toHaveLength(1);
  });

  it('drops a name or short fragment that is not a whole sentence', () => {
    const runes =
      "Kira presses her palm to the stone. The runes flare under Kira's hand. The hall is silent.";
    expect(verifyFindings(runes, [finding('Kira')])).toEqual([]);
    const elder = 'The elder speaks. She nods slowly toward the door. The fire crackles.';
    expect(verifyFindings(elder, [finding('she nods')])).toEqual([]);
  });

  it('does not match inside a longer word', () => {
    expect(verifyFindings('The door opens. Kira nods.', [finding('nod')])).toEqual([]);
  });
});

describe('cutSentences', () => {
  it('removes every sentence of a flagged multi-sentence quote and keeps the rest', () => {
    const narration =
      'The runes pulse. Kira turns to the others. "These runes are old. They seem to be a ward."';
    const cut = cutSentences(narration, [
      finding('"These runes are old. They seem to be a ward."'),
    ]);
    expect(cut).toBe('The runes pulse. Kira turns to the others.');
  });

  it('removes the whole sentence around a flagged clause and keeps paragraph breaks', () => {
    const narration =
      'The fog lifts.\n\nTomas leans against a tree, watching the road. The wind rises.';
    const cut = cutSentences(narration, [finding('Tomas leans against a tree', 'Tomas Reed')]);
    expect(cut).toBe('The fog lifts.\n\nThe wind rises.');
  });

  it('returns an empty string when every sentence is cut', () => {
    expect(cutSentences('Kira nods.', [finding('Kira nods.')])).toBe('');
  });

  it('handles curly-quoted multi-sentence dialogue', () => {
    const narration =
      'The runes pulse. Kira turns to the others. “These runes are old. They seem to be a ward.” Tomas nods.';
    const cut = cutSentences(narration, [
      finding('“These runes are old. They seem to be a ward.”'),
    ]);
    expect(cut).toBe('The runes pulse. Kira turns to the others. Tomas nods.');
  });

  it('cuts nothing for a name or short fragment', () => {
    const runes =
      "Kira presses her palm to the stone. The runes flare under Kira's hand. The hall is silent.";
    expect(cutSentences(runes, [finding('Kira')])).toBe(runes);
    const elder = 'The elder speaks. She nods slowly toward the door. The fire crackles.';
    expect(cutSentences(elder, [finding('she nods')])).toBe(elder);
    expect(cutSentences('The door opens. Kira nods.', [finding('nod')])).toBe(
      'The door opens. Kira nods.'
    );
  });

  it("cuts only the PC's line when an NPC says the same words", () => {
    expect(
      cutSentences('"Run!" the guard shouts. Kira says "Run!"', [finding('Kira says "Run!"')])
    ).toBe('"Run!" the guard shouts.');
  });

  it('keeps an NPC quote that repeats inside a flagged sentence', () => {
    expect(
      cutSentences('The old man grins. "Yes." Kira smiles and says, "Yes."', [
        finding('Kira smiles and says, "Yes."'),
      ])
    ).toBe('The old man grins. "Yes."');
  });
});

describe('describeFindings', () => {
  it('lists each sentence with its character and reason', () => {
    expect(
      describeFindings([
        finding('Kira nods.'),
        { pc: 'Tomas Reed', sentence: 'Tomas grins.', why: '' },
      ])
    ).toBe('"Kira nods." (Kira Vale: dialogue the player never said); "Tomas grins." (Tomas Reed)');
  });
});
