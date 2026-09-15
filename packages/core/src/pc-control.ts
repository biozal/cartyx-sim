import { z } from 'zod';
import type { SimEvent } from './events';
import { ownEntry, type GameState } from './state';

/** A sentence the checker says plays a player character, with the character and the reason. */
export const PcControlFinding = z.object({
  pc: z.string().min(1),
  sentence: z.string().min(1),
  why: z.string().default(''),
});
export type PcControlFinding = z.output<typeof PcControlFinding>;

const CheckerReply = z.object({ violations: z.array(PcControlFinding) });

function nameOf(id: string, state: GameState): string {
  return ownEntry(state.combatants, id)?.name ?? id;
}

/**
 * What the player characters said, declared, or passed on since the DM's most recent turn ended,
 * as lines for the checker prompt ("Kira Vale says: …", "Kira Vale attempts: …").
 */
export function declarationsSinceDm(history: readonly SimEvent[], state: GameState): string[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === 'turn_end' && event.actor === 'dm') {
      start = index + 1;
      break;
    }
  }
  const party = new Set(state.partyIds);
  const lines: string[] = [];
  for (const event of history.slice(start)) {
    if (event.type === 'dialogue' && event.speakerKind === 'pc') {
      lines.push(`${nameOf(event.speaker, state)} says: "${event.text}"`);
    } else if (event.type === 'action' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} attempts: ${event.intent}`);
    } else if (event.type === 'pass' && party.has(event.actor)) {
      lines.push(`${nameOf(event.actor, state)} holds back.`);
    }
  }
  return lines;
}

/**
 * The checker's findings, or null when its reply holds no readable `{ "violations": [...] }`
 * object. Reads from the first "{" to the last "}", so code fences and surrounding text are fine.
 */
export function parseCheckerReply(text: string): PcControlFinding[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = CheckerReply.safeParse(raw);
  return parsed.success ? parsed.data.violations : null;
}

/** Lowercased, with whitespace collapsed and curly quotes and apostrophes made straight. */
function normalize(text: string): string {
  return text
    .replace(/["“”„]/g, '"')
    .replace(/['‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalized text without the quote marks around it, for matching one piece inside another. */
function matchText(text: string): string {
  return normalize(text)
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/** Keeps only the findings whose sentence really appears in the narration. */
export function verifyFindings(
  narration: string,
  findings: readonly PcControlFinding[]
): PcControlFinding[] {
  const haystack = normalize(narration);
  return findings.filter((finding) => {
    const text = matchText(finding.sentence);
    return text.length > 0 && haystack.includes(text);
  });
}

/** Splits a paragraph after sentence-ending punctuation and any closing quotes or brackets. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?…]["“”‘’')\]]*)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The narration without every sentence that contains a finding or is contained in one, so a
 * finding spanning several sentences removes all of them and a finding that is one clause removes
 * its whole sentence. Paragraph breaks are kept; returns "" when nothing remains.
 */
export function cutSentences(narration: string, findings: readonly PcControlFinding[]): string {
  const cuts = findings
    .map((finding) => matchText(finding.sentence))
    .filter((text) => text.length > 0);
  return narration
    .split(/\n\s*\n/)
    .map((paragraph) =>
      splitSentences(paragraph)
        .filter((sentence) => {
          const text = matchText(sentence);
          return !(text.length > 0 && cuts.some((cut) => text.includes(cut) || cut.includes(text)));
        })
        .join(' ')
    )
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
}

/** Findings as one line for tool results and notes: `"sentence" (Character: reason); …`. */
export function describeFindings(findings: readonly PcControlFinding[]): string {
  return findings
    .map(
      (finding) => `"${finding.sentence}" (${finding.pc}${finding.why ? `: ${finding.why}` : ''})`
    )
    .join('; ');
}
