/** A half-open range `[start, end)` of character offsets into a source text. */
export interface Range {
  start: number;
  end: number;
}

/**
 * A source text with some characters marked removed. Every offset refers to the source text, so
 * the kept runs are exactly the `sources` a script line records.
 */
export class Mask {
  private readonly removed: Uint8Array;

  constructor(readonly raw: string) {
    this.removed = new Uint8Array(raw.length);
  }

  remove(start: number, end: number): void {
    const from = Math.max(0, start);
    const to = Math.min(end, this.raw.length);
    if (to > from) this.removed.fill(1, from, to);
  }

  isRemoved(index: number): boolean {
    return this.removed[index] === 1;
  }

  /** The maximal runs of kept characters in `[start, end)`. */
  kept(start: number, end: number): Range[] {
    const ranges: Range[] = [];
    let open = -1;
    for (let i = start; i < end; i++) {
      if (this.removed[i] === 1) {
        if (open !== -1) ranges.push({ start: open, end: i });
        open = -1;
      } else if (open === -1) {
        open = i;
      }
    }
    if (open !== -1) ranges.push({ start: open, end });
    return ranges;
  }

  keptText(start: number, end: number): string {
    return sliceText(this.raw, this.kept(start, end));
  }
}

/** The source text of each range, concatenated with nothing between them. */
export function sliceText(raw: string, ranges: readonly Range[]): string {
  return ranges.map((range) => raw.slice(range.start, range.end)).join('');
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ENDING = /[.!?…—–\-'’)\]]$/;

/**
 * The spoken form of a line's kept text: whitespace collapsed and trimmed, a trailing `,` `;` or
 * `:` turned into a period, and a period added when the line has no ending punctuation. Text with
 * no letters or digits becomes empty (no line). This is the only transformation between a line's
 * source slices and its `text`.
 */
export function finishLine(text: string): string {
  let line = text.replace(/\s+/g, ' ').trim();
  if (!LETTER_OR_DIGIT.test(line)) return '';
  line = line.replace(/[,;:]+$/, '.');
  if (!ENDING.test(line)) line += '.';
  return line;
}

/** Whether the kept text in `ranges` has at least one letter or digit. */
export function hasWords(mask: Mask, ranges: readonly Range[]): boolean {
  return ranges.some((range) => LETTER_OR_DIGIT.test(mask.keptText(range.start, range.end)));
}

/** Each line of `raw` as `[start, end)`, without its newline. */
export function sourceLines(raw: string): Range[] {
  const lines: Range[] = [];
  let start = 0;
  for (;;) {
    const newline = raw.indexOf('\n', start);
    const end = newline === -1 ? raw.length : newline;
    lines.push({ start, end });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

const EMPHASIS = /\*+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
const QUOTE_MARK = /["“”]/;
const HEADING = /^[ \t]*#{1,6}[ \t]+/;
/** A bullet or numbered-list marker at the start of a line. */
export const BULLET = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/;
const RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

export function isQuoteMark(char: string | undefined): boolean {
  return char !== undefined && QUOTE_MARK.test(char);
}

/** Removes markdown emphasis: every `*`, and `_` runs at the edge of a word. */
export function removeEmphasis(mask: Mask): void {
  for (const match of mask.raw.matchAll(EMPHASIS)) {
    mask.remove(match.index, match.index + match[0].length);
  }
}

/** Removes every straight or curly double quote mark in `[start, end)`. */
export function removeQuotes(mask: Mask, start = 0, end = mask.raw.length): void {
  for (let i = start; i < end; i++) {
    if (isQuoteMark(mask.raw[i])) mask.remove(i, i + 1);
  }
}

/**
 * Removes markdown from narration: horizontal rules, heading and list markers, and emphasis.
 * Returns the start offsets of heading and list-item lines, which become lines of their own.
 */
export function removeMarkdown(mask: Mask): Set<number> {
  const standalone = new Set<number>();
  for (const line of sourceLines(mask.raw)) {
    const text = mask.raw.slice(line.start, line.end);
    if (RULE.test(text)) {
      mask.remove(line.start, line.end);
      continue;
    }
    const marker = HEADING.exec(text) ?? BULLET.exec(text);
    if (marker) {
      mask.remove(line.start, line.start + marker[0].length);
      standalone.add(line.start);
    }
  }
  removeEmphasis(mask);
  return standalone;
}

/** A pair of double quote marks; `close` is null for an odd one out, open to the range end. */
export interface QuoteSpan {
  open: number;
  close: number | null;
}

/** The kept double quote marks in `[start, end)`, paired in order: first with second, and so on. */
export function pairQuotes(mask: Mask, start: number, end: number): QuoteSpan[] {
  const marks: number[] = [];
  for (let i = start; i < end; i++) {
    if (!mask.isRemoved(i) && isQuoteMark(mask.raw[i])) marks.push(i);
  }
  const spans: QuoteSpan[] = [];
  for (let i = 0; i < marks.length; i += 2) {
    spans.push({ open: marks[i]!, close: marks[i + 1] ?? null });
  }
  return spans;
}
