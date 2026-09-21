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

/**
 * The first JSON object in a model reply that `read` accepts (returns non-null for), or null.
 * Closed `<think>` blocks are ignored first. Then each "{" is tried, in order, against each later
 * "}" from last to first, so code fences, surrounding text, stray braces, and a second object are
 * all fine, and the first (leftmost, then widest) candidate that parses and is accepted wins. A
 * start that could not possibly open JSON is skipped, and at most `MAX_PARSE_ATTEMPTS` candidates,
 * totaling at most `MAX_PARSE_CHARS` characters, are ever parsed, so a degenerate brace-heavy
 * reply returns null quickly instead of trying every pair.
 */
export function findJsonReply<T>(text: string, read: (value: unknown) => T | null): T | null {
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
      let value: unknown;
      try {
        value = JSON.parse(reply.slice(start, end + 1));
      } catch {
        continue;
      }
      const found = read(value);
      if (found !== null) return found;
    }
  }
  return null;
}
