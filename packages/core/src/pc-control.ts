import { z } from 'zod';
import type { SimEvent } from './events';
import { ownEntry, type GameState } from './state';

/** A sentence the checker says plays a player character, with the character and the reason. */
export const PcControlFinding = z.object({
  pc: z.string().min(1),
  sentence: z.string().min(1),
  why: z.string().default(''),
});
export type PcControlFinding = z.output<typeof PcControlFinding>;

const CheckerReply = z.object({ violations: z.array(PcControlFinding) });

function nameOf(id: string, state: GameState): string {
  return ownEntry(state.combatants, id)?.name ?? id;
}

/**
 * What the player characters said, declared, or passed on since the DM's most recent turn ended,
 * as lines for the checker prompt ("Kira Vale says: …", "Kira Vale attempts: …").
 */
export function declarationsSinceDm(history: readonly SimEvent[], state: GameState): string[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === 'turn_end' && event.actor === 'dm') {
      start = index + 1;
      break;
    }
  }
  const party = new Set(state.partyIds);
  const lines: string[] = [];
  for (const event of history.slice(start)) {
    if (event.type === 'dialogue' && event.speakerKind === 'pc') {
      lines.push(`${nameOf(event.speaker, state)} says: "${event.text}"`);
    } else if (event.type === 'action' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} attempts: ${event.intent}`);
    } else if (event.type === 'pass' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} holds back.`);
    }
  }
  return lines;
}

/** Closed thinking blocks some models leak into their reply; they may hold braces of their own. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

// A brace-heavy reply can offer thousands of "{"..."}" candidates; each JSON.parse attempt is
// cheap on its own, but trying every one is not (a probe of two nested 10,000-character brace
// runs took ~2s with no cap). The search gives up once it has made this many parse attempts, so a
// degenerate reply is read as unreadable quickly instead of exhaustively.
const MAX_PARSE_ATTEMPTS = 2000;

// Caps the total characters handed to JSON.parse across all attempts, since each attempt alone can
// be as long as the whole reply.
const MAX_PARSE_CHARS = 20_000_000;

const WHITESPACE = /\s/;

/** The index of the first non-whitespace character in `text` at or after `from`. */
function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.test(text[at]!)) at++;
  return at;
}

/**
 * Whether a "{" at `start` in `reply` could possibly open valid JSON: skipping whitespace, the
 * next character is a `"` (an object with a key) or a `}` (an object that closes at once). This
 * depends only on `start`, never on which "}" would end the candidate, so it is decided once per
 * start and a start that fails it is skipped entirely — no `}` end is ever tried against it.
 */
function canOpenJsonObject(reply: string, start: number): boolean {
  const char = reply[skipWhitespace(reply, start + 1)];
  return char === '"' || char === '}';
}

/** The findings in one JSON candidate, or null when it is not valid JSON of the reply's shape. */
function readCandidate(candidate: string): PcControlFinding[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return null;
  }
  const parsed = CheckerReply.safeParse(raw);
  return parsed.success ? parsed.data.violations : null;
}

/**
 * The checker's findings, or null when its reply holds no readable `{ "violations": [...] }`
 * object. Closed `<think>` blocks are ignored first. Then each "{" is tried, in order, against
 * each later "}" from last to first, so code fences, surrounding text, stray braces, and a second
 * object are all fine, and the first (leftmost, then widest) candidate that parses as JSON of the
 * reply's shape wins. A start that could not possibly open JSON is skipped without trying any "}"
 * against it at all, and at most `MAX_PARSE_ATTEMPTS` candidates, totaling at most
 * `MAX_PARSE_CHARS` characters parsed, are ever tried, so a degenerate brace-heavy reply returns
 * null quickly instead of trying every pair.
 */
export function parseCheckerReply(text: string): PcControlFinding[] | null {
  const reply = text.replace(THINK_BLOCK, '');
  const closeBraces: number[] = [];
  for (let end = reply.indexOf('}'); end !== -1; end = reply.indexOf('}', end + 1)) {
    closeBraces.push(end);
  }
  let attempts = 0;
  let charsParsed = 0;
  for (let start = reply.indexOf('{'); start !== -1; start = reply.indexOf('{', start + 1)) {
    if (!canOpenJsonObject(reply, start)) continue;
    for (let i = closeBraces.length - 1; i >= 0; i--) {
      const end = closeBraces[i]!;
      if (end <= start) break; // closeBraces is ascending, so nothing before this is > start either
      if (attempts >= MAX_PARSE_ATTEMPTS) return null;
      const length = end + 1 - start;
      if (charsParsed + length > MAX_PARSE_CHARS) return null;
      attempts++;
      charsParsed += length;
      const found = readCandidate(reply.slice(start, end + 1));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Lowercased, with whitespace collapsed, curly quotes and apostrophes made straight, "…" written
 * as "...", and em and en dashes written as " - ".
 */
function normalize(text: string): string {
  return text
    .replace(/["“”„]/g, '"')
    .replace(/['‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[—–]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalized text without the quote marks around it, for matching one piece inside another. */
function matchText(text: string): string {
  return normalize(text)
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/** A sentence and the original whitespace that followed it, before the next sentence (or ''). */
interface SplitSentence {
  sentence: string;
  separator: string;
}

/**
 * Splits a paragraph after sentence-ending punctuation and any closing quotes or brackets,
 * keeping the original separator (a space, a newline, several newlines, …) that followed each
 * sentence, so a caller that rejoins sentences can reproduce the original line breaks instead of
 * always using a single space.
 */
function splitSentences(paragraph: string): SplitSentence[] {
  const parts = paragraph.split(/(?<=[.!?…]["“”‘’')\]]*)(\s+)/);
  const result: SplitSentence[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i]!.trim();
    if (sentence.length === 0) continue;
    result.push({ sentence, separator: parts[i + 1] ?? '' });
  }
  return result;
}

/** A narration sentence and where its normalized text sits in the normalized narration. */
interface SentenceSpan {
  paragraph: number;
  sentence: string;
  /** The original whitespace that followed this sentence in the narration, or '' when none did. */
  separator: string;
  start: number;
  end: number;
  /** The span without the sentence's leading and trailing quote marks. */
  coreStart: number;
  coreEnd: number;
}

/** The normalized narration, built sentence by sentence so every offset agrees with the split. */
interface NarrationLayout {
  haystack: string;
  paragraphCount: number;
  sentences: SentenceSpan[];
}

function layOut(narration: string): NarrationLayout {
  const paragraphs = narration.split(/\n\s*\n/);
  const sentences: SentenceSpan[] = [];
  let haystack = '';
  paragraphs.forEach((paragraph, index) => {
    for (const { sentence, separator } of splitSentences(paragraph)) {
      const text = normalize(sentence);
      if (haystack.length > 0) haystack += ' ';
      const start = haystack.length;
      haystack += text;
      const leading = /^["']*/.exec(text)![0].length;
      const trailing = /["']*$/.exec(text.slice(leading))![0].length;
      sentences.push({
        paragraph: index,
        sentence,
        separator,
        start,
        end: haystack.length,
        coreStart: start + leading,
        coreEnd: haystack.length - trailing,
      });
    }
  });
  return { haystack, paragraphCount: paragraphs.length, sentences };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/** Start offsets where `text` occurs in `haystack` without starting or ending inside a word. */
function occurrences(haystack: string, text: string): number[] {
  const first = [...text][0];
  const last = [...text].at(-1);
  const starts: number[] = [];
  for (let at = haystack.indexOf(text); at !== -1; at = haystack.indexOf(text, at + 1)) {
    const end = at + text.length;
    const before = [...haystack.slice(Math.max(0, at - 2), at)].at(-1);
    const after = end < haystack.length ? String.fromCodePoint(haystack.codePointAt(end)!) : '';
    if (isWordChar(first) && isWordChar(before)) continue;
    if (isWordChar(last) && isWordChar(after)) continue;
    starts.push(at);
  }
  return starts;
}

/**
 * The `[start, end)` ranges a finding matches in the narration, or none when it does not count:
 * it must occur at word boundaries and be at least three words long or cover a whole sentence
 * (quote marks aside), so a bare name or short fragment never matches.
 */
function findingRanges(layout: NarrationLayout, finding: PcControlFinding): [number, number][] {
  const text = matchText(finding.sentence);
  if (text.length === 0) return [];
  const ranges = occurrences(layout.haystack, text).map((start): [number, number] => [
    start,
    start + text.length,
  ]);
  const words = text.split(' ').filter((word) => WORD_CHAR.test(word)).length;
  if (words >= 3) return ranges;
  const coversSentence = ranges.some(([start, end]) =>
    layout.sentences.some(
      (span) => span.coreEnd > span.coreStart && start <= span.coreStart && end >= span.coreEnd
    )
  );
  return coversSentence ? ranges : [];
}

/**
 * Keeps only the findings whose sentence really appears in the narration: at word boundaries, with
 * spacing, quote, ellipsis, and dash styles ignored, and at least three words long or a whole
 * sentence.
 */
export function verifyFindings(
  narration: string,
  findings: readonly PcControlFinding[]
): PcControlFinding[] {
  const layout = layOut(narration);
  return findings.filter((finding) => findingRanges(layout, finding).length > 0);
}

/**
 * The narration without the sentences a finding's text overlaps (wherever that full text occurs),
 * so a finding spanning several sentences removes all of them, a finding that is one clause
 * removes its whole sentence, and sentences it does not touch stay. Findings are matched as in
 * `verifyFindings`, so one that would not be kept cuts nothing. The contract on whitespace: a kept
 * sentence keeps the exact whitespace that followed it in the original narration — a single space,
 * a line break, a tab, several spaces, whatever was actually there — so cutting a sentence never
 * reflows the ones around it; the last kept sentence in each paragraph is trimmed of its trailing
 * whitespace; and paragraphs (kept or not) are rejoined with "\n\n", not whatever separated them
 * originally. Returns "" when nothing remains.
 */
export function cutSentences(narration: string, findings: readonly PcControlFinding[]): string {
  const layout = layOut(narration);
  const ranges = findings.flatMap((finding) => findingRanges(layout, finding));
  const paragraphs: string[] = Array.from({ length: layout.paragraphCount }, () => '');
  for (const span of layout.sentences) {
    const cut = ranges.some(([start, end]) => start < span.end && end > span.start);
    if (!cut) paragraphs[span.paragraph] += span.sentence + span.separator;
  }
  return paragraphs
    .map((paragraph) => paragraph.trimEnd())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
}

/** Findings as one line for tool results and notes: `"sentence" (Character: reason); …`. */
export function describeFindings(findings: readonly PcControlFinding[]): string {
  return findings
    .map(
      (finding) => `"${finding.sentence}" (${finding.pc}${finding.why ? `: ${finding.why}` : ''})`
    )
    .join('; ');
}
