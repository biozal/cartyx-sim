import { splitSentences } from './pc-control';

/** How a sentence must repeat before `cutRepeats` cuts it. */
export interface CutRepeatsOptions {
  /** Narration already spoken this beat; entries may hold several sentences. */
  narratedThisBeat: readonly string[];
  /** Public dialogue lines players spoke since the DM's last turn ended. */
  recentPlayerLines: readonly string[];
}

/** `cutRepeats`'s result: the surviving text, and the sentences cut from it. */
export interface CutRepeatsResult {
  /** The kept sentences joined with a single space, or '' when nothing is left. */
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

  const kept: { sentence: string; quotedBefore: boolean }[] = [];
  const removed: string[] = [];
  let quoted = false;
  for (const { sentence } of splitSentences(text)) {
    const quotedBefore = quoted;
    quoted = quoteStateAfter(sentence, quoted);
    // Matches repeatedSentences' 5-word floor, so a deliberate short refrain (e.g. "Silence.")
    // or a recurring NPC catchphrase is never cut for repeating a narration beat.
    const repeatsNarration = wordCount(sentence) >= 5 && narratedSentences.has(normalize(sentence));
    const repeatsPlayer = quotedSpans(sentence).some(
      (span) => wordCount(span) >= 4 && playerLines.some((line) => line.includes(normalize(span)))
    );
    if (repeatsNarration || repeatsPlayer) {
      removed.push(sentence);
    } else {
      kept.push({ sentence, quotedBefore });
    }
  }
  return { kept: rebalanceQuotes(kept, text, quoted), removed };
}

/** Whether a double quote is open after `sentence`, given whether one was open before it. */
function quoteStateAfter(sentence: string, quotedBefore: boolean): boolean {
  let quoted = quotedBefore;
  for (const char of sentence) {
    if (char === '"') quoted = !quoted;
    else if (char === '“') quoted = true;
    else if (char === '”') quoted = false;
  }
  return quoted;
}

/**
 * The kept sentences joined with single spaces, with a quote mark added wherever a cut sentence
 * held the one that opened or closed the quote a kept sentence sits in, so the speech that is left
 * stays inside quotes ("But he's right. That place is quiet. And the sheep…" losing its first and
 * last sentences keeps `"That place is quiet."`, not a bare line that reads as narration).
 * Curly marks are used when the narration has any. A narration whose own quotes never closed is
 * not closed here.
 */
function rebalanceQuotes(
  kept: readonly { sentence: string; quotedBefore: boolean }[],
  text: string,
  quotedAtEnd: boolean
): string {
  const curly = /[“”]/.test(text);
  const open = curly ? '“' : '"';
  const close = curly ? '”' : '"';
  const out: string[] = [];
  let quoted = false;
  for (const { sentence, quotedBefore } of kept) {
    if (quoted && !quotedBefore && out.length > 0) out[out.length - 1] += close;
    out.push(!quoted && quotedBefore ? open + sentence : sentence);
    quoted = quoteStateAfter(sentence, quotedBefore);
  }
  if (quoted && !quotedAtEnd && out.length > 0) out[out.length - 1] += close;
  return out.join(' ');
}
