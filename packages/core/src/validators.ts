import { splitSentences } from './pc-control';
import { escapeRegExp, joinKeptSentences } from './text';

export type ViolationRule =
  | 'dm_controls_pc'
  | 'dm_state_leak'
  | 'mechanics_without_tool'
  | 'player_controls_other'
  | 'player_narrates_outcome';

export interface Violation {
  rule: ViolationRule;
  message: string;
  /** Only for `dm_state_leak`: the narration with its leaks removed, and what was removed. */
  strip?: StateLeakStrip;
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

const COMPLETED_VERBS = 'killed|defeated|convinced|persuaded|succeeded';

// A word between "I/we" and a completed verb that makes it a state, an opinion, or a denial
// ("I am convinced this is a trap", "we were defeated", "I never killed anyone") rather than a
// claim that the player's own action worked.
const NOT_A_CLAIM = 'am|are|was|were|be|been|being|feel|felt|seem|seemed|remain|remained|not|never';

// Only completed-outcome claims: first-person results ("I killed the orc", "we finally
// persuaded him"), explicit result shapes ("the guard is convinced", "falls dead",
// "successfully", "natural 20", "roll a 20"), and "it works" as a statement about the player's
// own action. Present-tense declarations ("I hit the orc"), attempts, and bare verbs in
// someone else's clause ("Who killed the professor?") are not claims. Tested per sentence;
// questions are skipped before this runs.
const OUTCOME = new RegExp(
  '\\b(?:successfully|falls? dead|(?:is|are) (?:dead|defeated|convinced)|natural (?:20|1)|rolls?(?:ed)?\\s+(?:a\\s+)?\\d+)\\b' +
    `|\\b(?:I|we)\\s+(?:(?!(?:${NOT_A_CLAIM})\\b)[a-z'’]+\\s+)?(?:${COMPLETED_VERBS})\\b` +
    '|^(?:(?:and|so|then)\\s+)?it works\\b|\\b(?:and|so) it works\\b',
  'i'
);

/** A sentence ending in "?" (optionally followed by closing quotes or brackets). */
const QUESTION = /\?["'”’)\]]*$/;

/** Splits text after sentence-ending punctuation. Linear: the lookbehind checks one character. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function claimsOutcome(text: string): boolean {
  return sentences(text).some((sentence) => !QUESTION.test(sentence) && OUTCOME.test(sentence));
}

// Present tense only: "Kira, you draw your hammer" decides for the player, while "Kira, you said
// you wanted answers" recalls something the player already chose.
const VOCATIVE_VERBS =
  'decide|choose|agree|attack|cast|say|shout|grab|run|draw|shoot|move|nod|follow|refuse|charge';

// Words that may not sit between a PC's name and a control verb. Auxiliaries and modals make the
// PC an object or a possibility ("Kira was attacked", "Before Kira can move"); perception verbs
// describe what the PC experiences ("Kira hears someone shout her name").
const GAP_STOP_WORDS =
  'is|was|were|been|being|am|are|gets|got|can|could|may|might|must|will|would|shall|should|' +
  'has|have|had|does|did|see|sees|saw|hear|hears|heard|notice|notices|noticed|feel|feels|felt|' +
  'smell|smells|smelled|sense|senses|sensed|watch|watches|watched';

// One intervening word: letters only, so the gap never crosses "," "." "!" or "?".
const GAP_WORD = `(?!(?:${GAP_STOP_WORDS})(?![\\p{L}\\p{N}]))[\\p{L}'’\\-]+\\s+`;

// The start of the text or of a sentence. Bounded so the lookbehind stays cheap.
const SENTENCE_START = `(?:^|[.!?]["'”’)\\]]{0,3}\\s{1,20})`;

// First names that are also common English words. At the start of a sentence their
// capitalization says nothing ("Will the guards attack?"), so they need the verb right after.
const COMMON_WORD_NAMES = new Set(
  (
    'amber art august bill can chase dawn drew faith frank grace grant hazel holly hope hunter ivy ' +
    'jack joy june lance mark may miles pat penny ray reed rich river rob robin rose ruby sage sky ' +
    'summer will wren'
  ).split(' ')
);

/**
 * Checks whether `name` controls a PC in `text`: a control verb right after the name, up to two
 * intervening letter words before it (e.g. an adverb), or a vocative "Name, you <verb>".
 * Boundaries are Unicode-aware (`\p{L}`/`\p{N}` lookarounds with the `u` flag) so names like
 * "Élodie" match, since `\b` only recognizes ASCII word characters. With
 * `directAtSentenceStart`, a match at the start of a sentence only counts with the verb directly
 * after the name.
 */
function nameControlsSomeone(
  text: string,
  name: string,
  options: { caseInsensitive: boolean; directAtSentenceStart: boolean }
): boolean {
  const escaped = escapeRegExp(name);
  const notAtSentenceStart = options.directAtSentenceStart
    ? `(?<!${SENTENCE_START}${escaped})`
    : '';
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?:` +
      `,\\s*you\\s+(?:${VOCATIVE_VERBS})` +
      `|\\s+(?:${CONTROL_VERBS})` +
      `|${notAtSentenceStart}\\s+(?:${GAP_WORD}){1,2}(?:${CONTROL_VERBS})` +
      `)(?![\\p{L}\\p{N}])`,
    options.caseInsensitive ? 'iu' : 'u'
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
    if (nameControlsSomeone(text, name, { caseInsensitive: true, directAtSentenceStart: false })) {
      return name;
    }
    const first = name.split(/\s+/)[0];
    if (
      first &&
      first !== name &&
      first.length > 1 &&
      nameControlsSomeone(text, first, {
        caseInsensitive: false,
        directAtSentenceStart: COMMON_WORD_NAMES.has(first.toLowerCase()),
      })
    ) {
      return first;
    }
  }
  return null;
}

// Prompt state that must never reach narration: a combatant's id parenthetical, an HP block
// (either digit order, or "HP rises to 19/28"), a hit-point readout ("9 out of 22 hit points",
// "drops to just 3 hit points", "4 hit points left"; "loses 3 hit points" is a mechanics claim,
// left to that rule, and "drops to 0 hit points" is a PC going down, which everyone sees), an AC
// readout, a bald "whose turn" statement, a turn-order readout ("Initiative is rolled.", "The
// order of combat is as follows:", "**Initiative:** Kira 18"), a transcript tag (e.g. "[combat]",
// "[hand_off]"), a hand-off JSON object, or the DM echoing its engine instruction ("Act for it
// with tools, narrate, then call hand_off.") or a tool call ("hand_off(target=…)"). An HP figure
// counts in any wording ("HP drops to a critical 8"), since "HP" is never story prose, and so does
// "health" with an x/y readout ("health to 36/52"). Checked one sentence at a time, so the prose
// around a leak survives. "Order of battle" and "turn order" are left alone: story prose uses both.
const SENTENCE_LEAK_PATTERNS = [
  /\(id:\s*[a-z0-9-]+\)/i,
  /\bHP\b[^.\d\n]{0,30}\d/i,
  /\bhealth\b[^.\d\n]{0,30}\d+\s*\/\s*\d+/i,
  /\d+\s*\/\s*\d+\s*(?:HP|hit\s+points?)\b/i,
  /\b(?:\d+\s+(?:out\s+)?of\s+\d+|(?:to|at|with)\s+(?:just\s+|only\s+)?[1-9]\d*)\s+(?:hit\s+points?|HP)\b/i,
  /\b[1-9]\d*\s+(?:hit\s+points?|HP)\s+(?:left|remaining)\b/i,
  /\bAC\s+\d+\b/i,
  /\bIt is [^.]{1,40}['’]s turn\b/i,
  /\binitiative\s+order\b|\border\s+of\s+(?:combat|initiative)\b|\binitiative\s+(?:is|has been)\s+rolled\b|\binitiative\b\W{0,4}:/i,
  /\[(?:combat|roll|state|scene|npc|lore|invented|hand_off|ooc)\]/i,
  /\{[^}]*"(?:target|kind)"\s*:/,
  /\bAct for (?:him|her|it|them) with tools\b|\bthen call hand_off\b|\b(?:hand_off|narrate|scene_change|start_combat|end_combat)\s*\(/i,
];

// Whole lines of prompt state: the "Current Status" heading the DM writes above its own status
// readout, and a turn-order entry, which is how the DM reads out initiative: a numbered item that
// is only a combatant's name ("1. Mira Ashdown", "3. Shadow Stalker #3"), or a combatant's name
// with its initiative after it, in a list or not ("- **Bram Holloway** (21)", "Kira Vale — 18",
// "2. Goblin: 12", "1. Kira Vale (Initiative 18)"). A bulleted name with no number is left alone,
// since a notice or a roll call lists names that way too.
const LINE_LEAK_PATTERNS = [/^\s*\*\*Current Status:?\*\*\s*$/i, /^\s*Current Status:?\s*$/i];
const NUMBERED_ITEM = /^\s*\d{1,2}[.)]\s+/;
const BULLET = /^\s*[-*•]\s+/;
const INITIATIVE_SUFFIX =
  /(?:\s*\(\s*(?:initiative\s*:?\s*)?\d{1,2}\s*\)|\s*[—–:-]\s*(?:initiative\s*:?\s*)?\d{1,2})\s*$/i;

function isTurnOrderEntry(line: string, combatantNames: readonly string[]): boolean {
  if (combatantNames.length === 0) return false;
  const numbered = NUMBERED_ITEM.test(line);
  let item = line.replace(NUMBERED_ITEM, '').replace(BULLET, '').trim();
  const withInitiative = INITIATIVE_SUFFIX.test(item);
  if (!numbered && !withInitiative) return false;
  item = item.replace(INITIATIVE_SUFFIX, '');
  const name = item
    .replace(/\*\*|__/g, '')
    .replace(/[.:]\s*$/, '')
    .replace(/\s+#(\d+)$/, ' $1')
    .trim()
    .toLowerCase();
  if (name.length === 0) return false;
  return combatantNames.some((candidate) => {
    // Numbered copies share one base name: the DM may write "Shadow Stalker 3" for a monster
    // added as "Shadow Stalker", or "Hooded Figure" for one added as "Hooded Figure 1".
    const base = candidate.toLowerCase().replace(/\s+\d+$/, '');
    return name === base || new RegExp(`^${escapeRegExp(base)}\\s+\\d+$`).test(name);
  });
}

/** What `stripStateLeaks` removed from a narration, and what is left. */
export interface StateLeakStrip {
  /** The narration without its leaked lines and sentences; '' when nothing is left. */
  kept: string;
  /** The removed lines and sentences, verbatim and in order. */
  removed: string[];
}

const leaks = (sentence: string) => SENTENCE_LEAK_PATTERNS.some((p) => p.test(sentence));

/**
 * The narration without its prompt-state leaks: a heading or turn-order entry goes as a whole
 * line, any other leak goes as the one sentence it sits in, so prose sharing its line survives,
 * and a quote mark the cut sentence held is added back to the speech left around it. Runs of
 * blank lines left behind collapse to one paragraph break.
 */
export function stripStateLeaks(
  text: string,
  combatantNames: readonly string[] = []
): StateLeakStrip {
  const removed: string[] = [];
  const lines = text.split('\n').map((line) => {
    if (
      LINE_LEAK_PATTERNS.some((pattern) => pattern.test(line)) ||
      isTurnOrderEntry(line, combatantNames)
    ) {
      removed.push(line.trim());
      return '';
    }
    const parts = splitSentences(line);
    if (!parts.some(({ sentence }) => leaks(sentence))) return line;
    const cut = parts.map((part) => ({ ...part, keep: !leaks(part.sentence) }));
    removed.push(...cut.filter((part) => !part.keep).map((part) => part.sentence));
    return joinKeptSentences(cut);
  });
  const kept = lines
    .join('\n')
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n\n')
    .trim();
  return { kept, removed };
}

export function validateDmText(
  text: string,
  context: {
    pcNames: readonly string[];
    mechanicsToolCalled: boolean;
    /** True when a checker seat is configured: it replaces this verb-list rule. Default false. */
    skipPcControl?: boolean;
    /** Every combatant's name, so a turn-order list of them counts as a leak. Default none. */
    combatantNames?: readonly string[];
  }
): Violation | null {
  const leaked = stripStateLeaks(text, context.combatantNames);
  if (leaked.removed.length > 0) {
    return {
      rule: 'dm_state_leak',
      message:
        'Narration must not include prompt state such as combatant ids, HP counts, turn-order lists, or whose-turn lines; describe the scene in prose instead.',
      strip: leaked,
    };
  }
  const pc = context.skipPcControl ? null : controlledCharacter(text, context.pcNames);
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
  if (claimsOutcome(text)) {
    return {
      rule: 'player_narrates_outcome',
      message: 'Declare what you attempt, not the result. The DM decides what happens.',
    };
  }
  return null;
}
