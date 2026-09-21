import { describe, expect, it } from 'vitest';
import { chunkMarkdown, CHUNK_MAX_CHARS, slugify } from '../src/chunk';

const KANKA_CHARACTER = `# Elyra Moonfall

**Type:** NPC | **Title:** Student | **Status:** alive | **Age:** 18

**Tags:** Student, Class A

Raised in a traveling theater troupe. Exceptional performer, terrible at math.
`;

const ROSTER = `# Avalon Artificers Academy — NPCs (GM)

A full roster for the polished rival school north of the river, with one friendly GM thread
for each member of the faculty and every student year.

## Prof. Sella Vaunt

Prof. Sella Vaunt, 38, human, teaches applied crystal engines at Avalon Artificers Academy.
She respects competence and dislikes sentimental excuses.

## Prof. Wenda Gale

Prof. Wenda Gale, 46, dwarf, is a retired technical-dueling champion turned coach.
She runs House Duel Day like a ringmaster.
`;

describe('chunkMarkdown', () => {
  it('makes one chunk of a file whose only heading is its title', () => {
    const chunks = chunkMarkdown(
      'kanka-export/markdown/characters/2227410-2227410.md',
      KANKA_CHARACTER
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkId).toBe(
      'kanka-export/markdown/characters/2227410-2227410.md#elyra-moonfall'
    );
    expect(chunks[0]!.title).toBe('Elyra Moonfall');
    expect(chunks[0]!.headings).toEqual(['Elyra Moonfall']);
    expect(chunks[0]!.text).toContain('traveling theater troupe');
    expect(chunks[0]!.text).not.toContain('# Elyra Moonfall');
  });

  it('splits at the deepest heading and keeps the heading path', () => {
    const chunks = chunkMarkdown('dm/roster.md', ROSTER);
    expect(chunks.map((chunk) => chunk.title)).toEqual([
      'Avalon Artificers Academy — NPCs (GM)',
      'Avalon Artificers Academy — NPCs (GM) › Prof. Sella Vaunt',
      'Avalon Artificers Academy — NPCs (GM) › Prof. Wenda Gale',
    ]);
    expect(chunks[1]!.chunkId).toBe(
      'dm/roster.md#avalon-artificers-academy-npcs-gm/prof-sella-vaunt'
    );
    expect(chunks[1]!.headings).toEqual([
      'Avalon Artificers Academy — NPCs (GM)',
      'Prof. Sella Vaunt',
    ]);
    expect(chunks[1]!.text).toContain('applied crystal engines');
    expect(chunks[1]!.text).not.toContain('Wenda Gale');
  });

  it('keeps text that precedes the first subheading with the parent heading', () => {
    const chunks = chunkMarkdown('dm/roster.md', ROSTER);
    expect(chunks[0]!.text).toContain('A full roster for the polished rival school');
  });

  it('puts text before any heading into a chunk titled by the path', () => {
    const chunks = chunkMarkdown(
      'dm/loose.md',
      'Just a paragraph with no heading at all here, long enough that the chunker keeps it rather than dropping it as a stub.'
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.title).toBe('dm/loose.md');
    expect(chunks[0]!.chunkId).toBe('dm/loose.md#');
    expect(chunks[0]!.headings).toEqual([]);
  });

  it('drops a section with too little body text', () => {
    const markdown = '# Index\n\n## Cities\n\n## Towns\n';
    expect(chunkMarkdown('dm/nav.md', markdown)).toEqual([]);
  });

  it('splits an oversized section on paragraph boundaries and suffixes the parts', () => {
    const paragraph = `${'word '.repeat(300).trim()}\n\n`;
    const markdown = `# Big\n\n${paragraph.repeat(6)}`;
    const chunks = chunkMarkdown('dm/big.md', markdown);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.chunkId).toBe('dm/big.md#big~1');
    expect(chunks[1]!.chunkId).toBe('dm/big.md#big~2');
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    expect(chunks.every((chunk) => chunk.title === 'Big')).toBe(true);
  });

  it('ignores headings inside fenced code blocks', () => {
    const markdown =
      '# Real\n\nSome body text that runs comfortably past the minimum chunk length, so it is kept.\n\n```\n# Not a heading\n```\n';
    const chunks = chunkMarkdown('dm/code.md', markdown);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.title).toBe('Real');
    expect(chunks[0]!.text).toContain('# Not a heading');
  });
});

describe('slugify', () => {
  it('lowercases, strips punctuation, and joins with dashes', () => {
    expect(slugify('Prof. Sella Vaunt')).toBe('prof-sella-vaunt');
    expect(slugify('Avalon Artificers Academy — NPCs (GM)')).toBe(
      'avalon-artificers-academy-npcs-gm'
    );
  });
});
