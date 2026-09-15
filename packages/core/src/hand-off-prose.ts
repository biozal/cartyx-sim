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
/** ",", ", and", "and", or "&" between names, whitespace-tolerant. Checked in this order so a
 * ", and" is not first cut down to a plain ",". */
const NAME_SEPARATOR = /\s*,\s*and\s+|\s*,\s*|\s*&\s*|\s+and\s+/;

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

/** The comma/"and"/"&"-separated names in a phrase, trimmed, lowercased, empties dropped. */
function splitNames(phrase: string): string[] {
  return phrase
    .split(NAME_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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
  const normalized = phrase.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const withoutLeadingThe = normalized.replace(/^the\s+/, '');
  if (PARTY_PHRASES.has(withoutLeadingThe)) return { kind: 'party' };
  if (OPEN_PHRASES.has(withoutLeadingThe)) return { kind: 'open' };
  const tokens = splitNames(normalized);
  if (tokens.length === 0) return null;
  const ids: string[] = [];
  for (const token of tokens) {
    const pc = party.find(
      (member) =>
        member.name.trim().toLowerCase() === token || firstName(member.name).toLowerCase() === token
    );
    if (!pc) return null;
    if (!ids.includes(pc.id)) ids.push(pc.id);
  }
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
