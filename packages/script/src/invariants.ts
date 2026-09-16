import type { SimEvent } from '@cartyx-sim/core';
import { BULLET, finishLine, sourceLines } from './normalize';
import { isVoiced, type ScriptFile } from './schema';

const IGNORABLE = /[\s\p{P}\p{S}]/u;

/** The text a voiced line's sources point into, or undefined for any other event. */
function sourceText(event: SimEvent | undefined): string | undefined {
  if (event?.type === 'narration' || event?.type === 'dialogue') return event.text;
  if (event?.type === 'action') return event.intent;
  return undefined;
}

/** Offsets of list markers at line starts, which markdown removal drops without a record. */
function markerOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  for (const line of sourceLines(text)) {
    const marker = BULLET.exec(text.slice(line.start, line.end));
    for (let i = 0; marker && i < marker[0].length; i++) offsets.add(line.start + i);
  }
  return offsets;
}

/**
 * Everything wrong with a script against its log (empty when it is sound): ids must run L0001,
 * L0002, … and lines follow log order; every voiced line's text must equal `finishLine` of its
 * source slices; and every letter or digit of a public spoken event must be in some line or a
 * dropped span.
 */
export function invariantViolations(script: ScriptFile, events: readonly SimEvent[]): string[] {
  const problems: string[] = [];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const covered = new Map<number, Uint8Array>();
  const cover = (seq: number, start: number, end: number) => {
    const text = sourceText(bySeq.get(seq));
    if (text === undefined) return;
    let marks = covered.get(seq);
    if (!marks) {
      marks = new Uint8Array(text.length);
      covered.set(seq, marks);
    }
    marks.fill(1, start, end);
  };

  let lastSeq = -1;
  script.lines.forEach((line, index) => {
    const expectedId = `L${String(index + 1).padStart(4, '0')}`;
    if (line.id !== expectedId) problems.push(`${line.id}: expected id ${expectedId}`);
    const seq = line.sources[0]!.seq;
    if (seq < lastSeq) problems.push(`${line.id}: out of log order`);
    lastSeq = Math.max(lastSeq, seq);
    if (!isVoiced(line)) return;
    const pieces: string[] = [];
    for (const source of line.sources) {
      const text = sourceText(bySeq.get(source.seq));
      if (text === undefined || source.start > source.end || source.end > text.length) {
        problems.push(
          `${line.id}: source ${source.seq}:${source.start}-${source.end} is not in a spoken event`
        );
        return;
      }
      pieces.push(text.slice(source.start, source.end));
      cover(source.seq, source.start, source.end);
    }
    const expected = finishLine(pieces.join(''));
    if (expected !== line.text) {
      problems.push(
        `${line.id}: text ${JSON.stringify(line.text)} does not match its sources ` +
          JSON.stringify(expected)
      );
    }
    for (const span of line.dropped ?? []) cover(span.seq, span.start, span.end);
  });
  for (const note of script.notes) {
    for (const span of note.dropped ?? []) cover(span.seq, span.start, span.end);
  }

  for (const event of events) {
    const text = sourceText(event);
    if (event.visibility !== 'public' || text === undefined) continue;
    const marks = covered.get(event.seq);
    const markers = markerOffsets(text);
    for (let i = 0; i < text.length; i++) {
      if (marks?.[i] === 1 || markers.has(i) || IGNORABLE.test(text[i]!)) continue;
      const context = JSON.stringify(text.slice(Math.max(0, i - 10), i + 10));
      problems.push(`seq ${event.seq}: ${context} is in no line and was not dropped`);
      break;
    }
  }
  return problems;
}
