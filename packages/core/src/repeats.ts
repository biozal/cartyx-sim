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

/** A sentence of `text` repeats when it was already narrated this beat, or quotes a player's recent line. */
export function cutRepeats(text: string, options: CutRepeatsOptions): CutRepeatsResult {
  const narratedSentences = new Set(
    options.narratedThisBeat.flatMap((entry) =>
      splitSentences(entry).map(({ sentence }) => normalize(sentence))
    )
  );
  const playerLines = options.recentPlayerLines.map((line) => normalize(line));

  const kept: string[] = [];
  const removed: string[] = [];
  for (const { sentence } of splitSentences(text)) {
    const repeatsNarration = narratedSentences.has(normalize(sentence));
    const repeatsPlayer = quotedSpans(sentence).some(
      (span) => wordCount(span) >= 4 && playerLines.some((line) => line.includes(normalize(span)))
    );
    if (repeatsNarration || repeatsPlayer) {
      removed.push(sentence);
    } else {
      kept.push(sentence);
    }
  }
  return { kept: kept.join(' '), removed };
}
