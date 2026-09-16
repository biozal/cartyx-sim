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

const TAG_VERBS =
  'say|says|said|add|adds|added|reply|replies|replied|mutter|mutters|muttered|murmur|murmurs|' +
  'murmured|whisper|whispers|whispered|call|calls|called|ask|asks|asked|answer|answers|answered|' +
  'hiss|hisses|hissed|snap|snaps|snapped|shout|shouts|shouted|continue|continues|continued|' +
  'grumble|grumbles|grumbled';

// `keep`, `let`, `hold`, `think`, and `mean` are deliberately left out: they start real speech
// ("I let him go once.", "I think we wait."), so treating them as tags or actions would drop it.
const ACTION_VERBS =
  'nod|shrug|glance|step|draw|lean|turn|look|grin|smile|sigh|frown|raise|lower|gesture|point|tap|' +
  'cross|narrow|crouch|kneel|straighten|wince|exhale|swallow';

const ACTION_VERB = new RegExp(`^(?:\\w+ly\\s+)?(?:${ACTION_VERBS})\\b`, 'i');

/** Whether a quoted span's kept text reads as a whole sentence: capitalized, sentence-punctuated. */
function isSentenceQuote(mask: Mask, range: Range): boolean {
  const text = mask.keptText(range.start, range.end);
  const letter = /\p{L}/u.exec(text)?.[0];
  if (!letter || !/\p{Lu}/u.test(letter)) return false;
  const lastChar = text.replace(/\s+$/, '').at(-1);
  return lastChar !== undefined && SENTENCE_END.test(lastChar);
}

/** The `TAG` pattern: `I`/`he`/`she`/`they`/the speaker's own names, then a speech verb. */
function tagPattern(names: readonly string[]): RegExp {
  const subjects = ['I', 'he', 'she', 'they', ...names.map(escapeRegExp)].join('|');
  return new RegExp(`^(?:${subjects})\\s+(?:\\w+ly\\s+)?(?:${TAG_VERBS})\\b`, 'i');
}

/** The `ACTION` pattern: a capital `I` (checked separately) followed by a first-person verb. */
function isAction(sentence: string): boolean {
  if (!sentence.startsWith('I') || !/^\s/.test(sentence.slice(1))) return false;
  return ACTION_VERB.test(sentence.slice(1).trimStart());
}

/** Splits `text` into sentences at `[.!?…]` followed by whitespace, trimmed, empty ones dropped. */
function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…](?=\s)/g)) {
    const end = match.index + 1;
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/** Whether every sentence of a gap's masked kept text is a speech tag or a first-person action. */
function isDirection(text: string, names: readonly string[]): boolean {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return false;
  const tag = tagPattern(names);
  return sentences.every((sentence) => tag.test(sentence) || isAction(sentence));
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
 * or every quote span is closed and a whole sentence, the outside text has words, and every outside
 * gap is a speech tag or a first-person action (`I nod slowly. "Let's go."`, `"Hello," she says.`) —
 * `names` (the speaker's own names, for PCs) counts as a tag subject alongside `I`/`he`/`she`/`they`.
 * Otherwise the whole text is one line. Emphasis and every double quote mark are removed either way.
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
