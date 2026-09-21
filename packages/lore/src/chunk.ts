/** A heading-bounded slice of one markdown file, the unit that gets embedded and retrieved. */
export interface Chunk {
  chunkId: string;
  source: string;
  title: string;
  headings: string[];
  text: string;
}

/** A section longer than this splits again on paragraph boundaries. */
export const CHUNK_MAX_CHARS = 4000;
/** A section with less body text than this is a bare heading or a nav stub, and is dropped. */
export const CHUNK_MIN_CHARS = 80;

const TITLE_SEPARATOR = ' › ';

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      // Keep letters and digits from any script; everything else becomes a separator.
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

interface Section {
  headings: string[];
  lines: string[];
}

/**
 * Splits markdown into sections at every ATX heading, tracking the heading path. A fenced code
 * block's `#` lines are body text, not headings.
 */
function toSections(markdown: string): Section[] {
  const sections: Section[] = [{ headings: [], lines: [] }];
  const path: { level: number; text: string }[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      sections.at(-1)!.lines.push(line);
      continue;
    }
    const heading = fence === undefined ? /^(#{1,6})\s+(.*\S)\s*$/.exec(line) : null;
    if (!heading) {
      sections.at(-1)!.lines.push(line);
      continue;
    }
    const level = heading[1]!.length;
    const text = heading[2]!;
    while (path.length > 0 && path.at(-1)!.level >= level) path.pop();
    path.push({ level, text });
    sections.push({ headings: path.map((entry) => entry.text), lines: [] });
  }
  return sections;
}

/** Greedily packs paragraphs into parts no longer than {@link CHUNK_MAX_CHARS}. */
function splitLong(text: string): string[] {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= CHUNK_MAX_CHARS || current === '') {
      current = candidate;
      // A single paragraph over the cap becomes its own oversized part rather than being cut
      // mid-sentence: retrieval quality matters more here than a hard byte ceiling.
      if (current.length > CHUNK_MAX_CHARS) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    parts.push(current);
    current = paragraph;
  }
  if (current !== '') parts.push(current);
  return parts;
}

export function chunkMarkdown(source: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of toSections(markdown)) {
    const text = section.lines.join('\n').trim();
    if (text.length < CHUNK_MIN_CHARS) continue;
    const title = section.headings.length === 0 ? source : section.headings.join(TITLE_SEPARATOR);
    const slugPath = section.headings.map(slugify).join('/');
    const parts = splitLong(text);
    parts.forEach((part, index) => {
      const suffix = parts.length === 1 ? '' : `~${index + 1}`;
      chunks.push({
        chunkId: `${source}#${slugPath}${suffix}`,
        source,
        title,
        headings: [...section.headings],
        text: part,
      });
    });
  }
  return chunks;
}
