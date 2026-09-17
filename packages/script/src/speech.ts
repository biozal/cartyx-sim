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

// A closed list of manner adverbs, used everywhere a `\w+ly` slot would over-match real words that
// happen to end in "ly" ("early", "only", "family"). `ADVERBS` is the set the token grammar checks
// membership against; `ADVERB_RE` is the same list pre-wrapped in its own group, for the two verb-
// prefix regexes below — embedding a bare alternation next to another atom (`${ADVERB_RE}\s+`)
// without that wrapping would let `|`'s low precedence leak the alternation past where it should end.
const ADVERB_WORDS = [
  'quietly',
  'softly',
  'slowly',
  'firmly',
  'sharply',
  'calmly',
  'grimly',
  'flatly',
  'dryly',
  'coldly',
  'gently',
  'lowly',
  'finally',
  'quickly',
  'again',
  'barely',
  'carefully',
  'evenly',
  'tightly',
  'warmly',
  'wearily',
];
const ADVERBS = new Set(ADVERB_WORDS);
const ADVERB_RE = `(?:${ADVERB_WORDS.join('|')})`;

// A closed list of gerunds a participle clause can open with ("I nod, glancing at the door.").
// Words that merely end in "ing" but aren't on this list ("morning", "burning", "knowing",
// "meaning") do not start a participle clause.
const GERUND_WORDS = [
  'drawing',
  'stepping',
  'pointing',
  'glancing',
  'nodding',
  'looking',
  'turning',
  'leaning',
  'gesturing',
  'shrugging',
  'smiling',
  'grinning',
  'frowning',
  'sighing',
  'raising',
  'lowering',
  'backing',
  'keeping',
  'reaching',
  'gripping',
  'tightening',
  'crossing',
  'shaking',
  'tilting',
  'narrowing',
  'moving',
  'watching',
  'holding',
  'resting',
  'straightening',
  'crouching',
  'kneeling',
];
const GERUNDS = new Set(GERUND_WORDS);

// A whole word that, if it fills a NOUN_SLOT or NAME_SLOT (see the token grammar below), means
// that slot is carrying a subject, auxiliary, or speech verb rather than a plain noun or a name —
// so the clause is reported speech, not body language, even though it opened with a real gerund.
const STOPWORDS = new Set([
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
// somewhere.
const TARGET_VERBS = new Set(['nod', 'glance']);

// TARGET's own preposition list is narrower than a participle's general PREP (below): only these
// four introduce a TARGET.
const TARGET_PREPS = new Set(['at', 'toward', 'towards', 'to']);

// PRONOUN, DET, PREP, and PARTICLE: the closed word lists the token grammar draws OBJECT and
// GERUND_PHRASE from (see `OBJECT` and `GERUND_PHRASE`). The only two slots below that accept a
// word not on a fixed list are `nounSlot` (one lowercase word after a DET) and `NAME_SLOT` (one
// capitalized name); both reject a stopword. Every other word in a direction clause must come from
// one of these lists or `ADVERB_WORDS`/`GERUND_WORDS` above. `BARE_PRONOUNS` and `POSSESSIVE_DETS`
// are the narrower lists allowed for an object with no preposition before it.
const PRONOUNS = new Set(['him', 'her', 'them', 'you', 'it', 'me', 'us']);
const BARE_PRONOUNS = new Set(['him', 'her', 'them', 'it', 'me', 'us']);
const DETS = new Set(['the', 'my', 'his', 'her', 'their', 'a', 'an', 'our', 'your']);
const POSSESSIVE_DETS = new Set(['my', 'his', 'her', 'their', 'our']);
const PREPS = new Set([
  'at',
  'toward',
  'towards',
  'to',
  'between',
  'from',
  'over',
  'through',
  'past',
  'behind',
  'into',
  'in',
  'on',
]);
const PARTICLES = new Set(['back', 'away', 'forward', 'still', 'down', 'up', 'out', 'in', 'aside']);

const ACTION_VERB_PREFIX = new RegExp(
  `^(?:${ADVERB_RE}\\s+)?(?<verb>${AVERBS})\\b(?<rest>.*)$`,
  'i'
);

const FIRST_PERSON_TAG_PREFIX = new RegExp(
  `^(?:${ADVERB_RE}\\s+)?(?:${FIRST_PERSON_TAG_VERBS})\\b(?<rest>.*)$`,
  'i'
);

const APOSTROPHES = /[’‘ʼ]/g;

/** Curly apostrophes (`’‘ʼ`) read as `'`, so a stopword check never misses one because of style. */
function normalizeApostrophes(text: string): string {
  return text.replace(APOSTROPHES, "'");
}

/** Splits `text` on whitespace, keeping each comma (even one glued to a word) as its own token. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of normalizeApostrophes(text).trim().split(/\s+/)) {
    let word = '';
    for (const char of chunk) {
      if (char !== ',') {
        word += char;
        continue;
      }
      if (word) tokens.push(word);
      word = '';
      tokens.push(',');
    }
    if (word) tokens.push(word);
  }
  return tokens;
}

// The token grammar is a handful of parsers, each returning every position where it can end when
// started at `pos` (empty = no match). Keeping every possible end is what backtracking needs: "her"
// can open a NOUN_SLOT ("her sword") or be a PRONOUN, and a clause parses only if some choice
// reaches its last token.
type Parser = (tokens: readonly string[], pos: number) => number[];

const unique = (ends: readonly number[]): number[] => [...new Set(ends)];

/** One token from `words` (case-insensitive). */
const word =
  (words: ReadonlySet<string>): Parser =>
  (tokens, pos) => {
    const token = tokens[pos];
    return token !== undefined && words.has(token.toLowerCase()) ? [pos + 1] : [];
  };

/** One token that passes `test`. */
const token =
  (test: (value: string) => boolean): Parser =>
  (tokens, pos) => {
    const value = tokens[pos];
    return value !== undefined && test(value) ? [pos + 1] : [];
  };

const seq =
  (...parsers: Parser[]): Parser =>
  (tokens, pos) =>
    parsers.reduce<number[]>(
      (ends, parser) => unique(ends.flatMap((end) => parser(tokens, end))),
      [pos]
    );

const alt =
  (...parsers: Parser[]): Parser =>
  (tokens, pos) =>
    unique(parsers.flatMap((parser) => parser(tokens, pos)));

const opt = (parser: Parser): Parser => alt(parser, (_, pos) => [pos]);

/** Whether `parser` can consume every token. */
function parsesAll(parser: Parser, tokens: readonly string[]): boolean {
  return parser(tokens, 0).includes(tokens.length);
}

const ADVERB = word(ADVERBS);
const GERUND = word(GERUNDS);
const PARTICLE = word(PARTICLES);
const PREP = word(PREPS);

/** NOUN_SLOT = a determiner from `dets` plus exactly one lowercase word that is not a stopword. */
const nounSlot = (dets: ReadonlySet<string>): Parser =>
  seq(
    word(dets),
    token((noun) => /^[a-z]+$/.test(noun) && !STOPWORDS.has(noun))
  );

/**
 * NAME_SLOT = a single `[A-Z][a-z]+` token that is not (case-insensitively) a stopword. Matched
 * case-sensitively on purpose: a lowercase word must never pass as a name.
 */
const NAME_SLOT = token((name) => /^[A-Z][a-z]+$/.test(name) && !STOPWORDS.has(name.toLowerCase()));

/** OBJECT after a preposition = `NOUN_SLOT` (any DET) | `PRONOUN` | `NAME_SLOT`. */
const OBJECT = alt(nounSlot(DETS), word(PRONOUNS), NAME_SLOT);

/**
 * BARE_OBJECT, directly after a gerund with no preposition = a possessive `NOUN_SLOT` ("drawing my
 * blade") | `him`/`her`/`them`/`it`/`me`/`us`. No name, no `you`, and no `the`/`a`/`an`/`your`:
 * those read too easily as the start of speech ("keeping the peace", "looking back You").
 */
const BARE_OBJECT = alt(nounSlot(POSSESSIVE_DETS), word(BARE_PRONOUNS));

const PREP_OBJECT = seq(PREP, OBJECT);

/**
 * GERUND_PHRASE = `(ADVERB)? GERUND (PARTICLE (PREP OBJECT)? | PREP OBJECT | BARE_OBJECT)?
 * (ADVERB)?`. After a particle an object needs its preposition ("stepping back toward Bram").
 */
const GERUND_PHRASE = seq(
  opt(ADVERB),
  GERUND,
  opt(alt(seq(PARTICLE, opt(PREP_OBJECT)), PREP_OBJECT, BARE_OBJECT)),
  opt(ADVERB)
);

/** PARTICIPLE = `, GERUND_PHRASE (and GERUND_PHRASE)?`; the callers require it to end the clause. */
const PARTICIPLE = seq(
  word(new Set([','])),
  GERUND_PHRASE,
  opt(seq(word(new Set(['and'])), GERUND_PHRASE))
);

/** A TAG's tail after its verb: `(it)? (ADVERB)? (PARTICIPLE)?`. */
const TAG_TAIL = seq(opt(word(new Set(['it']))), opt(ADVERB), opt(PARTICIPLE));

/** TARGET (only after `nod`/`glance`) = `at`/`toward`/`towards`/`to` plus one OBJECT. */
const TARGET = seq(word(TARGET_PREPS), OBJECT);

/** An ACTION's tail after its verb: `(ADVERB)? (TARGET)? (ADVERB)? (PARTICIPLE)?`. */
const actionTail = (target: boolean): Parser =>
  seq(opt(ADVERB), ...(target ? [opt(TARGET)] : []), opt(ADVERB), opt(PARTICIPLE));
const ACTION_TAIL_WITH_TARGET = actionTail(true);
const ACTION_TAIL = actionTail(false);

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
 * Matches a TAG's tail — `(?:\s+it)?(?:\s+ADVERB)?(?:PARTICIPLE)?` — against whatever follows the
 * verb: an optional "it", one optional adverb, then at most one participle clause, ending the
 * clause. Nothing else may remain.
 */
function matchTagTail(rest: string): boolean {
  return parsesAll(TAG_TAIL, tokenize(rest));
}

/** The `TAG` pattern for `I`, e.g. `I say, drawing my blade and stepping between them.` */
function isFirstPersonTag(clause: string): boolean {
  const afterI = startsWithCapitalI(clause);
  if (afterI === null) return false;
  const match = FIRST_PERSON_TAG_PREFIX.exec(afterI);
  return match?.groups !== undefined && matchTagTail(match.groups.rest!);
}

/** The `TAG` pattern for `he`/`she`/`they`/the speaker's own names, e.g. `she says.` */
function thirdPersonTagPattern(names: readonly string[]): RegExp {
  const subjects = ['he', 'she', 'they', ...names.map(escapeRegExp)].join('|');
  return new RegExp(
    `^(?:${subjects})\\s+(?:${ADVERB_RE}\\s+)?(?:${THIRD_PERSON_TAG_VERBS})\\b(?<rest>.*)$`,
    'i'
  );
}

function matchesThirdPersonTag(clause: string, pattern: RegExp): boolean {
  const match = pattern.exec(clause);
  return match?.groups !== undefined && matchTagTail(match.groups.rest!);
}

/**
 * The `ACTION` pattern for `I`, e.g. `I nod slowly.` or `I glance at Bram.`: `(ADVERB)? AVERB
 * (ADVERB)? (TARGET)? (ADVERB)? (PARTICIPLE)?`. TARGET is tried only after `nod`/`glance`, and is
 * parsed with the after-a-preposition `OBJECT` grammar, so a trailing adverb is never
 * swallowed into it (`I glance at Bram quietly.` — "quietly" is the trailing `ADVERB`, not part of
 * the target).
 */
function isAction(clause: string): boolean {
  const afterI = startsWithCapitalI(clause);
  if (afterI === null) return false;
  const verbMatch = ACTION_VERB_PREFIX.exec(afterI);
  if (!verbMatch?.groups) return false;
  const tail = TARGET_VERBS.has(verbMatch.groups.verb!.toLowerCase())
    ? ACTION_TAIL_WITH_TARGET
    : ACTION_TAIL;
  return parsesAll(tail, tokenize(verbMatch.groups.rest!));
}

const HAS_WORDS = /[\p{L}\p{N}]/u;

interface Clause {
  /** The clause, trimmed, with its trailing `.!?…` stripped. */
  text: string;
  /** Whether the stripped trailing punctuation held a `?`. */
  question: boolean;
}

/**
 * Splits `text` into clauses at `[.!?…]` followed by whitespace, at `;`, `:`, `—`, `–`, and at
 * newlines. Each clause is trimmed, with any trailing `.!?…` and whitespace stripped (noting
 * whether that punctuation was a question); clauses with no letters or digits are dropped.
 */
function clausesOf(text: string): Clause[] {
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
    .map((clause) => {
      const trimmed = clause.trim();
      const ending = /[.!?…]*$/.exec(trimmed)![0];
      return {
        text: trimmed.slice(0, trimmed.length - ending.length).trim(),
        question: ending.includes('?'),
      };
    })
    .filter((clause) => HAS_WORDS.test(clause.text));
}

/**
 * Whether every clause of a gap's masked kept text parses completely as a TAG or ACTION under the
 * fixed grammar above. A clause ending in `?` is never a direction. The only slots that accept
 * anything other than a listed word are `nounSlot` (one lowercase word after a determiner) and
 * `NAME_SLOT` (one capitalized name, only after a preposition) — and neither accepts a stopword.
 * This is a heuristic, not a proof, with two costs: a real direction that doesn't parse is voiced
 * whole, and speech that happens to parse is dropped. The grammar is kept narrow to make the second
 * case unlikely.
 */
function isDirection(text: string, names: readonly string[]): boolean {
  const clauses = clausesOf(text);
  if (clauses.length === 0) return false;
  const thirdPersonTag = thirdPersonTagPattern(names);
  return clauses.every(
    ({ text: clause, question }) =>
      !question &&
      (isFirstPersonTag(clause) ||
        matchesThirdPersonTag(clause, thirdPersonTag) ||
        isAction(clause))
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
 * the outside text has words, and every clause of every outside gap parses completely as a speech
 * tag (`I say, drawing my blade and stepping between them.`, `she says.`) or a first-person action
 * (`I nod slowly.`, `I glance at Bram.`) under the fixed grammar in `isDirection` — `names` (the
 * speaker's own names, for PCs) counts as a tag subject alongside `he`/`she`/`they`. A clause is
 * dropped only when it parses completely under that grammar and doesn't end in `?`; its only open
 * slots are one lowercase noun after a determiner and one capitalized name after a preposition,
 * neither of which may be a stopword. This is a rules heuristic, not a proof: a real direction that
 * doesn't parse is voiced whole, and speech that happens to parse is dropped — the grammar is kept
 * narrow to make that second case unlikely. Otherwise the whole text is one line. Emphasis and every
 * double quote mark are removed either way.
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
