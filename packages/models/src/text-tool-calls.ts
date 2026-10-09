import type { ToolCall } from '@cartyx-sim/core';

/**
 * Gemma's native string delimiter. Gemma writes a call as `name{key:<|"|>text<|"|>,n:3}`; when the
 * serving runtime does not translate that into an OpenAI `tool_calls` entry (LM Studio sometimes
 * does not), it arrives as the reply's text instead.
 */
const GEMMA_QUOTE = '<|"|>';
/** Markers some runtimes leave around a call they did not parse. */
const CALL_MARKERS = /<\|?tool_call\|?>/g;

class Cursor {
  position = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position]!)) {
      this.position++;
    }
  }

  done(): boolean {
    this.skipSpace();
    return this.position >= this.text.length;
  }

  startsWith(token: string): boolean {
    return this.text.startsWith(token, this.position);
  }

  take(token: string): boolean {
    this.skipSpace();
    if (!this.startsWith(token)) return false;
    this.position += token.length;
    return true;
  }

  expect(token: string): void {
    if (!this.take(token)) throw new SyntaxError(`expected ${token} at ${this.position}`);
  }

  identifier(): string {
    this.skipSpace();
    const match = /^[A-Za-z_][\w-]*/.exec(this.text.slice(this.position));
    if (!match) throw new SyntaxError(`expected a name at ${this.position}`);
    this.position += match[0].length;
    return match[0];
  }

  key(): string {
    this.skipSpace();
    return this.startsWith(GEMMA_QUOTE) || this.startsWith('"') ? this.string() : this.identifier();
  }

  string(): string {
    this.skipSpace();
    if (this.startsWith(GEMMA_QUOTE)) {
      const start = this.position + GEMMA_QUOTE.length;
      const end = this.text.indexOf(GEMMA_QUOTE, start);
      if (end === -1) throw new SyntaxError('unterminated string');
      this.position = end + GEMMA_QUOTE.length;
      return this.text.slice(start, end);
    }
    // A JSON string, for models that mix the two syntaxes.
    const match = /^"(?:[^"\\]|\\.)*"/.exec(this.text.slice(this.position));
    if (!match) throw new SyntaxError(`expected a string at ${this.position}`);
    this.position += match[0].length;
    return JSON.parse(match[0]) as string;
  }

  value(): unknown {
    this.skipSpace();
    if (this.startsWith(GEMMA_QUOTE) || this.startsWith('"')) return this.string();
    if (this.startsWith('{')) return this.object();
    if (this.startsWith('[')) return this.array();
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.text.slice(this.position)
    );
    if (!match) throw new SyntaxError(`expected a value at ${this.position}`);
    this.position += match[0].length;
    return JSON.parse(match[0]) as unknown;
  }

  object(): Record<string, unknown> {
    this.expect('{');
    const entries: [string, unknown][] = [];
    if (this.take('}')) return {};
    do {
      const key = this.key();
      this.expect(':');
      entries.push([key, this.value()]);
    } while (this.take(','));
    this.expect('}');
    // Entries, not assignment, so a "__proto__" key is data rather than a prototype change.
    return Object.fromEntries(entries);
  }

  array(): unknown[] {
    this.expect('[');
    const items: unknown[] = [];
    if (this.take(']')) return items;
    do items.push(this.value());
    while (this.take(','));
    this.expect(']');
    return items;
  }
}

/**
 * Recovers tool calls a model wrote as text in Gemma's native syntax, e.g.
 * `speak{emotion:<|"|>determined<|"|>,text:<|"|>We go.<|"|>}`, optionally prefixed `call:`.
 * Strict on purpose: the whole reply must be one or more such calls to tools that were offered,
 * so prose that merely mentions a tool's name is never mistaken for a call. Returns an empty
 * array when the text is anything else.
 */
export function recoverTextToolCalls(
  text: string,
  toolNames: readonly string[],
  /** Prefixes each recovered call's id; give each reply its own so ids never repeat in a beat. */
  idPrefix = 'text-call'
): ToolCall[] {
  const offered = new Set(toolNames);
  const cursor = new Cursor(text.replace(CALL_MARKERS, ' '));
  const calls: ToolCall[] = [];
  try {
    while (!cursor.done()) {
      cursor.take('call:');
      const name = cursor.identifier();
      if (!offered.has(name)) return [];
      cursor.skipSpace();
      if (!cursor.startsWith('{')) return [];
      calls.push({ id: `${idPrefix}-${calls.length}`, name, args: cursor.object() });
    }
  } catch {
    return [];
  }
  return calls;
}
