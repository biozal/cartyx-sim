import { splitSentences } from './pc-control';
import { joinKeptSentences, type SentencePart } from './text';

/** How a sentence must repeat before `cutRepeats` cuts it. */
export interface CutRepeatsOptions {
  /** Narration already spoken this beat; entries may hold several sentences. */
  narratedThisBeat: readonly string[];
  /** Public dialogue lines players spoke since the DM's last turn ended. */
  recentPlayerLines: readonly string[];
}

/** `cutRepeats`'s result: the surviving text, and the sentences cut from it. */
export interface CutRepeatsResult {
  /**
   * The kept sentences joined with a single space, with quote marks a cut took added back (see
   * `joinKeptSentences`), or '' when nothing is left.
   */
  kept: string;
  removed: string[];
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Lowercased, whitespace-collapsed, with quote marks, emphasis markers, and edge punctuation gone. */
function normalize(text: string): string {
  return text
    .replace(/["“”„]/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,;:!?]+|[.,;:!?]+$/g, '')
    .trim()
    .toLowerCase();
}

function wordCount(text: string): number {
  return (text.match(WORD) ?? []).length;
}

/** Spans between a straight or curly pair of double quotes, in order of appearance. */
const QUOTED_SPAN = /"([^"]*)"|“([^”]*)”/g;

function quotedSpans(sentence: string): string[] {
  return [...sentence.matchAll(QUOTED_SPAN)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((span) => span.trim().length > 0);
}

/**
 * The sentences of `text` this speaker has already said, normalized the same way `cutRepeats`
 * does. A sentence counts as a repeat only on an exact normalized match, and only when it has 5
 * or more words, so short lines like "Agreed." never count.
 */
export function repeatedSentences(text: string, earlierLines: readonly string[]): string[] {
  const alreadySaid = new Set(
    earlierLines.flatMap((line) => splitSentences(line).map(({ sentence }) => normalize(sentence)))
  );
  return splitSentences(text)
    .map(({ sentence }) => sentence)
    .filter((sentence) => wordCount(sentence) >= 5 && alreadySaid.has(normalize(sentence)));
}

/** A sentence of `text` repeats when it was already narrated this beat, or quotes a player's recent line. */
export function cutRepeats(text: string, options: CutRepeatsOptions): CutRepeatsResult {
  const narratedSentences = new Set(
    options.narratedThisBeat.flatMap((entry) =>
      splitSentences(entry).map(({ sentence }) => normalize(sentence))
    )
  );
  const playerLines = options.recentPlayerLines.map((line) => normalize(line));

  const parts: SentencePart[] = [];
  const removed: string[] = [];
  for (const { sentence } of splitSentences(text)) {
    // Matches repeatedSentences' 5-word floor, so a deliberate short refrain (e.g. "Silence.")
    // or a recurring NPC catchphrase is never cut for repeating a narration beat.
    const repeatsNarration = wordCount(sentence) >= 5 && narratedSentences.has(normalize(sentence));
    const repeatsPlayer = quotedSpans(sentence).some(
      (span) => wordCount(span) >= 4 && playerLines.some((line) => line.includes(normalize(span)))
    );
    const keep = !(repeatsNarration || repeatsPlayer);
    if (!keep) removed.push(sentence);
    parts.push({ sentence, separator: ' ', keep });
  }
  return { kept: joinKeptSentences(parts), removed };
}

// Short, common words that say nothing about what a narration describes.
const FILLER = new Set(
  (
    'that this with from into their there they them then than your have been were what when ' +
    'where which while about over under after before again also just only very more most some ' +
    'such each other these those will would could should upon onto like even still back down ' +
    'toward towards across through around against between within without behind beneath along ' +
    'among whose'
  ).split(' ')
);

/** The distinct content words of `text`: four or more letters, lowercased, filler dropped. */
function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}'’]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 4 && !FILLER.has(word)));
}

/** How many content words a narration needs before `retellsNarration` judges it. */
const RETELL_MIN_WORDS = 5;
/** The share of a narration's content words already narrated this turn that makes it a retelling. */
const RETELL_SHARE = 0.6;

/**
 * Whether `text` retells narration the DM already gave this turn: 60% or more of its content
 * words (at least 5 of them) already appear there. Catches the paraphrase loop exact-sentence
 * repeats miss, where the DM describes one moment again and again in new words (session 010 told
 * Kira counting "One... two... three!" seven times in one turn; session 007 told one miss seven
 * ways). Replaying sessions 005–010 at this share flags only retellings.
 */
export function retellsNarration(text: string, earlier: readonly string[]): boolean {
  const words = contentWords(text);
  if (words.size < RETELL_MIN_WORDS || earlier.length === 0) return false;
  const told = contentWords(earlier.join(' '));
  let shared = 0;
  for (const word of words) if (told.has(word)) shared++;
  return shared / words.size >= RETELL_SHARE;
}
