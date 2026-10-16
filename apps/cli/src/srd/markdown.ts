/** Markdown helpers for rebuilding the SRD. The source has no fenced code blocks, so none are handled. */

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

export function headingOf(line: string): { level: number; title: string } | undefined {
  const match = HEADING.exec(line);
  return match ? { level: match[1]!.length, title: match[2]! } : undefined;
}

/** A heading and everything up to the next heading at the same or a shallower level. */
export interface Section {
  level: number;
  title: string;
  /** The heading line first, then the body, deeper headings included. */
  lines: string[];
}

/**
 * Splits at every heading of exactly `level`. Lines before the first such heading are the
 * preamble. A shallower heading after the first section throws: callers use this only inside one
 * file whose single shallower heading is its title.
 */
export function splitSections(
  markdown: string,
  level: number
): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading && heading.level === level) {
      sections.push({ level, title: heading.title, lines: [line] });
      continue;
    }
    if (heading && heading.level < level && sections.length > 0) {
      throw new Error(
        `Unexpected level-${heading.level} heading "${heading.title}" after sections`
      );
    }
    (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

export function shiftHeadings(lines: readonly string[], by: number): string[] {
  return lines.map((line) => {
    const heading = headingOf(line);
    if (!heading) return line;
    const level = heading.level + by;
    if (level < 1 || level > 6) {
      throw new Error(`Shifting "${heading.title}" by ${by} leaves the heading level range`);
    }
    return `${'#'.repeat(level)} ${heading.title}`;
  });
}

export function toText(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return `${lines.slice(start, end).join('\n')}\n`;
}
