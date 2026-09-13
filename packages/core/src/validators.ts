import { escapeRegExp } from './text';

export type ViolationRule =
  'dm_controls_pc' | 'mechanics_without_tool' | 'player_controls_other' | 'player_narrates_outcome';

export interface Violation {
  rule: ViolationRule;
  message: string;
}

const CONTROL_VERBS =
  'decides?|chooses?|agrees?|attacks?|casts?|says?|shouts?|grabs?|runs?|draws?|shoots?|moves?|nods?|follows?|refuses?';

const MECHANICS =
  /\b\d+\s+(?:points?\s+of\s+)?(?:\w+\s+)?damage\b|\b(?:takes?|deals?|loses?|heals?|regains?)\s+\d+\b|\brolls?\s+(?:a\s+)?\d+\b|\b(?:hp|hit points)\b[^.]*\d/i;

const OUTCOME =
  /\b(?:successfully|succeeds?|it works|falls? dead|is (?:dead|defeated|convinced)|natural (?:20|1)|rolls? (?:a )?\d+|(?:i|we) (?:hit|kill|defeat|convince|persuade|succeed))\b/i;

/** Full names plus first names, so "Kira attacks" matches "Kira Vale". */
function nameVariants(names: readonly string[]): string[] {
  const variants = names.flatMap((name) => [name, name.split(/\s+/)[0] ?? name]);
  return [...new Set(variants)].filter((name) => name.length > 1);
}

function controlledCharacter(text: string, names: readonly string[]): string | null {
  for (const name of nameVariants(names)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s+(?:${CONTROL_VERBS})\\b`, 'i');
    if (pattern.test(text)) return name;
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
