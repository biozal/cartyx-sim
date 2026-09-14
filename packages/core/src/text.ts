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
