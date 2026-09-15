import type { HandOffTarget } from './events';

export interface HandOffProse {
  /** The narration with every hand-off line removed (blank-line runs collapsed, trimmed). */
  text: string;
  /** The matched lines, in order, as they appeared (trimmed). Empty when none. */
  lines: string[];
  /** The target named by the last matched line, or undefined when none matched. */
  target?: HandOffTarget;
}

/** A leading "DM:", optionally wrapped in one matching pair of `*`/`_` around just that token. */
const DM_PREFIX = /^(?:([*_]{1,2})DM:\1|DM:)\s*/i;
/** A whole line saying "hand off to <phrase>", with any of the accepted spellings of the verb. */
const HAND_OFF_PREFIX = /^(?:hand[- ]?off|handing off) to /i;

const PARTY_PHRASES = new Set(['party', 'group', 'players', 'everyone', 'all of you', 'you all']);
const OPEN_PHRASES = new Set(['anyone', 'whoever wants to act', 'whoever']);

/** A letter or digit, Unicode-aware, for the name-boundary rule. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/**
 * Strips a single matching pair of `*` or `_` wrapping the *whole* line, but only when no further
 * occurrence of that character sits inside — so `**Hand off to the party.**` is unwrapped while
 * `*Hand off to Kira.* The dwarf nods, *grim*`, which has more emphasis markers of its own, is
 * left alone (it is not really one emphasized whole line).
 */
function stripWholeLineEmphasis(line: string): string {
  const leading = /^([*_])\1*/.exec(line);
  if (!leading) return line;
  const marker = leading[0];
  const char = leading[1]!;
  if (line.length <= marker.length * 2 || !line.endsWith(marker)) return line;
  const inner = line.slice(marker.length, line.length - marker.length);
  return inner.includes(char) ? line : inner.trim();
}

/** The trimmed line with a leading "DM:" and whole-line emphasis removed, in either order. */
function undecorate(rawLine: string): string {
  let line = rawLine.trim();
  for (let pass = 0; pass < 2; pass++) {
    const before = line;
    line = line.replace(DM_PREFIX, '').trim();
    line = stripWholeLineEmphasis(line).trim();
    if (line === before) break;
  }
  return line;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Lowercased, with whitespace runs collapsed to one space, trimmed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface NameEntry {
  id: string;
  text: string;
}

/**
 * Full names and unambiguous first names for a party, each normalized and sorted longest-first so
 * a linear scan always tries the longest candidate at a position first. A first name shared by two
 * or more party members is left out of `firstNames` entirely: it can never resolve on its own,
 * though the members' full names still can.
 */
function nameEntries(party: readonly { id: string; name: string }[]): {
  fullNames: NameEntry[];
  firstNames: NameEntry[];
} {
  const fullNames = party
    .map((pc) => ({ id: pc.id, text: normalizeName(pc.name) }))
    .sort((a, b) => b.text.length - a.text.length);
  const firstNameCounts = new Map<string, number>();
  for (const pc of party) {
    const text = normalizeName(firstName(pc.name));
    firstNameCounts.set(text, (firstNameCounts.get(text) ?? 0) + 1);
  }
  const firstNames = party
    .map((pc) => ({ id: pc.id, text: normalizeName(firstName(pc.name)) }))
    .filter((entry) => firstNameCounts.get(entry.text) === 1)
    .sort((a, b) => b.text.length - a.text.length);
  return { fullNames, firstNames };
}

/**
 * The party member whose full or (unambiguous) first name starts exactly at `pos` in `phrase` and
 * ends at a word boundary (the end of the phrase or a non-letter/digit character), trying full
 * names before first names, and the longest candidate in each group before shorter ones.
 */
function matchNameAt(
  phrase: string,
  pos: number,
  entries: { fullNames: NameEntry[]; firstNames: NameEntry[] }
): { id: string; end: number } | null {
  for (const group of [entries.fullNames, entries.firstNames]) {
    for (const entry of group) {
      const end = pos + entry.text.length;
      if (end > phrase.length || phrase.slice(pos, end) !== entry.text) continue;
      if (isWordChar(phrase[end])) continue;
      return { id: entry.id, end };
    }
  }
  return null;
}

/**
 * The end of the separator starting at `pos` in `phrase`, or null when there is none there. Since
 * the caller has already collapsed whitespace runs to a single space, "optional" spacing here
 * means a single space is either present or absent, never more. Spacing around `,` and `&` is
 * optional; the word "and" needs exactly one space on each side of it, wherever it appears (both
 * as a separator by itself and after a comma).
 */
function matchSeparator(phrase: string, pos: number): number | null {
  let at = pos;
  const leadingSpace = phrase[at] === ' ';
  if (leadingSpace) at++;
  if (phrase[at] === ',') {
    at++;
    if (phrase[at] === ' ') at++;
    return phrase.startsWith('and ', at) ? at + 4 : at;
  }
  if (phrase[at] === '&') {
    at++;
    if (phrase[at] === ' ') at++;
    return at;
  }
  return leadingSpace && phrase.startsWith('and ', at) ? at + 4 : null;
}

/**
 * The ids named by a whole normalized phrase matching the grammar `NAME (SEP NAME)*`, in the
 * order they were named, without duplicates. Returns null when any part of the phrase does not
 * parse: an unresolved name, a leading or trailing separator, an empty part, or text left over
 * after the last name. A single left-to-right pass: each position is tried once, so this is
 * linear in the length of `phrase` (times the small, fixed cost of checking each party member).
 */
function parseNameSequence(
  phrase: string,
  party: readonly { id: string; name: string }[]
): string[] | null {
  const entries = nameEntries(party);
  const ids: string[] = [];
  let pos = 0;
  for (;;) {
    const match = matchNameAt(phrase, pos, entries);
    if (!match) return null;
    if (!ids.includes(match.id)) ids.push(match.id);
    pos = match.end;
    if (pos === phrase.length) return ids;
    const sepEnd = matchSeparator(phrase, pos);
    if (sepEnd === null || sepEnd === phrase.length) return null;
    pos = sepEnd;
  }
}

/**
 * The target named by a hand-off phrase, or null when the phrase is not entirely one recognized
 * thing: a party phrase, an open phrase, or one or more party members' full or first names joined
 * only by a separator. Any other content (extra narration, an unknown name, a clause like "when
 * the bell rings") makes the whole phrase unrecognized, so the line it came from is not a match.
 */
function resolvePhraseTarget(
  phrase: string,
  party: readonly { id: string; name: string }[]
): HandOffTarget | null {
  const normalized = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  const withoutLeadingThe = normalized.replace(/^the\s+/, '');
  if (PARTY_PHRASES.has(withoutLeadingThe)) return { kind: 'party' };
  if (OPEN_PHRASES.has(withoutLeadingThe)) return { kind: 'open' };
  const ids = parseNameSequence(normalized, party);
  if (!ids || ids.length === 0) return null;
  return { kind: 'pcs', ids };
}

/**
 * The target of a decorated hand-off line, or null when it is not one: the line must read exactly
 * "hand off to <phrase>" (optional trailing "." or "!") with nothing else, and `<phrase>` must
 * resolve per `resolvePhraseTarget`. Trailing narration, an unresolved clause, or an unknown name
 * makes the whole line not a match, so it is left as ordinary narration.
 */
function matchHandOff(
  line: string,
  party: readonly { id: string; name: string }[]
): HandOffTarget | null {
  const prefix = HAND_OFF_PREFIX.exec(line);
  if (!prefix) return null;
  let phrase = line.slice(prefix[0].length);
  if (/[.!]$/.test(phrase)) phrase = phrase.slice(0, -1);
  return resolvePhraseTarget(phrase, party);
}

/**
 * Finds every whole line in `text` that reads as a hand-off to a recognized target ("Hand off to
 * the party.", "DM: Hand off to Kira.", "**Handing off to Kira and Tomas!**"), maps the last one's
 * phrase to a `HandOffTarget`, and returns the narration with those lines removed. A narrative
 * sentence merely containing the phrase (more text before or after it on the line, or a name the
 * party does not have) does not match: only a whole line naming a recognized target does.
 */
export function extractHandOffProse(
  text: string,
  party: readonly { id: string; name: string }[]
): HandOffProse {
  const lines: string[] = [];
  const kept: string[] = [];
  let target: HandOffTarget | undefined;
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    const matched = matchHandOff(undecorate(trimmed), party);
    if (matched) {
      lines.push(trimmed);
      target = matched;
      continue;
    }
    // A whitespace-only line collapses like a blank one below; a real line keeps its formatting.
    kept.push(trimmed.length === 0 ? '' : rawLine);
  }
  const remaining = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: remaining, lines, target };
}
