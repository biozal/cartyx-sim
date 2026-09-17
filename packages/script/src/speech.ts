import { escapeRegExp } from '@cartyx-sim/core';
import {
  hasWords,
  Mask,
  pairQuotes,
  removeEmphasis,
  removeQuotes,
  type QuoteSpan,
  type Range,
} from './normalize';

export interface SpeechSplit {
  mask: Mask;
  /** The kept source ranges of each spoken line, in order. */
  lines: Range[][];
  /** Stage directions dropped from between the quotes, trimmed, in order. */
  directions: Range[];
}

const SPACE = /\s/;

/** The text outside the quote spans (quote marks excluded), as ranges. */
function gaps(length: number, spans: readonly QuoteSpan[]): Range[] {
  const result: Range[] = [];
  let cursor = 0;
  for (const span of spans) {
    result.push({ start: cursor, end: span.open });
    if (span.close === null) return result;
    cursor = span.close + 1;
  }
  result.push({ start: cursor, end: length });
  return result;
}

function trimRange(raw: string, range: Range): Range {
  let { start, end } = range;
  while (start < end && SPACE.test(raw[start]!)) start++;
  while (end > start && SPACE.test(raw[end - 1]!)) end--;
  return { start, end };
}

/** Kept, non-space characters in the ranges. */
function countKept(mask: Mask, ranges: readonly Range[]): number {
  let count = 0;
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) {
      if (!mask.isRemoved(i) && !SPACE.test(mask.raw[i]!)) count++;
    }
  }
  return count;
}

function firstKeptIndex(mask: Mask): number {
  for (let i = 0; i < mask.raw.length; i++) {
    if (!mask.isRemoved(i) && !SPACE.test(mask.raw[i]!)) return i;
  }
  return -1;
}

/** A sentence-final character: `. , ! ? … — –`. */
const SENTENCE_END = /[.,!?…—–]/;

// A closed list of manner adverbs, used everywhere a `\w+ly` slot would over-match real words
// that happen to end in "ly" ("early", "only", "family"). Every adverb slot below uses this list,
// case-insensitively. Wrapped in its own group so embedding it next to other atoms (`${ADVERB}\s+`)
// can't let `|`'s low precedence leak the alternation past where it's meant to end.
const ADVERB =
  '(?:quietly|softly|slowly|firmly|sharply|calmly|grimly|flatly|dryly|coldly|gently|lowly|' +
  'finally|quickly|again|barely|carefully|evenly|tightly|warmly|wearily)';

// A closed list of gerunds a participle clause can open with ("I nod, glancing at the door.").
// Words that merely end in "ing" but aren't on this list ("morning", "burning", "knowing",
// "meaning") do not start a participle clause. Wrapped in its own group; see `ADVERB`.
const GERUNDS =
  '(?:drawing|stepping|pointing|glancing|nodding|looking|turning|leaning|gesturing|shrugging|' +
  'smiling|grinning|frowning|sighing|raising|lowering|backing|keeping|reaching|gripping|' +
  'tightening|crossing|shaking|tilting|narrowing|moving|watching|holding|resting|' +
  'straightening|crouching|kneeling)';

// A whole word that, if it appears anywhere in a participle clause's tail, means the tail is
// carrying its own subject, auxiliary, or speech verb rather than just describing a gesture — so
// the clause is reported speech, not body language, even though it opened with a real gerund.
const TAIL_STOPWORDS = new Set([
  'i',
  "i'm",
  "i'll",
  'we',
  "we're",
  'you',
  "you're",
  'he',
  'she',
  'they',
  "it's",
  "let's",
  'is',
  'are',
  'am',
  'was',
  'were',
  'be',
  'will',
  'would',
  'should',
  'must',
  'can',
  'could',
  'shall',
  'may',
  'might',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'go',
  'going',
  'want',
  'wants',
  'need',
  'needs',
  'say',
  'says',
  'said',
  'tell',
  'mean',
  'meaning',
  'know',
  'knowing',
  'think',
  'nothing',
  'something',
  'everything',
  'yes',
  'no',
]);

// Speech verbs in their bare first-person form ("I say…"). `keep`, `let`, `hold`, `think`, and
// `mean` are deliberately left out: they start real speech ("I let him go once.", "I think we
// wait."), so treating them as tags would drop it.
const FIRST_PERSON_TAG_VERBS =
  'say|add|reply|mutter|murmur|whisper|call|ask|answer|hiss|snap|shout|continue|grumble';

// The same verbs conjugated for `he`/`she`/`they`/a name. `ask`, `call`, and `answer` are left out
// here: "they ask/call/answer" reads as reported speech about a habit, not a tag on the quote
// ("They ask about the road every visit." is not attributing "the old road" to them).
const THIRD_PERSON_TAG_VERBS =
  'says|said|adds|added|replies|replied|mutters|muttered|murmurs|murmured|whispers|whispered|' +
  'hisses|hissed|snaps|snapped|shouts|shouted|continues|continued|grumbles|grumbled';

// Body-language verbs short enough that they can't carry reported speech. `step` and `lean` were
// removed: both take a direction word too easily mistaken for a real target ("I step up to the
// plate.", "I lean towards mercy.").
const AVERBS =
  'nod|shrug|sigh|grin|smile|frown|wince|exhale|swallow|glance|straighten|crouch|kneel';

// Only `nod` and `glance` may take a TARGET: the rest are too short a gesture to plausibly point
// somewhere. TARGET's own grammar (a pronoun, an article/possessive plus one lowercase noun, or a
// single capitalized name) is checked separately, in `isValidTarget` — see the note there on why.
const TARGET_VERBS = new Set(['nod', 'glance']);

// A participle clause: a comma, an optional adverb, then a real gerund, then a free-form tail.
// The tail's word count and word list are checked separately, in `isValidTail`, since neither is
// expressible as a fixed alternation.
const PARTICIPLE = `,\\s+(?:${ADVERB}\\s+)?(?:${GERUNDS})\\b(?<tail>[^,]*)`;

// A tag verb's tail: an optional "it", one optional adverb, then at most one participle clause.
const TAG_TAIL = `(?:\\s+it)?(?:\\s+${ADVERB})?(?:${PARTICIPLE})?$`;

const FIRST_PERSON_TAG_BODY = new RegExp(
  `^(?:${ADVERB}\\s+)?(?:${FIRST_PERSON_TAG_VERBS})${TAG_TAIL}`,
  'i'
);

// Identifies the action verb (and any pre-verb adverb) and hands back whatever follows, so the
// caller can pick the TARGET-aware or TARGET-less tail pattern based on which verb matched.
const ACTION_VERB_PREFIX = new RegExp(`^(?:${ADVERB}\\s+)?(?<verb>${AVERBS})\\b(?<rest>.*)$`, 'i');

function actionTailPattern(allowTarget: boolean): RegExp {
  const target = allowTarget
    ? `(?:\\s+(?:at|toward|towards|to)\\s+(?<target>\\S+(?:\\s+\\S+)?))?`
    : '';
  return new RegExp(`^(?:\\s+${ADVERB})?${target}(?:\\s+${ADVERB})?(?:${PARTICIPLE})?$`, 'i');
}

const ACTION_TAIL_WITH_TARGET = actionTailPattern(true);
const ACTION_TAIL_NO_TARGET = actionTailPattern(false);

const TARGET_PRONOUNS = new Set(['him', 'her', 'them', 'you', 'it']);
const TARGET_ARTICLES = new Set(['the', 'my', 'his', 'her', 'their']);

/** Whether a quoted span's kept text reads as a whole sentence: capitalized, sentence-punctuated. */
function isSentenceQuote(mask: Mask, range: Range): boolean {
  const text = mask.keptText(range.start, range.end);
  const letter = /\p{L}/u.exec(text)?.[0];
  if (!letter || !/\p{Lu}/u.test(letter)) return false;
  const lastChar = text.replace(/\s+$/, '').at(-1);
  return lastChar !== undefined && SENTENCE_END.test(lastChar);
}

/** Whether `clause` starts with a capital `I` followed by whitespace (checked outside any regex,
 * since `I` must stay uppercase even though the rest of the match is case-insensitive). */
function startsWithCapitalI(clause: string): string | null {
  if (!clause.startsWith('I') || !/^\s/.test(clause.slice(1))) return null;
  return clause.slice(1).trimStart();
}

/**
 * Whether a participle clause's captured tail is short enough (at most 8 words) and carries none
 * of `TAIL_STOPWORDS` — a subject, auxiliary, or speech verb there means the clause is reported
 * speech, not body language. `undefined` (no participle clause present) is trivially fine.
 */
function isValidTail(tail: string | undefined): boolean {
  if (tail === undefined) return true;
  const words = tail
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length <= 8 && words.every((word) => !TAIL_STOPWORDS.has(word.toLowerCase()));
}

/**
 * Whether a captured TARGET is a pronoun (case-insensitive), an article or possessive plus one
 * lowercase noun, or a single capitalized name not itself a stopword. The name check must be
 * case-sensitive — a lowercase word must never pass as a name — so it (and the noun's lowercase
 * check) run here, in plain JS, on the raw capture, rather than inside the case-insensitive regex
 * that found it. `undefined` (no TARGET present) is trivially fine.
 */
function isValidTarget(target: string | undefined): boolean {
  if (target === undefined) return true;
  const words = target.trim().split(/\s+/);
  if (words.length === 1) {
    const word = words[0]!;
    if (TARGET_PRONOUNS.has(word.toLowerCase())) return true;
    return /^[A-Z][a-z]+$/.test(word) && !TAIL_STOPWORDS.has(word.toLowerCase());
  }
  if (words.length === 2) {
    return TARGET_ARTICLES.has(words[0]!.toLowerCase()) && /^[a-z]+$/.test(words[1]!);
  }
  return false;
}

/** The anchored `TAG` pattern for `I`, e.g. `I say, drawing my blade and stepping between them.` */
function isFirstPersonTag(clause: string): boolean {
  const rest = startsWithCapitalI(clause);
  if (rest === null) return false;
  const match = FIRST_PERSON_TAG_BODY.exec(rest);
  return match !== null && isValidTail(match.groups?.tail);
}

/** The anchored `TAG` pattern for `he`/`she`/`they`/the speaker's own names, e.g. `she says.` */
function thirdPersonTagPattern(names: readonly string[]): RegExp {
  const subjects = ['he', 'she', 'they', ...names.map(escapeRegExp)].join('|');
  return new RegExp(
    `^(?:${subjects})\\s+(?:${ADVERB}\\s+)?(?:${THIRD_PERSON_TAG_VERBS})${TAG_TAIL}`,
    'i'
  );
}

function matchesThirdPersonTag(clause: string, pattern: RegExp): boolean {
  const match = pattern.exec(clause);
  return match !== null && isValidTail(match.groups?.tail);
}

/**
 * The anchored `ACTION` pattern for `I`, e.g. `I nod slowly.` or `I glance at Bram.`. TARGET is
 * tried only after `nod`/`glance`; every other action verb uses the TARGET-less tail.
 */
function isAction(clause: string): boolean {
  const rest = startsWithCapitalI(clause);
  if (rest === null) return false;
  const verbMatch = ACTION_VERB_PREFIX.exec(rest);
  if (!verbMatch?.groups) return false;
  const verb = verbMatch.groups.verb!.toLowerCase();
  const tailPattern = TARGET_VERBS.has(verb) ? ACTION_TAIL_WITH_TARGET : ACTION_TAIL_NO_TARGET;
  const tailMatch = tailPattern.exec(verbMatch.groups.rest!);
  if (!tailMatch?.groups) return false;
  return isValidTail(tailMatch.groups.tail) && isValidTarget(tailMatch.groups.target);
}

const HAS_WORDS = /[\p{L}\p{N}]/u;

/**
 * Splits `text` into clauses at `[.!?…]` followed by whitespace, at `;`, `:`, `—`, `–`, and at
 * newlines. Each clause is trimmed, with any trailing `.!?…` and whitespace stripped; clauses with
 * no letters or digits are dropped.
 */
function clausesOf(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…](?=\s)|[;:—–\n]/g)) {
    const sentenceEnd = /[.!?…]/.test(match[0]);
    const end = sentenceEnd ? match.index + 1 : match.index;
    clauses.push(text.slice(start, end));
    start = sentenceEnd ? end : match.index + match[0].length;
  }
  clauses.push(text.slice(start));
  return clauses
    .map((clause) =>
      clause
        .trim()
        .replace(/[.!?…]+$/, '')
        .trim()
    )
    .filter((clause) => HAS_WORDS.test(clause));
}

/**
 * Whether every clause of a gap's masked kept text is entirely covered by the closed TAG or
 * ACTION word lists — a heuristic, not a proof: a clause that happens to use only these words in
 * this shape is treated as a direction even when it isn't one, and any clause that uses even one
 * word outside them is kept as speech even when it is a direction.
 */
function isDirection(text: string, names: readonly string[]): boolean {
  const clauses = clausesOf(text);
  if (clauses.length === 0) return false;
  const thirdPersonTag = thirdPersonTagPattern(names);
  return clauses.every(
    (clause) =>
      isFirstPersonTag(clause) || matchesThirdPersonTag(clause, thirdPersonTag) || isAction(clause)
  );
}

/**
 * Whether the text should split under the direction rule: every quote span is closed and reads
 * as a whole sentence, the text outside the quotes has words, and every outside gap with words is
 * a direction (see `isDirection`).
 */
function directionSplit(
  mask: Mask,
  spans: readonly QuoteSpan[],
  outside: readonly Range[],
  names: readonly string[]
): boolean {
  if (spans.length === 0 || spans.some((span) => span.close === null)) return false;
  const quoted = spans.map((span) => ({ start: span.open + 1, end: span.close! }));
  if (!quoted.every((range) => isSentenceQuote(mask, range))) return false;
  if (!hasWords(mask, outside)) return false;
  return outside.every(
    (range) => !hasWords(mask, [range]) || isDirection(mask.keptText(range.start, range.end), names)
  );
}

/**
 * Splits a PC's or NPC's spoken text into lines. Splits when either holds: the text opens with a
 * quote, has words outside its quotes, and is mostly quoted (Kira's `"…" I keep my voice low… "…"`)
 * — this older path can still drop outside text that is itself speech when the quoted text is at
 * least half the line (see docs/status.md); or every quote span is closed and a whole sentence,
 * the outside text has words, and every clause of every outside gap is entirely a speech tag
 * (`I say, drawing my blade and stepping between them.`, `she says.`) or a first-person action
 * (`I nod slowly.`, `I glance at Bram.`) built from the closed word lists in `isDirection` —
 * `names` (the speaker's own names, for PCs) counts as a tag subject alongside `he`/`she`/`they`.
 * This is a rules heuristic, not a proof: it is tuned so a clause with any word outside the closed
 * lists (reported speech, an idiom, a second clause) is kept as speech rather than dropped, at the
 * cost of occasionally voicing a real direction whole when it happens to use only listed words in
 * an unrecognized shape. Otherwise the whole text is one line. Emphasis and every double quote
 * mark are removed either way.
 */
export function splitSpeech(raw: string, names: readonly string[] = []): SpeechSplit {
  const mask = new Mask(raw);
  removeEmphasis(mask);
  const spans = pairQuotes(mask, 0, raw.length);
  const opensWithQuote = spans.length > 0 && firstKeptIndex(mask) === spans[0]!.open;
  removeQuotes(mask);

  const quoted = spans.map((span) => ({ start: span.open + 1, end: span.close ?? raw.length }));
  const outside = gaps(raw.length, spans);
  const whole = mask.kept(0, raw.length);
  const quoteRule =
    opensWithQuote &&
    hasWords(mask, outside) &&
    countKept(mask, quoted) * 2 >= countKept(mask, [{ start: 0, end: raw.length }]);
  const split = quoteRule || directionSplit(mask, spans, outside, names);
  if (!split) {
    return { mask, lines: hasWords(mask, whole) ? [whole] : [], directions: [] };
  }

  const lines = quoted
    .map((range) => mask.kept(range.start, range.end))
    .filter((ranges) => hasWords(mask, ranges));
  const directions = outside
    .map((range) => trimRange(raw, range))
    .filter((range) => range.end > range.start && hasWords(mask, [range]));
  for (const range of directions) mask.remove(range.start, range.end);
  return { mask, lines, directions };
}

/** A declared action's text with emphasis and double quote marks removed. */
export function cleanAction(raw: string): { mask: Mask; ranges: Range[] } {
  const mask = new Mask(raw);
  removeEmphasis(mask);
  removeQuotes(mask);
  return { mask, ranges: mask.kept(0, raw.length) };
}
