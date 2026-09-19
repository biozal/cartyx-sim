export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/** "Professor Sella Vaunt" → "professor-sella-vaunt". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const OPENING_QUOTES: readonly string[] = ['"', '“'];
const CLOSING_QUOTES: readonly string[] = ['"', '”'];
const DOUBLE_QUOTE = /["“”]/;

/**
 * '"Stay close."' → 'Stay close.': trims a line and drops the double quotes wrapped around all of
 * it, as models copy them from the transcript. A line with another double quote inside keeps its
 * quotes, since they mark only part of it; a line with nothing inside its quotes becomes empty.
 */
export function unwrapQuotes(text: string): string {
  const trimmed = text.trim();
  const wrapped =
    trimmed.length >= 2 &&
    OPENING_QUOTES.includes(trimmed[0]!) &&
    CLOSING_QUOTES.includes(trimmed.at(-1)!);
  if (!wrapped) return trimmed;
  const inner = trimmed.slice(1, -1);
  return DOUBLE_QUOTE.test(inner) ? trimmed : inner.trim();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A sentence, the whitespace that followed it, and whether it survives a cut. */
export interface SentencePart {
  sentence: string;
  separator: string;
  keep: boolean;
}

interface QuoteState {
  quoted: boolean;
  /** The mark that opened the current quote, so a mark added back matches its style. */
  mark: '"' | '“';
}

function quoteStateAfter(sentence: string, before: QuoteState): QuoteState {
  let { quoted, mark } = before;
  for (const char of sentence) {
    if (char === '"') {
      if (!quoted) mark = '"';
      quoted = !quoted;
    } else if (char === '“') {
      quoted = true;
      mark = '“';
    } else if (char === '”') {
      quoted = false;
    }
  }
  return { quoted, mark };
}

/**
 * The kept sentences, each followed by its own separator (the last one's dropped), with a quote
 * mark added back wherever a cut sentence held the one that opened or closed the quote a kept
 * sentence sits in: "But he's right. That place is quiet. And the sheep…" losing its first and
 * last sentences keeps `"That place is quiet."`, not a bare line that reads as narration. An added
 * mark matches the style of the mark that opened that quote. A text whose own quote never closed
 * is not closed here. Returns '' when nothing is kept.
 */
export function joinKeptSentences(parts: readonly SentencePart[]): string {
  const out: { text: string; separator: string }[] = [];
  let original: QuoteState = { quoted: false, mark: '"' };
  let written: QuoteState = { quoted: false, mark: '"' };
  for (const { sentence, separator, keep } of parts) {
    const before = original;
    original = quoteStateAfter(sentence, before);
    if (!keep) continue;
    let text = sentence;
    if (written.quoted && !before.quoted && out.length > 0) {
      out[out.length - 1]!.text += written.mark === '“' ? '”' : '"';
    } else if (!written.quoted && before.quoted) {
      text = before.mark + text;
    }
    out.push({ text, separator });
    written = original;
  }
  if (written.quoted && !original.quoted && out.length > 0) {
    out[out.length - 1]!.text += written.mark === '“' ? '”' : '"';
  }
  return out
    .map(({ text, separator }, index) => (index < out.length - 1 ? text + separator : text))
    .join('');
}
