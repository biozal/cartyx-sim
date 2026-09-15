import type { HandOffTarget } from './events';

export interface HandOffProse {
  /** The narration with every hand-off line removed (blank-line runs collapsed, trimmed). */
  text: string;
  /** The matched lines, in order, as they appeared (trimmed). Empty when none. */
  lines: string[];
  /** The target named by the last matched line, or undefined when none matched. */
  target?: HandOffTarget;
}

/** A run of the same `*` or `_` wrapping the whole line, e.g. `**...**` or `_..._`. */
const EMPHASIS = /^([*_]+)([\s\S]*)\1$/;
const DM_PREFIX = /^DM:\s*/i;
/** A whole line saying "hand off to <phrase>", with any of the accepted spellings of the verb. */
const HAND_OFF_LINE = /^(?:hand[- ]?off|handing off) to (.+?)[.!]?$/i;

const PARTY_PHRASES = new Set(['party', 'group', 'players', 'everyone', 'all of you', 'you all']);
const OPEN_PHRASES = new Set(['anyone', 'whoever wants to act', 'whoever']);

/** The trimmed line with surrounding emphasis and a leading "DM:" removed. */
function undecorate(rawLine: string): string {
  let line = rawLine.trim();
  const emphasis = EMPHASIS.exec(line);
  if (emphasis) line = emphasis[2]!.trim();
  return line.replace(DM_PREFIX, '').trim();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Whether `needle` appears in `haystack` as a whole word (both already lowercased). */
function containsWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

function targetForPhrase(
  phrase: string,
  party: readonly { id: string; name: string }[]
): HandOffTarget {
  const normalized = phrase
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '');
  if (PARTY_PHRASES.has(normalized)) return { kind: 'party' };
  if (OPEN_PHRASES.has(normalized)) return { kind: 'open' };
  const ids = party
    .filter(
      (pc) =>
        containsWholeWord(normalized, pc.name.toLowerCase()) ||
        containsWholeWord(normalized, firstName(pc.name).toLowerCase())
    )
    .map((pc) => pc.id);
  return ids.length > 0 ? { kind: 'pcs', ids } : { kind: 'party' };
}

/**
 * Finds every whole line in `text` that reads as a hand-off ("Hand off to the party.", "DM: Hand
 * off to Bram.", "**Handing off to Kira!**"), maps the last one's phrase to a `HandOffTarget`
 * (party members by name, "party"/"everyone"/… to the party, "anyone"/"whoever" to open, and
 * anything else unrecognized to the party), and returns the narration with those lines removed.
 * A narrative sentence merely containing the phrase (more text before or after it on the line)
 * does not match: only a whole line does.
 */
export function extractHandOffProse(
  text: string,
  party: readonly { id: string; name: string }[]
): HandOffProse {
  const lines: string[] = [];
  const kept: string[] = [];
  let target: HandOffTarget | undefined;
  for (const rawLine of text.split('\n')) {
    const line = undecorate(rawLine);
    const match = HAND_OFF_LINE.exec(line);
    if (match) {
      lines.push(line);
      target = targetForPhrase(match[1]!, party);
      continue;
    }
    kept.push(rawLine);
  }
  const remaining = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: remaining, lines, target };
}
