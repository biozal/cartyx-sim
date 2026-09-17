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

// First-person action verbs only: body language short enough that it can't carry reported speech.
// `look`, `raise`, `lower`, `point`, `cross`, `turn`, `draw`, `gesture`, `tap`, and `narrow` were
// removed because each starts an idiom ("I look forward to…", "I raise you ten gold.", "I draw
// the line at…") that isn't a stage direction.
const ACTION_VERBS =
  'nod|shrug|glance|sigh|grin|smile|frown|wince|exhale|swallow|straighten|crouch|kneel|lean|step';

// A short prepositional/adverbial tail an action verb can take ("step back", "glance at Bram"),
// capped at 3 extra words so a clause that runs on into reported speech doesn't match.
const ACTION_PREPOSITIONS =
  'at|toward|towards|to|back|forward|closer|away|down|up|in|over|aside|once|twice|again';

// Any number of comma-joined gerund clauses ("I say, drawing my blade and stepping between
// them."), anchored to the end of the clause. Shared by the TAG and ACTION tails below.
const GERUND_TAIL = '(?:,\\s+(?:\\w+ly\\s+)?\\w+ing\\b[^,]*)*$';

// A tag verb's tail: an optional "it", one optional adverb, then the gerund tail. Nothing else may
// follow.
const TAG_TAIL = `(?:\\s+it)?(?:\\s+\\w+ly)?${GERUND_TAIL}`;

const FIRST_PERSON_TAG_BODY = new RegExp(
  `^(?:\\w+ly\\s+)?(?:${FIRST_PERSON_TAG_VERBS})${TAG_TAIL}`,
  'i'
);

const ACTION_BODY = new RegExp(
  `^(?:\\w+ly\\s+)?(?:${ACTION_VERBS})(?:\\s+\\w+ly)?` +
    `(?:\\s+(?:${ACTION_PREPOSITIONS})(?:\\s+[\\w'’]+){0,3})?(?:\\s+\\w+ly)?${GERUND_TAIL}`,
  'i'
);

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

/** The anchored `TAG` pattern for `I`, e.g. `I say, drawing my blade and stepping between them.` */
function isFirstPersonTag(clause: string): boolean {
  const rest = startsWithCapitalI(clause);
  return rest !== null && FIRST_PERSON_TAG_BODY.test(rest);
}

/** The anchored `TAG` pattern for `he`/`she`/`they`/the speaker's own names, e.g. `she says.` */
function thirdPersonTagPattern(names: readonly string[]): RegExp {
  const subjects = ['he', 'she', 'they', ...names.map(escapeRegExp)].join('|');
  return new RegExp(
    `^(?:${subjects})\\s+(?:\\w+ly\\s+)?(?:${THIRD_PERSON_TAG_VERBS})${TAG_TAIL}`,
    'i'
  );
}

/** The anchored `ACTION` pattern for `I`, e.g. `I nod slowly.` or `I step back slowly.` */
function isAction(clause: string): boolean {
  const rest = startsWithCapitalI(clause);
  return rest !== null && ACTION_BODY.test(rest);
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

/** Whether every clause of a gap's masked kept text is a speech tag or a first-person action. */
function isDirection(text: string, names: readonly string[]): boolean {
  const clauses = clausesOf(text);
  if (clauses.length === 0) return false;
  const thirdPersonTag = thirdPersonTagPattern(names);
  return clauses.every(
    (clause) => isFirstPersonTag(clause) || thirdPersonTag.test(clause) || isAction(clause)
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
 * quote, has words outside its quotes, and is mostly quoted (Kira's `"…" I keep my voice low… "…"`);
 * or every quote span is closed and a whole sentence, the outside text has words, and every clause
 * of every outside gap, anchored end to end, is entirely a speech tag (`I say, drawing my blade
 * and stepping between them.`, `she says.`) or a first-person action (`I nod slowly.`, `I step
 * back slowly.`) — `names` (the speaker's own names, for PCs) counts as a tag subject alongside
 * `he`/`she`/`they`. A clause that runs on into anything else, including reported speech or an
 * idiom ("I look forward to it.", "I raise you ten gold."), is not a direction, so the whole gap
 * (and the text) is kept whole rather than dropping part of it. Otherwise the whole text is one
 * line. Emphasis and every double quote mark are removed either way.
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
