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
/**
 * A whole line that is just one of the accepted spellings of the verb, with nothing else — no
 * target phrase at all — optionally followed by one "." or "!" and nothing more.
 */
const BARE_HAND_OFF = /^(?:hand[- ]?off|handing off)[.!]?$/i;

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
 * a search always tries the longest candidate at a position first. A full name or a first name
 * shared by two or more party members is left out entirely: it can never resolve on its own, even
 * though a *different*, unique name of theirs (a unique full name when the first name collides, or
 * vice versa) still can.
 */
function nameEntries(party: readonly { id: string; name: string }[]): {
  fullNames: NameEntry[];
  firstNames: NameEntry[];
} {
  const fullNameCounts = new Map<string, number>();
  for (const pc of party) {
    const text = normalizeName(pc.name);
    fullNameCounts.set(text, (fullNameCounts.get(text) ?? 0) + 1);
  }
  const fullNames = party
    .map((pc) => ({ id: pc.id, text: normalizeName(pc.name) }))
    .filter((entry) => fullNameCounts.get(entry.text) === 1)
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
 * The possible ends of a separator starting at `pos` in `phrase`, longest/most-specific first, so
 * a backtracking search tries the greedy reading before falling back to a shorter one. Since the
 * caller has already collapsed whitespace runs to a single space, "optional" spacing here means a
 * single space is either present or absent, never more. Spacing around `,` and `&` is optional;
 * the word "and" needs exactly one space on each side of it, wherever it appears (both as a
 * separator by itself and directly after a comma) — so `Kira,and Mira` is not a `, and` separator
 * (no space before "and"), only a plain "," is offered there, and `Kira, And Roe` (a PC named "And
 * Roe") can fall back from the greedy ", and " reading to a plain "," that leaves "And Roe" whole.
 */
function separatorEnds(phrase: string, pos: number): number[] {
  let at = pos;
  const leadingSpace = phrase[at] === ' ';
  if (leadingSpace) at++;
  if (phrase[at] === ',') {
    at++;
    const spaceAfterComma = phrase[at] === ' ';
    const plain = spaceAfterComma ? at + 1 : at;
    if (spaceAfterComma && phrase.startsWith('and ', at + 1)) {
      return [at + 1 + 4, plain];
    }
    return [plain];
  }
  if (phrase[at] === '&') {
    at++;
    if (phrase[at] === ' ') at++;
    return [at];
  }
  return leadingSpace && phrase.startsWith('and ', at) ? [at + 4] : [];
}

/**
 * A hand-off phrase this long is not really a list of names (more likely a runaway reply or
 * repeated text); rejecting it outright, before the name search runs at all, keeps that search's
 * already-bounded cost from ever being spent on a pathological line.
 */
const MAX_PHRASE_LENGTH = 1000;

/**
 * The ids named by a whole normalized phrase matching the grammar `NAME (SEP NAME)*`, in the
 * order they were named, without duplicates, or null when no reading of the phrase resolves it
 * entirely: an unresolved name, a leading or trailing separator, an empty part, or text left over
 * after the last name.
 *
 * Resolved back to front, without recursion: for each position (from the end of the phrase down
 * to 0), `canParseFrom` records whether some reading of the grammar matches the rest of the phrase
 * from there, and `choice` records which candidate name (and, unless it reached the end of the
 * phrase outright, which separator reading) made that true. Candidate names are tried
 * longest-first (full names before first names) and, for each, every separator reading is tried
 * before moving to the next candidate, so the first candidate whose chosen separator's `sepEnd`
 * already resolves (per `canParseFrom`, always already known since `sepEnd > pos`) wins — the same
 * greedy-with-fallback priority a recursive backtracking search would give, but computed by a
 * single pass over positions instead of a call per name, so it cannot overflow the stack on a long
 * line. A final forward walk from position 0, following `choice`, reads off the ids. O(phrase
 * length × party size): each position tries at most a fixed number of candidates and separator
 * readings.
 */
function parseNameSequence(
  phrase: string,
  party: readonly { id: string; name: string }[]
): string[] | null {
  if (phrase.length > MAX_PHRASE_LENGTH) return null;
  const { fullNames, firstNames } = nameEntries(party);
  const candidates = [...fullNames, ...firstNames];
  const n = phrase.length;
  const canParseFrom = new Array<boolean>(n + 1).fill(false);
  const choiceEntry = new Array<NameEntry | null>(n + 1).fill(null);
  // The position right after the separator following the chosen name, or null when that name's
  // own end is the end of the phrase (nothing more to read).
  const choiceSepEnd = new Array<number | null>(n + 1).fill(null);

  for (let pos = n - 1; pos >= 0; pos--) {
    for (const entry of candidates) {
      const end = pos + entry.text.length;
      if (end > n || phrase.slice(pos, end) !== entry.text) continue;
      if (isWordChar(phrase[end])) continue;
      if (end === n) {
        canParseFrom[pos] = true;
        choiceEntry[pos] = entry;
        break;
      }
      const sepEnd = separatorEnds(phrase, end).find(
        (candidate) => candidate < n && canParseFrom[candidate]
      );
      if (sepEnd !== undefined) {
        canParseFrom[pos] = true;
        choiceEntry[pos] = entry;
        choiceSepEnd[pos] = sepEnd;
        break;
      }
    }
  }

  if (!canParseFrom[0]) return null;
  const ids: string[] = [];
  for (let pos = 0; ;) {
    const entry = choiceEntry[pos]!;
    if (!ids.includes(entry.id)) ids.push(entry.id);
    const sepEnd: number | null = choiceSepEnd[pos] ?? null;
    if (sepEnd === null) break;
    pos = sepEnd;
  }
  return ids;
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
 * The target of a decorated hand-off line, or null when it is not one. A line that is just the
 * verb on its own ("Hand off.", "Handing off!"), with no target phrase at all, always resolves to
 * the party. Otherwise the line must read exactly "hand off to <phrase>" (optional trailing "." or
 * "!") with nothing else, and `<phrase>` must resolve per `resolvePhraseTarget`. Trailing
 * narration, an unresolved clause, or an unknown name makes the whole line not a match, so it is
 * left as ordinary narration.
 */
function matchHandOff(
  line: string,
  party: readonly { id: string; name: string }[]
): HandOffTarget | null {
  if (BARE_HAND_OFF.test(line)) return { kind: 'party' };
  const prefix = HAND_OFF_PREFIX.exec(line);
  if (!prefix) return null;
  let phrase = line.slice(prefix[0].length);
  if (/[.!]$/.test(phrase)) phrase = phrase.slice(0, -1);
  return resolvePhraseTarget(phrase, party);
}

/**
 * Finds every whole line in `text` that reads as a hand-off to a recognized target ("Hand off to
 * the party.", "DM: Hand off to Kira.", "**Handing off to Kira and Tomas!**"), maps the last one's
 * phrase to a `HandOffTarget`, and returns the narration with those lines removed. A bare
 * hand-off line with no target phrase at all ("Hand off.", "Handing off!") also matches, and
 * resolves to the party. A narrative sentence merely containing the phrase (more text before or
 * after it on the line, or a name the party does not have) does not match: only a whole line
 * naming a recognized target, or a bare hand-off line, does.
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
