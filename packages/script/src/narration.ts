import { extractHandOffProse } from '@cartyx-sim/core';
import {
  finishLine,
  hasWords,
  isQuoteMark,
  Mask,
  pairQuotes,
  removeMarkdown,
  removeQuotes,
  sliceText,
  sourceLines,
  type Range,
} from './normalize';

export interface NarrationQuote {
  /** Numbered from 1 across the whole narration, as shown to the labeler. */
  n: number;
  block: number;
  open: number;
  /** Null for a quote left open, which runs to the end of its block. */
  close: number | null;
  /** The finished inner text. */
  text: string;
}

export type NarrationDrop = Range & { reason: 'hand_off' | 'dm_prefix' };

export interface SegmentedNarration {
  mask: Mask;
  /** Paragraphs, plus heading and list lines on their own, in order. */
  blocks: Range[];
  quotes: NarrationQuote[];
  dropped: NarrationDrop[];
  /** The cleaned narration with `[[n]]` before each numbered quote, for the labeling prompt. */
  promptText: string;
}

const DM_PREFIX = /^[ \t]*(?:\*\*|__)?DM(?:\*\*|__)?:(?:\*\*|__)?[ \t]*/;

function dropLinePrefixes(
  mask: Mask,
  party: readonly { id: string; name: string }[]
): NarrationDrop[] {
  const raw = mask.raw;
  const dropped: NarrationDrop[] = [];
  const pending = [...extractHandOffProse(raw, party).lines];
  for (const line of sourceLines(raw)) {
    const text = raw.slice(line.start, line.end);
    const trimmed = text.trim();
    const handOff = trimmed.length > 0 ? pending.indexOf(trimmed) : -1;
    if (handOff !== -1) {
      pending.splice(handOff, 1);
      const start = line.start + text.indexOf(trimmed);
      mask.remove(line.start, line.end);
      dropped.push({ start, end: start + trimmed.length, reason: 'hand_off' });
      continue;
    }
    const prefix = DM_PREFIX.exec(text);
    if (prefix) {
      const start = line.start + (prefix[0].length - prefix[0].trimStart().length);
      mask.remove(line.start, line.start + prefix[0].length);
      dropped.push({ start, end: line.start + prefix[0].trimEnd().length, reason: 'dm_prefix' });
    }
  }
  return dropped;
}

function toBlocks(mask: Mask, standalone: ReadonlySet<number>): Range[] {
  const blocks: Range[] = [];
  let current: Range | undefined;
  for (const line of sourceLines(mask.raw)) {
    if (!hasWords(mask, [line])) {
      if (current) blocks.push(current);
      current = undefined;
    } else if (standalone.has(line.start)) {
      if (current) blocks.push(current);
      current = undefined;
      blocks.push({ ...line });
    } else if (current) {
      current.end = line.end;
    } else {
      current = { ...line };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function renderPrompt(mask: Mask, blocks: readonly Range[], quotes: readonly NarrationQuote[]) {
  const numbers = new Map(quotes.map((quote) => [quote.open, quote.n]));
  return blocks
    .map((block) => {
      let text = '';
      for (let i = block.start; i < block.end; i++) {
        const n = numbers.get(i);
        if (n !== undefined) text += `[[${n}]]`;
        if (!mask.isRemoved(i) || isQuoteMark(mask.raw[i])) text += mask.raw[i];
      }
      return text.replace(/\s+/g, ' ').trim();
    })
    .join('\n\n');
}

/**
 * Cleans a DM narration and finds the quotes that may be speech: hand-off lines and `DM:`
 * prefixes are dropped, markdown is removed, the text is grouped into blocks, and quotes with
 * words are numbered. Quote marks are removed from the mask last, after the prompt is built.
 */
export function segmentNarration(
  raw: string,
  party: readonly { id: string; name: string }[]
): SegmentedNarration {
  const mask = new Mask(raw);
  const dropped = dropLinePrefixes(mask, party);
  const standalone = removeMarkdown(mask);
  const blocks = toBlocks(mask, standalone);
  const quotes: NarrationQuote[] = [];
  blocks.forEach((block, index) => {
    for (const span of pairQuotes(mask, block.start, block.end)) {
      const inner = mask.kept(span.open + 1, span.close ?? block.end);
      if (!hasWords(mask, inner)) continue;
      quotes.push({
        n: quotes.length + 1,
        block: index,
        open: span.open,
        close: span.close,
        text: finishLine(sliceText(raw, inner)),
      });
    }
  });
  const promptText = renderPrompt(mask, blocks, quotes);
  removeQuotes(mask);
  return { mask, blocks, quotes, dropped, promptText };
}

export type QuoteLabel =
  { kind: 'narration' } | { kind: 'speech'; speaker: string; dmWrotePc?: string };

export interface NarrationPiece {
  kind: 'narration' | 'dialogue';
  speaker: string;
  ranges: Range[];
  dmWrotePc?: string;
}

/**
 * The narration as lines: each quote labeled as speech becomes a dialogue line, with the text
 * before and after it as narration; quotes labeled as narration stay in the surrounding text.
 * `labels[i]` labels quote `i + 1`. Pieces with no words are skipped.
 */
export function narrationPieces(
  segmented: SegmentedNarration,
  labels: readonly QuoteLabel[]
): NarrationPiece[] {
  const { mask, blocks, quotes } = segmented;
  if (labels.length !== quotes.length) {
    throw new Error(`Expected ${quotes.length} quote label(s), got ${labels.length}.`);
  }
  const pieces: NarrationPiece[] = [];
  blocks.forEach((block, index) => {
    let cursor = block.start;
    const addNarration = (end: number) => {
      const ranges = mask.kept(cursor, end);
      if (hasWords(mask, ranges)) pieces.push({ kind: 'narration', speaker: 'dm', ranges });
    };
    for (const quote of quotes) {
      const label = labels[quote.n - 1]!;
      if (quote.block !== index || label.kind === 'narration') continue;
      addNarration(quote.open);
      const end = quote.close ?? block.end;
      pieces.push({
        kind: 'dialogue',
        speaker: label.speaker,
        ranges: mask.kept(quote.open + 1, end),
        ...(label.dmWrotePc ? { dmWrotePc: label.dmWrotePc } : {}),
      });
      cursor = quote.close === null ? block.end : quote.close + 1;
    }
    addNarration(block.end);
  });
  return pieces;
}
