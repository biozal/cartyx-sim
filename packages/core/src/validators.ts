import { escapeRegExp } from './text';

export type ViolationRule =
  'dm_controls_pc' | 'mechanics_without_tool' | 'player_controls_other' | 'player_narrates_outcome';

export interface Violation {
  rule: ViolationRule;
  message: string;
}

// Present and past tense, so "Kira draws" and "Kira drew" both count.
const CONTROL_VERBS =
  'decides?|decided|chooses?|chose|agrees?|agreed|attacks?|attacked|casts?|cast|says?|said|' +
  'shouts?|shouted|grabs?|grabbed|runs?|ran|draws?|drew|shoots?|shot|moves?|moved|nods?|nodded|' +
  'follows?|followed|refuses?|refused|charges?|charged';

// The hp/hit-points branch bounds its gap to the digit (excluding periods and digits from it,
// and capping its width) so a long run of text with neither never forces linear backtracking at
// every "hp" occurrence — unbounded `[^.]*\d` is quadratic on adversarial input with no digit.
// takes/deals/loses only count as mechanics when a damage/HP noun follows within a few words
// ("The merchant takes 5 gold" is not damage); heals/regains always count.
const MECHANICS =
  /\b\d+\s+(?:points?\s+of\s+)?(?:\w+\s+)?damage\b|\b(?:heals?|regains?)\s+\d+\b|\b(?:takes?|deals?|loses?)\s+\d+\s+(?:\S+\s+){0,3}(?:damage|hp|hit points?)\b|\brolls?\s+(?:a\s+)?\d+\b|\b(?:hp|hit points)\b[^.\d]{0,30}\d/i;

// Only completed-outcome phrasing: past-tense results, not present-tense declarations, questions,
// or attempts ("I hit the orc" and "I try to convince" are declarations; "I killed the orc" and
// "I convinced the guard" claim a result the DM has not decided).
const OUTCOME =
  /\b(?:successfully|it works|falls? dead|is (?:dead|defeated|convinced)|natural (?:20|1)|rolls?(?:ed)?\s+(?:a\s+)?\d+|killed|defeated|convinced|persuaded|succeeded)\b/i;

/**
 * Checks whether `name` controls a PC in `text`: an action verb right after the name (with up to
 * two intervening words, e.g. an adverb), or a vocative "Name, you <verb>". Boundaries are
 * Unicode-aware (`\p{L}`/`\p{N}` lookarounds with the `u` flag) so names like "Élodie" match,
 * since `\b` only recognizes ASCII word characters.
 */
function nameControlsSomeone(text: string, name: string, caseInsensitive: boolean): boolean {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?:,\\s*you\\s+(?:${CONTROL_VERBS})|\\s+(?:\\S+\\s+){0,2}(?:${CONTROL_VERBS}))(?![\\p{L}\\p{N}])`,
    caseInsensitive ? 'iu' : 'u'
  );
  return pattern.test(text);
}

/**
 * Full names match case-insensitively, as before. A first name alone only matches when it
 * appears capitalized in the text, so a PC named "Will Harrow" or "Sage Thorn" does not
 * false-positive on the ordinary words "will" or "sage".
 */
function controlledCharacter(text: string, names: readonly string[]): string | null {
  for (const name of names) {
    if (nameControlsSomeone(text, name, true)) return name;
    const first = name.split(/\s+/)[0];
    if (first && first !== name && first.length > 1 && nameControlsSomeone(text, first, false)) {
      return first;
    }
  }
  return null;
}

export function validateDmText(
  text: string,
  context: { pcNames: readonly string[]; mechanicsToolCalled: boolean }
): Violation | null {
  const pc = controlledCharacter(text, context.pcNames);
  if (pc) {
    return {
      rule: 'dm_controls_pc',
      message: `Do not decide what ${pc} does or says; describe the world and let the player choose.`,
    };
  }
  if (!context.mechanicsToolCalled && MECHANICS.test(text)) {
    return {
      rule: 'mechanics_without_tool',
      message:
        'Damage, healing, HP, and roll numbers must come from a tool (attack, cast_spell, apply_damage, heal, request_check). Call the tool first, then narrate without inventing numbers.',
    };
  }
  return null;
}

export function validatePlayerText(
  text: string,
  context: { otherPcNames: readonly string[] }
): Violation | null {
  const other = controlledCharacter(text, context.otherPcNames);
  if (other) {
    return {
      rule: 'player_controls_other',
      message: `Only play your own character; do not decide what ${other} does.`,
    };
  }
  if (OUTCOME.test(text)) {
    return {
      rule: 'player_narrates_outcome',
      message: 'Declare what you attempt, not the result. The DM decides what happens.',
    };
  }
  return null;
}
