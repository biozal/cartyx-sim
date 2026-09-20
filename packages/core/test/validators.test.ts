import { describe, expect, it } from 'vitest';
import { validateDmText, validatePlayerText } from '../src/validators';

const pcNames = ['Kira Vale', 'Tomas Reed'];

describe('validateDmText', () => {
  it.each([
    'Kira decides to open the door.',
    'Tomas Reed draws his sword and charges.',
    'Kira says she agrees.',
  ])('flags the DM controlling a PC: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'dm_controls_pc'
    );
  });

  it.each([
    'The goblin deals 7 damage to you.',
    'You take 5 points of fire damage.',
    'Kira loses 3 hit points.',
    'The guard rolls a 17.',
  ])('flags invented mechanics: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
      'mechanics_without_tool'
    );
  });

  it('allows numbers after a mechanics tool ran this beat', () => {
    expect(
      validateDmText('The blade bites deep for 7 damage.', { pcNames, mechanicsToolCalled: true })
    ).toBeNull();
  });

  it.each([
    'The sentry slams Tomas into the workbench.',
    'Kira, the lock clicks open under your fingers.',
    'Three crystal engines hum along the far wall.',
  ])('accepts ordinary narration: "%s"', (text) => {
    expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
  });

  describe('skipPcControl', () => {
    it('skips the verb-list rule when true', () => {
      expect(
        validateDmText('Kira decides to open the door.', {
          pcNames,
          mechanicsToolCalled: false,
          skipPcControl: true,
        })
      ).toBeNull();
    });

    it('still runs the mechanics rule when true', () => {
      expect(
        validateDmText('Kira takes 5 damage.', {
          pcNames,
          mechanicsToolCalled: false,
          skipPcControl: true,
        })?.rule
      ).toBe('mechanics_without_tool');
    });

    it('behaves exactly as today when absent or false', () => {
      expect(
        validateDmText('Kira decides to open the door.', { pcNames, mechanicsToolCalled: false })
          ?.rule
      ).toBe('dm_controls_pc');
      expect(
        validateDmText('Kira decides to open the door.', {
          pcNames,
          mechanicsToolCalled: false,
          skipPcControl: false,
        })?.rule
      ).toBe('dm_controls_pc');
    });
  });

  it('stays linear on adversarial input instead of matching quadratically', () => {
    const text = 'hp '.repeat(40_000);
    const start = performance.now();
    validateDmText(text, { pcNames, mechanicsToolCalled: false });
    expect(performance.now() - start).toBeLessThan(100);
  });

  describe('dm_state_leak', () => {
    it.each([
      'Kira Vale (id: kira) | HP 24/24, AC 15',
      'Bram Holloway (id: bram) | HP 28/28, AC 16',
      "It is Kira's turn.",
      'It is Kira’s turn.',
    ])('flags a leaked prompt-state line: "%s"', (text) => {
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([text]);
    });

    it('names only the leaked lines in strip, leaving surrounding prose out of it', () => {
      const text = [
        'The mercenaries fall back into the alley.',
        'Kira Vale (id: kira) | HP 24/24, AC 15',
        'Bram Holloway (id: bram) | HP 28/28, AC 16',
        "It is Kira's turn.",
      ].join('\n');
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([
        'Kira Vale (id: kira) | HP 24/24, AC 15',
        'Bram Holloway (id: bram) | HP 28/28, AC 16',
        "It is Kira's turn.",
      ]);
    });

    it('takes priority over the mechanics rule for a leaked HP block', () => {
      expect(
        validateDmText('Kira Vale HP 24/24, AC 15', { pcNames, mechanicsToolCalled: false })?.rule
      ).toBe('dm_state_leak');
    });

    it.each([
      'Kira mentions her HP is fine.',
      'Bram takes his turn at the wheel.',
      'The old ledger lists an id number for every crate.',
    ])('leaves ordinary narration alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
    });

    // Every shape below is taken verbatim from what actually leaked into narration in session 007.
    it.each([
      '- Kira: 20/24 HP (Dagger wound)',
      '- All three Hooded Figures: 11 HP each, AC 12',
      "[combat] Round 1: Kira Vale's turn",
      '[hand_off]',
      '{"target": {"kind": "party"}}',
      '**Current Status:**',
      'Current Status:',
    ])('flags a leaked prompt-state line: "%s"', (text) => {
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([text]);
    });

    it('names every leaked line from a real session-007 narration, leaving the prose out of it', () => {
      const text = [
        '**Current Status:**',
        '- Kira: 20/24 HP (Dagger wound)',
        '- All three Hooded Figures: 11 HP each, AC 12',
        '6. Hooded Figure (3)',
        '7. Kira Vale',
        'The mercenaries fall back into the alley.',
        "[combat] Round 1: Kira Vale's turn",
        '[hand_off]',
        '{"target": {"kind": "party"}}',
      ].join('\n');
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([
        '**Current Status:**',
        '- Kira: 20/24 HP (Dagger wound)',
        '- All three Hooded Figures: 11 HP each, AC 12',
        "[combat] Round 1: Kira Vale's turn",
        '[hand_off]',
        '{"target": {"kind": "party"}}',
      ]);
    });

    it.each([
      'The room is quiet.',
      'He wears heavy plate, well cared for.',
      'She takes a hit and keeps her feet.',
      'The AC unit rattles.',
    ])('does not flag prose that merely brushes against a leak pattern: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
    });

    it('strips only the sentence holding a tag leak, keeping the prose that shares its line', () => {
      const text = 'The mercenaries fall back. [combat] Round 2 begins.';
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip).toEqual({
        kept: 'The mercenaries fall back.',
        removed: ['[combat] Round 2 begins.'],
      });
    });

    it('strips only the sentence holding a JSON leak, keeping the prose that shares its line', () => {
      const text = 'Handing off now. {"target": {"kind": "party"}}';
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: false });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip).toEqual({
        kept: 'Handing off now.',
        removed: ['{"target": {"kind": "party"}}'],
      });
    });

    // Every shape below is taken verbatim from what leaked into narration in session 008.
    it.each([
      "Silas's work is far superior to Mira's clumsy efforts, and Bram's HP rises to 19/28 as the bleeding stops and some of his vitality returns.",
      'The strike lands true, forcing the creature to stagger back into the gloom with its health dwindled to 9 out of 22 hit points.',
      'The creature shudders, its form destabilizing as it drops to just 3 hit points, teetering on the brink of dissolution.',
      "The bleeding stops, and Silas's careful work restores some of Bram's vitality, bringing him to 19/28 HP.",
      'Initiative is rolled.',
      'The order of combat is as follows:',
      '**Initiative Order:**',
    ])('flags a session-008 leak: "%s"', (text) => {
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: true });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([text]);
    });

    // Every shape below is taken verbatim from what leaked into narration in session 009.
    it.each([
      'Act for it with tools, narrate, then call hand_off.',
      'Act for him with tools, narrate, then call hand_off.',
      'hand_off(target="party")',
      'Continue with other tools, or call hand_off.',
      'Now call `hand_off`.',
      'attack(goblin-1)',
      'The ogre has 36/52 health.',
      'Its hit points: 36 of 52.',
      "Blood sprays from the wound as the guard's HP drops to a critical 8.",
      "The impact deals five points of bludgeoning damage, dropping the creature's health to 36/52.",
      'The scribe gasps as cold steel pierces flesh, leaving him clinging to consciousness at 4/28 hit points.',
    ])('flags a session-009 leak: "%s"', (text) => {
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: true });
      expect(violation?.rule).toBe('dm_state_leak');
      expect(violation?.strip?.removed).toEqual([text]);
    });

    it.each([
      'Her health is failing, and the healer shakes his head.',
      'The narrator calls it a tale of health and 3 wishes.',
      'He hands off the torch to Mira.',
      "I'll act for them with tools, the smith says.",
      'The healer mutters about health as she measures 3/4 of a vial.',
      'The herald begins to narrate (in a booming voice) the tale.',
    ])('leaves prose near the session-009 shapes alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })).toBeNull();
    });

    it('strips the DM apologizing to the engine, keeping the story around it (session 012)', () => {
      const text =
        "My apologies for the error. Let me correct the narration of Kira's turn.\n\nThe merchant swings wildly and misses.";
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })?.strip).toEqual({
        kept: 'The merchant swings wildly and misses.',
        removed: ['My apologies for the error.', "Let me correct the narration of Kira's turn."],
      });
    });

    it('keeps the correction a meta prefix introduces, dropping only the prefix', () => {
      const violation = validateDmText(
        'Correction: the goblin dodges and the blade finds only air.',
        { pcNames, mechanicsToolCalled: true }
      );
      expect(violation?.strip).toEqual({
        kept: 'the goblin dodges and the blade finds only air.',
        removed: ['Correction:'],
      });
      expect(
        validateDmText('My apologies, the error was mine: the blade misses.', {
          pcNames,
          mechanicsToolCalled: true,
        })?.strip?.kept
      ).toBe('the blade misses.');
    });

    it.each([
      '"My apologies, traveller," the innkeeper says, bowing low.',
      'She lets me correct the ledger before the reeve arrives.',
      'The correction to the map was made in a careful hand.',
      // Unquoted NPC lines, which npc_say sends without quote marks.
      'My apologies, my lady, the steward murmurs, bowing low.',
      'Apologies, the guard mutters, and steps aside.',
      "I'll fix the wheel before the rain comes, the wainwright says.",
      'Let me adjust the lens, Sella mutters, and the beam narrows.',
      'Let me correct the ledger before the reeve arrives, she says.',
      'I adjust the strap on my pack.',
      'Correction, my lord, the scribe says.',
    ])('leaves an apology or correction inside the story alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })).toBeNull();
    });

    it('strips a tool call the DM set in bold (session 012)', () => {
      const text =
        'What will the party do next?\n\n**hand_off** to the party.\n\nSilas straightens up.';
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })?.strip).toEqual({
        kept: 'What will the party do next?\n\nSilas straightens up.',
        removed: ['**hand_off** to the party.'],
      });
    });

    it('strips a tool call written as bare lines (session 010)', () => {
      const text =
        'The party holds their positions, waiting for the next beat.\n\nhand_off\ntarget: party';
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })?.strip).toEqual({
        kept: 'The party holds their positions, waiting for the next beat.',
        removed: ['hand_off', 'target: party'],
      });
      expect(
        validateDmText('The window is closed. hand_off\ntarget: party', {
          pcNames,
          mechanicsToolCalled: true,
        })?.strip
      ).toEqual({ kept: 'The window is closed.', removed: ['hand_off', 'target: party'] });
    });

    it.each(['Target: the tallest tower, the old woman says.', 'The ids: carved into the door.'])(
      'leaves prose that only starts like a tool line alone: "%s"',
      (text) => {
        expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })).toBeNull();
      }
    );

    // Bookkeeping the DM read out in its own words in session 011.
    it.each(["Giant Rat 2's turn is complete.", "Kira Vale's turn is over."])(
      'flags a session-011 turn announcement: "%s"',
      (text) => {
        const violation = validateDmText(text, { pcNames, mechanicsToolCalled: true });
        expect(violation?.rule).toBe('dm_state_leak');
        expect(violation?.strip?.removed).toEqual([text]);
      }
    );

    it.each([
      'The mill wheel turns as the water rises.',
      'She waits her turn at the well.',
      // Table talk, not bookkeeping: a DM saying this aloud belongs in the story.
      'Kira Vale, it is your turn. What do you do?',
      // Prose that happens to use the same words, which an unanchored pattern would cut.
      'The mill wheel groans, and before its turn is complete the rope snaps.',
      "She waits until the sentry's patrol turn is over, then slips past.",
      'Bram grunts: "Wait your turn — his turn is over."',
    ])('leaves ordinary turns of phrase and table talk alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })).toBeNull();
    });

    it('keeps the rest of a paragraph when one sentence in it leaks a hit-point count', () => {
      const text =
        'Silas cleans the gash and wraps it tightly. Bram hisses in pain. The bleeding stops, bringing him to 19/28 HP.\n\nMeanwhile, Tomas scans the walls.';
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: true });
      expect(violation?.strip).toEqual({
        kept: 'Silas cleans the gash and wraps it tightly. Bram hisses in pain.\n\nMeanwhile, Tomas scans the walls.',
        removed: ['The bleeding stops, bringing him to 19/28 HP.'],
      });
    });

    it('strips a turn-order list of combatant names, from session 008, as whole lines', () => {
      const text = [
        'The chamber erupts into chaos.',
        '',
        'Initiative is rolled. The order of combat is as follows:',
        '1. Mira Ashdown',
        '2. Kira Vale',
        '3. Shadow Stalker 3',
        '4. **Bram Holloway** (9)',
        '- Shadow Stalker (15)',
        '',
        '**Mira Ashdown**, it is your turn. What do you do?',
      ].join('\n');
      const violation = validateDmText(text, {
        pcNames,
        mechanicsToolCalled: true,
        combatantNames: ['Mira Ashdown', 'Kira Vale', 'Bram Holloway', 'Shadow Stalker'],
      });
      expect(violation?.strip).toEqual({
        kept: 'The chamber erupts into chaos.\n\n**Mira Ashdown**, it is your turn. What do you do?',
        removed: [
          'Initiative is rolled.',
          'The order of combat is as follows:',
          '1. Mira Ashdown',
          '2. Kira Vale',
          '3. Shadow Stalker 3',
          '4. **Bram Holloway** (9)',
          '- Shadow Stalker (15)',
        ],
      });
    });

    it('strips a list item naming a numbered monster by its base name (session 007)', () => {
      const text = 'Steel flashes.\n1. Tomas Reed\n2. Hooded Figure (2)\n3. Hooded Figure 3';
      const violation = validateDmText(text, {
        pcNames,
        mechanicsToolCalled: true,
        combatantNames: ['Tomas Reed', 'Hooded Figure 1', 'Hooded Figure 2'],
      });
      expect(violation?.strip).toEqual({
        kept: 'Steel flashes.',
        removed: ['1. Tomas Reed', '2. Hooded Figure (2)', '3. Hooded Figure 3'],
      });
    });

    it.each([
      ['Borin grins. "The order of combat is simple. We hit hard."', 'Borin grins. "We hit hard."'],
      [
        '"You there. Stop. It is Kira\'s turn to talk," Borin says. The fire crackles.',
        '"You there. Stop." The fire crackles.',
      ],
      [
        'He nods. “Bram sits at 19/28 HP. We ride at dawn.” She agrees.',
        'He nods. “We ride at dawn.” She agrees.',
      ],
    ])('keeps the quote marks around speech a leak cut runs through: "%s"', (text, kept) => {
      const violation = validateDmText(text, { pcNames, mechanicsToolCalled: true });
      expect(violation?.strip?.kept).toBe(kept);
    });

    it('keeps a title with the sentence after it when that sentence leaks', () => {
      const violation = validateDmText('The door opens. Mr. Vale has AC 12 armor.', {
        pcNames,
        mechanicsToolCalled: true,
      });
      expect(violation?.strip).toEqual({
        kept: 'The door opens.',
        removed: ['Mr. Vale has AC 12 armor.'],
      });
    });

    it('strips an unnumbered turn-order list whose entries carry initiative', () => {
      const text =
        'Initiative Order:\nKira Vale — 18\n- Goblin: 12\n1. Tomas Reed (Initiative 9)\n2. Shadow Stalker #2\nSteel rings out.';
      const violation = validateDmText(text, {
        pcNames,
        mechanicsToolCalled: true,
        combatantNames: ['Kira Vale', 'Goblin', 'Tomas Reed', 'Shadow Stalker'],
      });
      expect(violation?.strip?.kept).toBe('Steel rings out.');
    });

    it('leaves a bulleted list of names without numbers alone', () => {
      const text = 'The notice lists:\n- Wolf\n- Borin\n- Honey';
      expect(
        validateDmText(text, {
          pcNames,
          mechanicsToolCalled: true,
          combatantNames: ['Wolf', 'Borin'],
        })
      ).toBeNull();
    });

    it.each([
      'The knights hold the order of battle as the horn sounds.',
      'He whispers that the turn order of the ritual matters.',
      'Kira drops to 0 hit points and collapses, her hammer clattering away.',
      'An order of knights rides past.',
    ])('leaves story prose that only sounds like bookkeeping alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: true })).toBeNull();
    });

    it.each([
      'Tomas regains 4 hit points.',
      'The creature has hit points to spare.',
      'The order of the day is silence.',
      'Kira rolls initiative in her head, counting heartbeats.',
      '1. The mill',
    ])('leaves prose and mechanics claims to other rules: "%s"', (text) => {
      const violation = validateDmText(text, {
        pcNames,
        mechanicsToolCalled: true,
        combatantNames: ['Mira Ashdown', 'Shadow Stalker'],
      });
      expect(violation).toBeNull();
    });

    it.each([
      '…lined with brackets [sic].',
      'A crate marked "cargo" sits by the door.',
      'The note read: take the {small} road.',
    ])('leaves prose that merely resembles a leak alone: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
    });
  });

  describe('G4.2: catches past-tense, adverb, vocative, and Unicode PC control', () => {
    const elodieParty = [...pcNames, 'Élodie Marsh'];

    it.each([
      'Kira drew her hammer and attacked the goblin.',
      'Kira decided to follow the shadow.',
      'Kira quickly draws her hammer.',
      'Kira, you draw your hammer and charge.',
    ])('flags: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
        'dm_controls_pc'
      );
    });

    it('flags a Unicode PC name: "Élodie draws her bow."', () => {
      expect(
        validateDmText('Élodie draws her bow.', {
          pcNames: elodieParty,
          mechanicsToolCalled: false,
        })?.rule
      ).toBe('dm_controls_pc');
    });

    it.each([
      'Kira, the lock clicks open under your fingers.',
      'The sentry slams Tomas into the workbench.',
      'Kira, you notice fresh scratches on the housing.',
      'Kira hears a click.',
    ])('still accepts: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })).toBeNull();
    });
  });

  describe('G4.3: fewer DM validator false positives', () => {
    it('accepts a capitalized common word that only lowercase-matches a PC first name', () => {
      expect(
        validateDmText('The guards will attack at dawn.', {
          pcNames: ['Will Harrow'],
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it('accepts a PC first name that appears lowercase as an ordinary word', () => {
      expect(
        validateDmText('The old sage says nothing.', {
          pcNames: ['Sage Thorn'],
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it('accepts a mechanics-shaped number with no damage/HP noun', () => {
      expect(
        validateDmText('The merchant takes 5 gold from the table.', {
          pcNames,
          mechanicsToolCalled: false,
        })
      ).toBeNull();
    });

    it.each([
      'The goblin deals 7 damage to you.',
      'You take 5 points of fire damage.',
      'Kira loses 3 hit points.',
      'The guard rolls a 17.',
      'Tomas regains 4 hit points.',
    ])('still flags mechanics without a tool: "%s"', (text) => {
      expect(validateDmText(text, { pcNames, mechanicsToolCalled: false })?.rule).toBe(
        'mechanics_without_tool'
      );
    });
  });

  describe('F2: ordinary narration mentioning a PC is not PC control', () => {
    const party = ['Kira Vale', 'Tomas Reed', 'Will Harrow'];
    const elodieParty = [...party, 'Élodie Marsh'];

    it.each([
      'As Kira watches, goblins charge from the dark.',
      'Kira screams. Goblins charge!',
      'Kira was attacked by the goblin.',
      'Kira is shot in the shoulder by an arrow.',
      'Before Kira can move, the ogre attacks.',
      'Kira hears someone shout her name.',
      'Tomas has first move.',
      'Will the guards attack?',
      'Kira, you said you wanted answers.',
    ])('accepts: "%s"', (text) => {
      expect(validateDmText(text, { pcNames: party, mechanicsToolCalled: false })).toBeNull();
    });

    it.each([
      'Kira drew her hammer and attacked the goblin.',
      'Kira decided to follow the shadow.',
      'Kira quickly draws her hammer.',
      'Kira, you draw your hammer and charge.',
      'Élodie draws her bow.',
      'Kira decides to open the door.',
      'Tomas Reed draws his sword and charges.',
      'Kira says she agrees.',
      'Will draws his dagger.',
      'The door bursts open and Will quickly draws his dagger.',
    ])('still flags: "%s"', (text) => {
      expect(validateDmText(text, { pcNames: elodieParty, mechanicsToolCalled: false })?.rule).toBe(
        'dm_controls_pc'
      );
    });

    it.each([
      'Kira quickly '.repeat(15_385),
      'Kira was '.repeat(22_223),
      'Will the '.repeat(22_223),
      '. Will '.repeat(28_572),
      'Kira, you '.repeat(20_000),
      `${' '.repeat(199_990)}Will draws`,
      'Kira '.repeat(40_000),
    ])('stays fast on 200,000 characters of adversarial input (case %#)', (text) => {
      const start = performance.now();
      validateDmText(text.slice(0, 200_000), { pcNames: party, mechanicsToolCalled: false });
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

describe('validatePlayerText', () => {
  const otherPcNames = ['Kira Vale'];

  it('flags a player controlling another PC', () => {
    expect(
      validatePlayerText('Kira attacks the engine with her wrench.', { otherPcNames })?.rule
    ).toBe('player_controls_other');
  });

  it.each(['I successfully pick the lock.', 'I roll a 20!'])(
    'flags a player narrating outcomes: "%s"',
    (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    }
  );

  it.each([
    'I try to convince the guard to let us pass.',
    'I convince the guard to let us pass.',
    'Careful, Kira.',
    'I swing my longsword at the sentry.',
  ])('accepts declared attempts: "%s"', (text) => {
    expect(validatePlayerText(text, { otherPcNames })).toBeNull();
  });

  describe('G4.1: only flags completed-outcome phrasing', () => {
    it.each([
      'I hit the orc with my warhammer.',
      'Can we convince them to stand down?',
      'I hope we succeed.',
      'I attack the goblin.',
      'We try to persuade the guard.',
    ])('accepts: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })).toBeNull();
    });

    it.each([
      'I successfully pick the lock.',
      'I killed the orc.',
      'The guard is convinced and lets us pass.',
      'I roll a 20!',
      'It works perfectly.',
      'The goblin falls dead.',
      'I convinced the guard.',
    ])('flags: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    });
  });

  describe('F1: questions and opinions are not outcome claims', () => {
    it.each([
      'Who killed the professor?',
      'I am convinced this is a trap.',
      'Has anyone persuaded the dean yet?',
      'Do you know how it works?',
    ])('accepts: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })).toBeNull();
    });

    it.each([
      'I killed the orc.',
      'I convinced the guard.',
      'I successfully pick the lock.',
      'The goblin falls dead.',
      'I roll a 20!',
    ])('still flags: "%s"', (text) => {
      expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
    });

    it.each(['I roll a 20! Did it work?', 'Who killed him? I killed the orc.'])(
      'flags a claim in a non-question sentence next to a question: "%s"',
      (text) => {
        expect(validatePlayerText(text, { otherPcNames })?.rule).toBe('player_narrates_outcome');
      }
    );

    it.each([
      'we killed '.repeat(20_000),
      'I am '.repeat(40_000),
      'it works '.repeat(22_223),
      '?'.repeat(200_000),
      ' '.repeat(200_000),
    ])('stays fast on 200,000 characters of adversarial input (case %#)', (text) => {
      const start = performance.now();
      validatePlayerText(text.slice(0, 200_000), { otherPcNames });
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});
